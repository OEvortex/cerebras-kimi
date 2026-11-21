"""Per-turn LLM usage accounting behind ``GET /api/settings/usage``.

One row per completed agent turn in ``usage_turns``. Turns are bucketed by
the *client's* timezone at read time, so a single table serves every
``?timezone=`` query without duplicating data.
"""

from __future__ import annotations

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
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 1,
    duration_s REAL NOT NULL DEFAULT 0
)
"""

_INDEX = "CREATE INDEX IF NOT EXISTS idx_usage_turns_ts ON usage_turns(ts)"


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def record_turn(
    settings: Settings,
    *,
    session_id: str,
    model: str,
    provider: str,
    usage: Any,
    started_at: float,
    finished_at: float | None = None,
) -> None:
    """Persist one turn's cumulative provider usage. Never raises."""
    try:
        def field(name: str) -> int:
            if usage is None:
                return 0
            value = getattr(usage, name, 0)
            if callable(value):  # Usage.total_tokens is a property-like method on some SDKs
                try:
                    value = value()
                except TypeError:
                    pass
            return _int(value)

        total = field("total_tokens")
        if total == 0:
            total = (
                field("input_tokens")
                + field("output_tokens")
                + field("cache_read_tokens")
                + field("cache_write_tokens")
            )
        with database.connect(settings) as conn:
            conn.execute(_TABLE)
            conn.execute(_INDEX)
            conn.execute(
                "INSERT INTO usage_turns (ts, session_id, model, provider,"
                " input_tokens, output_tokens, cache_read_tokens,"
                " cache_write_tokens, total_tokens, calls, duration_s)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    finished_at or time.time(),
                    session_id or "",
                    model or "",
                    provider or "",
                    field("input_tokens"),
                    field("output_tokens"),
                    field("cache_read_tokens"),
                    field("cache_write_tokens"),
                    total,
                    1,
                    max(0.0, (finished_at or time.time()) - started_at),
                ),
            )
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
    # Wide UTC window; exact year filtering happens after tz conversion.
    start_utc = datetime(year - 1, 1, 1, tzinfo=ZoneInfo("UTC")).timestamp()
    end_utc = datetime(year + 2, 1, 1, tzinfo=ZoneInfo("UTC")).timestamp()

    totals = _empty_totals()
    days: dict[str, dict[str, Any]] = {}
    models: dict[tuple[str, str], dict[str, Any]] = {}
    sessions: set[str] = set()
    turns = 0
    tracked = 0
    active_days: set[str] = set()
    latest = 0.0

    with database.connect(settings) as conn:
        conn.execute(_TABLE)
        rows = conn.execute(
            "SELECT ts, session_id, model, provider, input_tokens,"
            " output_tokens, cache_read_tokens, cache_write_tokens,"
            " total_tokens, calls, duration_s FROM usage_turns"
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

        def bump(bucket: dict[str, Any]) -> None:
            bucket["total_tokens"] += int(row["total_tokens"] or 0)
            bucket["prompt_tokens"] = bucket.get("prompt_tokens", 0) + int(row["input_tokens"] or 0)
            bucket["completion_tokens"] = bucket.get("completion_tokens", 0) + int(row["output_tokens"] or 0)
            bucket["cache_read_input_tokens"] = bucket.get("cache_read_input_tokens", 0) + int(row["cache_read_tokens"] or 0)
            bucket["cache_write_tokens"] = bucket.get("cache_write_tokens", 0) + int(row["cache_write_tokens"] or 0)
            bucket["total_calls"] += int(row["calls"] or 1)
            bucket["duration_seconds"] = bucket.get("duration_seconds", 0.0) + float(row["duration_s"] or 0)

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
        row_tokens = int(row["total_tokens"] or 0)
        row_calls = int(row["calls"] or 1)
        day["total_tokens"] += row_tokens
        day["total_calls"] += row_calls
        day["turns"] += 1
        if int(row["total_tokens"] or 0) > 0:
            day["tracked_turns"] += 1

        model_row = models.setdefault(
            model_key,
            {
                "model": model_key[0],
                "provider": model_key[1],
                **_empty_totals(),
            },
        )
        bump(model_row)
        if int(row["total_tokens"] or 0) == 0:
            model_row["estimated_calls"] += int(row["calls"] or 1)
            totals["estimated_calls"] += int(row["calls"] or 1)

        totals["total_tokens"] += int(row["total_tokens"] or 0)
        totals["prompt_tokens"] += int(row["input_tokens"] or 0)
        totals["completion_tokens"] += int(row["output_tokens"] or 0)
        totals["cache_read_input_tokens"] += int(row["cache_read_tokens"] or 0)
        totals["cache_input_tokens"] += int(row["cache_write_tokens"] or 0)
        totals["total_calls"] += int(row["calls"] or 1)
        totals["duration_seconds"] += float(row["duration_s"] or 0)

        if row["session_id"]:
            sessions.add(row["session_id"])
        turns += 1
        if int(row["total_tokens"] or 0) > 0:
            tracked += 1
        active_days.add(date_key)
        latest = max(latest, ts)

    _finish_totals(totals)
    for model_row in models.values():
        _finish_totals(model_row)

    return {
        "year": year,
        "timezone": tz.key,
        "totals": totals,
        "days": [days[key] for key in sorted(days)],
        "models": sorted(
            models.values(),
            key=lambda m: (-m["total_tokens"], m["model"], m["provider"]),
        ),
        "active_days": len(active_days),
        "sessions": len(sessions),
        "turns": turns,
        "tracked_turns": tracked,
        "updated_at": latest,
    }
