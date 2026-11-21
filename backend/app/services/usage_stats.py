"""LLM usage accounting behind ``GET /api/settings/usage``.

vtx already records provider-reported token usage on every assistant
message inside ``sessions.vtx_entries`` — the same data vtx's own
``/usage`` reconstructs from its session logs. We reuse that record
instead of trusting ``AgentEndEvent.total_usage`` (which many providers
gateways never populate): one ``usage_turns`` row per model call, tagged
with the turn it belongs to.
"""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config import Settings
from ..store import database

_TABLE = """
CREATE TABLE IF NOT EXISTS usage_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 1,
    duration_s REAL NOT NULL DEFAULT 0,
    ttft_s REAL NOT NULL DEFAULT 0
)
"""

_INDEX = "CREATE INDEX IF NOT EXISTS idx_usage_turns_ts ON usage_turns(ts)"

_TIMING_TABLE = """
CREATE TABLE IF NOT EXISTS usage_turn_times (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    ttft_s REAL NOT NULL DEFAULT 0,
    gen_s REAL NOT NULL DEFAULT 0,
    ts REAL NOT NULL DEFAULT 0
)
"""


def record_turn_timing(
    settings: Settings,
    *,
    turn_id: str,
    session_id: str,
    model: str,
    provider: str,
    ttft_s: float,
    gen_s: float,
) -> None:
    """Store honest stream timings for one turn. Never raises."""
    try:
        with database.connect(settings) as conn:
            conn.execute(_TIMING_TABLE)
            conn.execute(
                "INSERT OR REPLACE INTO usage_turn_times"
                " (turn_id, session_id, model, provider, ttft_s, gen_s, ts)"
                " VALUES (?,?,?,?,?,?,?)",
                (turn_id, session_id, model, provider, max(0.0, ttft_s), max(0.0, gen_s), time.time()),
            )
    except Exception:  # noqa: BLE001
        pass



def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _iso_ts(value: Any) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _entries_from(raw: Any) -> list[dict[str, Any]]:
    """``sessions.vtx_entries`` is a JSON list of JSON-encoded entry strings."""
    try:
        items = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    out: list[dict[str, Any]] = []
    for item in items or []:
        if isinstance(item, str):
            try:
                item = json.loads(item)
            except (TypeError, ValueError):
                continue
        if isinstance(item, dict):
            out.append(item)
    return out


def _call_rows(
    entries: list[dict[str, Any]],
    *,
    session_id: str,
    turn_id: str,
    since_ts: float = 0.0,
) -> list[tuple[Any, ...]]:
    """Extract one usage row per assistant message carrying provider usage.

    Timestamps on vtx entries are completion times, so per-call latency is
    approximated by the gap to the previous entry, and TTFT by the gap from
    the turn's user message to its first model call. Model/provider come
    from the most recent ``model_change`` entry.
    """
    rows: list[tuple[Any, ...]] = []
    model = provider = ""
    backfill_turn = 0
    backfill_turn_id = ""
    prev_ts = 0.0
    turn_anchor_ts = 0.0
    live_anchor_ts = 0.0
    emitted = False
    for entry in entries:
        ts = _iso_ts(entry.get("timestamp"))
        etype = entry.get("type")
        if etype == "model_change":
            model = str(entry.get("model_id") or "")
            provider = str(entry.get("provider") or "")
        elif etype == "message":
            message = entry.get("message") or {}
            role = message.get("role")
            if role == "user":
                backfill_turn += 1
                backfill_turn_id = f"{session_id}#t{backfill_turn}"
                turn_anchor_ts = ts or turn_anchor_ts
                live_anchor_ts = ts or live_anchor_ts
            usage = message.get("usage")
            if isinstance(usage, dict):
                input_tokens = _int(usage.get("input_tokens"))
                output_tokens = _int(usage.get("output_tokens"))
                cache_read = _int(usage.get("cache_read_tokens"))
                cache_write = _int(usage.get("cache_write_tokens"))
                total = input_tokens + output_tokens + cache_read + cache_write
                if total:
                    if turn_id:
                        if not ts or ts < since_ts:
                            prev_ts = ts or prev_ts
                            continue
                        row_turn = turn_id
                        anchor = live_anchor_ts
                    else:
                        row_turn = backfill_turn_id
                        anchor = turn_anchor_ts
                    if not row_turn:
                        prev_ts = ts or prev_ts
                        continue
                    duration = max(0.0, ts - prev_ts) if prev_ts else 0.0
                    ttft = max(0.0, ts - anchor) if anchor and not emitted else 0.0
                    emitted = True
                    rows.append(
                        (
                            ts or time.time(),
                            session_id,
                            row_turn,
                            model,
                            provider,
                            input_tokens,
                            output_tokens,
                            cache_read,
                            cache_write,
                            total,
                            1,
                            duration,
                            ttft,
                        )
                    )
        if ts:
            prev_ts = ts
    return rows


def _insert_rows(settings: Settings, rows: list[tuple[Any, ...]]) -> None:
    if not rows:
        return
    with database.connect(settings) as conn:
        conn.execute(_TABLE)
        conn.execute(_INDEX)
        conn.executemany(
            "INSERT INTO usage_turns (ts, session_id, turn_id, model, provider,"
            " input_tokens, output_tokens, cache_read_tokens,"
            " cache_write_tokens, total_tokens, calls, duration_s, ttft_s)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )


def record_live_turn(
    settings: Settings,
    *,
    session_id: str,
    turn_id: str,
    started_at: float,
) -> None:
    """Record the model calls a just-finished turn made, from vtx_entries."""
    try:
        with database.connect(settings) as conn:
            conn.execute(_TABLE)
            row = conn.execute(
                "SELECT vtx_entries FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        if not row or not row[0]:
            return
        entries = _entries_from(row[0])
        # Only entries stamped after the turn started belong to this turn.
        rows = _call_rows(
            entries, session_id=session_id, turn_id=turn_id, since_ts=started_at
        )
        # duration is unknown per call; leave 0 so tokens/sec stays null.
        _insert_rows(settings, rows)
    except Exception:  # noqa: BLE001 - accounting must never break a turn
        pass


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _empty_totals() -> dict[str, Any]:
    return {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_reported_calls": 0,
        "total_calls": 0,
        "total_tokens": 0,
        "duration_seconds": 0.0,
        "estimated_calls": 0,
        "cache_hit_rate": None,
        "tokens_per_second": None,
        "ttft_seconds": None,
    }


def _finish_totals(t: dict[str, Any]) -> None:
    cache_denom = t["cache_read_input_tokens"] + t["cache_input_tokens"]
    t["cache_hit_rate"] = (
        round(t["cache_read_input_tokens"] / cache_denom, 4)
        if cache_denom > 0
        else None
    )
    t["tokens_per_second"] = (
        round(t["completion_tokens"] / t["duration_seconds"], 2)
        if t["duration_seconds"] > 0 and t["completion_tokens"] > 0
        else None
    )


def usage_for_year(settings: Settings, year: int, timezone: str) -> dict[str, Any]:
    """Aggregate ``usage_turns`` into the UsageStatistics contract shape."""
    tz = _zone(timezone)
    start_utc = datetime(year - 1, 1, 1, tzinfo=ZoneInfo("UTC")).timestamp()
    end_utc = datetime(year + 2, 1, 1, tzinfo=ZoneInfo("UTC")).timestamp()

    totals = _empty_totals()
    days: dict[str, dict[str, Any]] = {}
    day_turns: dict[str, set[str]] = {}
    day_tracked: dict[str, set[str]] = {}
    models: dict[tuple[str, str], dict[str, Any]] = {}
    sessions: set[str] = set()
    turn_first_ts: dict[str, float] = {}
    turn_has_tokens: dict[str, bool] = {}
    turn_ttft: dict[str, float] = {}
    model_ttft: dict[tuple[str, str], list[float]] = {}
    latest = 0.0

    timings: dict[str, dict[str, Any]] = {}
    with database.connect(settings) as conn:
        conn.execute(_TIMING_TABLE)
        for t in conn.execute(
            "SELECT turn_id, model, provider, ttft_s, gen_s, ts FROM usage_turn_times"
        ).fetchall():
            timings[t["turn_id"]] = dict(t)
        conn.execute(_TABLE)
        rows = conn.execute(
            "SELECT id, ts, session_id, turn_id, model, provider, input_tokens,"
            " output_tokens, cache_read_tokens, cache_write_tokens,"
            " total_tokens, calls, duration_s, ttft_s FROM usage_turns"
            " WHERE ts >= ? AND ts < ?",
            (start_utc, end_utc),
        ).fetchall()

    for row in rows:
        ts = float(row["ts"] or 0)
        local = datetime.fromtimestamp(ts, tz)
        if local.year != year:
            continue
        date_key = local.date().isoformat()
        model_key = (row["model"] or "", row["provider"] or "")
        turn_key = row["turn_id"] or f"row:{row['id']}"
        row_tokens = int(row["total_tokens"] or 0)
        row_calls = int(row["calls"] or 1)

        day = days.setdefault(
            date_key,
            {
                "date": date_key,
                "total_tokens": 0,
                "total_calls": 0,
                "turns": 0,
                "tracked_turns": 0,
            },
        )
        day["total_tokens"] += row_tokens
        day["total_calls"] += row_calls
        day_turns.setdefault(date_key, set()).add(turn_key)
        if row_tokens > 0:
            day_tracked.setdefault(date_key, set()).add(turn_key)

        model_row = models.setdefault(
            model_key,
            {
                "model": model_key[0],
                "provider": model_key[1],
                **_empty_totals(),
            },
        )
        model_row["total_tokens"] += row_tokens
        model_row["prompt_tokens"] += int(row["input_tokens"] or 0)
        model_row["completion_tokens"] += int(row["output_tokens"] or 0)
        model_row["cache_read_input_tokens"] += int(row["cache_read_tokens"] or 0)
        model_row["cache_input_tokens"] += int(row["cache_write_tokens"] or 0)
        model_row["total_calls"] += row_calls
        model_row["duration_seconds"] += float(row["duration_s"] or 0)
        if row_tokens == 0:
            model_row["estimated_calls"] += row_calls

        totals["total_tokens"] += row_tokens
        totals["prompt_tokens"] += int(row["input_tokens"] or 0)
        totals["completion_tokens"] += int(row["output_tokens"] or 0)
        totals["cache_read_input_tokens"] += int(row["cache_read_tokens"] or 0)
        totals["cache_input_tokens"] += int(row["cache_write_tokens"] or 0)
        totals["total_calls"] += row_calls
        totals["duration_seconds"] += float(row["duration_s"] or 0)
        if row_tokens == 0:
            totals["estimated_calls"] += row_calls

        if row["session_id"]:
            sessions.add(row["session_id"])
        if float(row["ttft_s"] or 0) > 0:
            if turn_key not in turn_ttft:
                turn_ttft[turn_key] = float(row["ttft_s"])
            model_ttft.setdefault(model_key, []).append(float(row["ttft_s"]))
        turn_first_ts.setdefault(turn_key, ts)
        turn_has_tokens[turn_key] = turn_has_tokens.get(turn_key, False) or row_tokens > 0
        latest = max(latest, ts)

    for date_key, turn_set in day_turns.items():
        days[date_key]["turns"] = len(turn_set)
        days[date_key]["tracked_turns"] = len(day_tracked.get(date_key, set()))

    _finish_totals(totals)
    # Honest timings win; approximations only fill gaps for untimed turns.
    real_ttfts = [
        t["ttft_s"] for t in timings.values()
        if t["ttft_s"] > 0
        and datetime.fromtimestamp(t["ts"], tz).year == year
    ]
    totals["ttft_seconds"] = (
        round(sum(real_ttfts) / len(real_ttfts), 3) if real_ttfts else None
    )
    timed_out = sum(
        int(r["output_tokens"] or 0)
        for r in rows
        if (r["turn_id"] or "") in timings
    )
    timed_gen = sum(
        float(timings[r["turn_id"]]["gen_s"] or 0)
        for r in rows
        if (r["turn_id"] or "") in timings
    )
    totals["tokens_per_second"] = (
        round(timed_out / timed_gen, 2) if timed_gen > 0 and timed_out > 0 else None
    )
    # Per-model TPS/TTFT only from turns with real stream timings.
    model_timed: dict[tuple[str, str], dict[str, float]] = {}
    for r in rows:
        t = timings.get(r["turn_id"] or "")
        if not t:
            continue
        key = (t["model"] or "", t["provider"] or "")
        bucket = model_timed.setdefault(key, {"out": 0.0, "gen": 0.0, "ttft": 0.0, "n": 0.0})
        bucket["out"] += int(r["output_tokens"] or 0)
        bucket["gen"] += float(t["gen_s"] or 0)
        if float(t["ttft_s"] or 0) > 0:
            bucket["ttft"] += float(t["ttft_s"])
            bucket["n"] += 1
    for model_row in models.values():
        _finish_totals(model_row)
        key = (model_row["model"], model_row["provider"])
        timed = model_timed.get(key)
        model_row["tokens_per_second"] = (
            round(timed["out"] / timed["gen"], 2)
            if timed and timed["gen"] > 0 and timed["out"] > 0 else None
        )
        model_row["ttft_seconds"] = (
            round(timed["ttft"] / timed["n"], 3) if timed and timed["n"] else None
        )
    for t in timings.values():
        if datetime.fromtimestamp(t["ts"], tz).year != year:
            continue
        key = (t["model"] or "", t["provider"] or "")
        row = models.get(key)
        if not row:
            continue
        if t["ttft_s"] > 0:
            row.setdefault("_ttft", []).append(t["ttft_s"])
    for model_row in models.values():
        vals = model_row.pop("_ttft", None)
        if vals:
            model_row["ttft_seconds"] = round(sum(vals) / len(vals), 3)

    year_turns = {
        key: ts for key, ts in turn_first_ts.items()
        if datetime.fromtimestamp(ts, tz).year == year
    }
    return {
        "year": year,
        "timezone": tz.key,
        "totals": totals,
        "days": [days[key] for key in sorted(days)],
        "models": sorted(
            models.values(),
            key=lambda m: (-m["total_tokens"], m["model"], m["provider"]),
        ),
        "active_days": len(day_turns),
        "sessions": len(sessions),
        "turns": len(year_turns),
        "tracked_turns": sum(1 for key in year_turns if turn_has_tokens.get(key)),
        "updated_at": latest,
    }
