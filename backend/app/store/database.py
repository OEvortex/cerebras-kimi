"""The one SQLite database for DeepTutor.

Everything persistent that is not an uploaded binary lives in
``data/deeptutor.sqlite3`` in WAL mode: sessions, settings, workspace state,
notebook pages and their review queues, knowledge-base text, the calendar, cron
jobs and the small agent state files (memory, learning, mastery, question bank).

Only two things deliberately stay on disk:

* the cache directories written by third-party libraries, and
* user-selected workspace folders (they are content, not app state).

Legacy JSON/SQLite stores are imported once on first open; see
:func:`migrate_legacy`.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Generator

from ..config import Settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ext_items (
    collection TEXT NOT NULL,
    item_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_ext_collection ON ext_items(collection);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);

CREATE TABLE IF NOT EXISTS doc_extras (
    doc_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, kind)
);

CREATE TABLE IF NOT EXISTS doc_assets (
    doc_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL,
    created_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, name)
);

CREATE TABLE IF NOT EXISTS kb_meta (
    name TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kb_docs (
    kb TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kb, name)
);

CREATE TABLE IF NOT EXISTS kb_chunks (
    kb TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    doc TEXT NOT NULL,
    text TEXT NOT NULL,
    tokens TEXT NOT NULL DEFAULT '[]',
    seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kb, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb, seq);

CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO state VALUES (1, 0);

CREATE TABLE IF NOT EXISTS calendars (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL REFERENCES calendars(id),
    series_id TEXT,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_id);
CREATE INDEX IF NOT EXISTS events_series ON events(series_id);

CREATE TABLE IF NOT EXISTS undo (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    next_run_at_ms INTEGER,
    payload TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_owner ON cron_jobs(owner_key);
"""

_INIT_LOCK_KEY = "migration/schema-v1"
_INIT_LOCK = threading.Lock()
_TABLES_READY: set[Path] = set()
_MIGRATED: set[Path] = set()


def database_path(settings: Settings) -> Path:
    return settings.sessions_db


@contextlib.contextmanager
def connect(settings: Settings) -> Generator[sqlite3.Connection]:
    """Open the shared database with WAL and sane concurrency defaults."""
    path = database_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30, isolation_level=None)
    try:
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError:
            pass
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA foreign_keys=ON")
        yield connection
    finally:
        connection.close()


def ensure_tables(settings: Settings) -> None:
    """Create the schema if this process has not opened the database yet."""
    path = database_path(settings)
    if path in _TABLES_READY and path.exists():
        return
    with _INIT_LOCK:
        if path in _TABLES_READY and path.exists():
            return
        with connect(settings) as connection:
            connection.executescript(SCHEMA)
        _TABLES_READY.add(path)


def ensure_schema(settings: Settings) -> None:
    """Create tables and import any pre-SQLite stores once."""
    ensure_tables(settings)
    path = database_path(settings)
    if path in _MIGRATED:
        return
    with _INIT_LOCK:
        if path in _MIGRATED:
            return
        with connect(settings) as connection:
            marker = connection.execute(
                "SELECT 1 FROM kv WHERE key = ?", (_INIT_LOCK_KEY,)
            ).fetchone()
        if marker is None:
            migrate_legacy(settings)
            put_state(settings, _INIT_LOCK_KEY, {"version": 1, "at": time.time()})
        _MIGRATED.add(path)


# ---------------------------------------------------------------------------
# Key/value state (settings, workspaces, small agent state files)
# ---------------------------------------------------------------------------


def get_state(settings: Settings, key: str, default: Any = None) -> Any:
    ensure_tables(settings)
    with connect(settings) as connection:
        row = connection.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return default


def put_state(settings: Settings, key: str, value: Any) -> None:
    ensure_tables(settings)
    with connect(settings) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                """
                INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, json.dumps(value, ensure_ascii=False, default=str), time.time()),
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise


def delete_state(settings: Settings, key: str) -> None:
    ensure_tables(settings)
    with connect(settings) as connection:
        connection.execute("DELETE FROM kv WHERE key = ?", (key,))


# ---------------------------------------------------------------------------
# Generic extended-surface items (memory docs, notebooks, partners, ...)
# ---------------------------------------------------------------------------


def list_items(settings: Settings, collection: str) -> list[dict[str, Any]]:
    ensure_tables(settings)
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT payload FROM ext_items WHERE collection = ? ORDER BY updated_at DESC",
            (collection,),
        ).fetchall()
    out = []
    for row in rows:
        try:
            item = json.loads(row["payload"])
        except (TypeError, ValueError):
            continue
        if isinstance(item, dict):
            out.append(item)
    return out


def get_item(settings: Settings, collection: str, item_id: str) -> dict[str, Any] | None:
    ensure_tables(settings)
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT payload FROM ext_items WHERE collection = ? AND item_id = ?",
            (collection, str(item_id)),
        ).fetchone()
    if row is None:
        return None
    try:
        item = json.loads(row["payload"])
    except (TypeError, ValueError):
        return None
    return item if isinstance(item, dict) else None


def put_item(settings: Settings, collection: str, item: dict[str, Any]) -> None:
    item_id = str(item.get("id") or "")
    if not item_id:
        raise ValueError("An extended-surface item needs an id")
    now = time.time()
    created = float(item.get("created_at") or now)
    ensure_tables(settings)
    with connect(settings) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                """
                INSERT INTO ext_items (collection, item_id, payload, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(collection, item_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (
                    collection,
                    item_id,
                    json.dumps(item, ensure_ascii=False, default=str),
                    created,
                    now,
                ),
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise


def delete_item(settings: Settings, collection: str, item_id: str) -> bool:
    ensure_tables(settings)
    with connect(settings) as connection:
        cursor = connection.execute(
            "DELETE FROM ext_items WHERE collection = ? AND item_id = ?",
            (collection, str(item_id)),
        )
        return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# One-shot import of the old JSON stores
# ---------------------------------------------------------------------------


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _import_kv(settings: Settings, key: str, path: Path) -> None:
    if get_state(settings, key) is not None:
        return
    if path.exists():
        data = _read_json(path)
        if data is not None:
            put_state(settings, key, data)


def _import_documents(settings: Settings, root: Path) -> None:
    if not root.is_dir():
        return
    with connect(settings) as connection:
        for child in sorted(root.glob("doc_*")):
            manifest = child / "manifest.json"
            payload = _read_json(manifest)
            if not isinstance(payload, dict) or not payload.get("id"):
                continue
            doc_id = str(payload["id"])
            exists = connection.execute(
                "SELECT 1 FROM documents WHERE id = ?", (doc_id,)
            ).fetchone()
            if exists:
                continue
            connection.execute(
                "INSERT INTO documents (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (
                    doc_id,
                    json.dumps(payload, ensure_ascii=False, default=str),
                    float(payload.get("created_at") or 0),
                    float(payload.get("updated_at") or 0),
                ),
            )
            for name, kind in (
                ("suggestions.json", "suggestions"),
                ("threads.json", "threads"),
                ("review.json", "review"),
            ):
                extra = _read_json(child / name)
                if extra is not None:
                    connection.execute(
                        """
                        INSERT OR REPLACE INTO doc_extras (doc_id, kind, payload, updated_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (doc_id, kind, json.dumps(extra, ensure_ascii=False), time.time()),
                    )


def _import_ext(settings: Settings, root: Path) -> None:
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*.json")):
        data = _read_json(path)
        if not isinstance(data, dict):
            continue
        relative = path.relative_to(root)
        collection = "/".join(relative.parts[:-1]) or "misc"
        item_id = str(data.get("id") or path.stem)
        data.setdefault("id", item_id)
        if get_item(settings, collection, item_id) is None:
            put_item(settings, collection, data)


def _import_calendar(settings: Settings, path: Path) -> None:
    if not path.exists():
        return
    source = None
    try:
        source = sqlite3.connect(path)
        source.row_factory = sqlite3.Row
        calendars = source.execute("SELECT id, payload FROM calendars").fetchall()
        events = source.execute(
            "SELECT id, calendar_id, series_id, payload FROM events"
        ).fetchall()
        revision = source.execute("SELECT revision FROM state WHERE id = 1").fetchone()
        undo = source.execute(
            "SELECT token, created_at, before_json, after_json FROM undo"
        ).fetchall()
    except sqlite3.Error:
        return
    finally:
        if source is not None:
            source.close()
    with connect(settings) as connection:
        if connection.execute("SELECT 1 FROM calendars LIMIT 1").fetchone():
            return
        connection.execute("BEGIN IMMEDIATE")
        try:
            for row in calendars:
                connection.execute(
                    "INSERT OR REPLACE INTO calendars (id, payload) VALUES (?, ?)",
                    (row["id"], row["payload"]),
                )
            for row in events:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO events
                        (id, calendar_id, series_id, payload)
                    VALUES (?, ?, ?, ?)
                    """,
                    (row["id"], row["calendar_id"], row["series_id"], row["payload"]),
                )
            for row in undo:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO undo
                        (token, created_at, before_json, after_json)
                    VALUES (?, ?, ?, ?)
                    """,
                    (row["token"], row["created_at"], row["before_json"], row["after_json"]),
                )
            if revision is not None:
                connection.execute(
                    "UPDATE state SET revision = ? WHERE id = 1",
                    (int(revision["revision"]),),
                )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise


def _import_cron(settings: Settings, path: Path, legacy_json: Path) -> None:
    with connect(settings) as connection:
        if connection.execute("SELECT 1 FROM cron_jobs LIMIT 1").fetchone():
            return
    rows: list[tuple[Any, ...]] = []
    revision = 0
    if path.exists():
        try:
            source = sqlite3.connect(path)
            source.row_factory = sqlite3.Row
            rows = [
                (
                    row["id"],
                    row["owner_key"],
                    row["next_run_at_ms"],
                    row["payload"],
                    row["updated_at_ms"],
                )
                for row in source.execute(
                    "SELECT id, owner_key, next_run_at_ms, payload, updated_at_ms FROM cron_jobs"
                )
            ]
            meta = source.execute(
                "SELECT revision FROM cron_meta WHERE singleton = 1"
            ).fetchone()
            revision = int(meta["revision"]) if meta else 0
            source.close()
        except sqlite3.Error:
            rows = []
    elif legacy_json.exists():
        raw = _read_json(legacy_json, {})
        jobs = raw.get("jobs", []) if isinstance(raw, dict) else []
        for job in jobs if isinstance(jobs, list) else []:
            if not isinstance(job, dict) or not job.get("id"):
                continue
            owner = job.get("owner") or {}
            owner_key = (
                f"partner:{owner.get('partner_id') or ''}"
                if owner.get("kind") == "partner"
                else f"chat:{owner.get('user_id') or 'local-admin'}"
            )
            state = job.get("state") or {}
            rows.append(
                (
                    str(job["id"]),
                    owner_key,
                    state.get("next_run_at_ms"),
                    json.dumps(job, ensure_ascii=False),
                    int(time.time() * 1000),
                )
            )
    if not rows:
        return
    with connect(settings) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.executemany(
                """
                INSERT OR REPLACE INTO cron_jobs
                    (id, owner_key, next_run_at_ms, payload, updated_at_ms)
                VALUES (?, ?, ?, ?, ?)
                """,
                rows,
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS cron_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    revision INTEGER NOT NULL
                )
                """
            )
            connection.execute(
                """
                INSERT INTO cron_meta (singleton, revision) VALUES (1, ?)
                ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision
                """,
                (max(revision, 1),),
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise


def _import_kbs(settings: Settings, root: Path) -> None:
    if not root.is_dir():
        return
    with connect(settings) as connection:
        if connection.execute("SELECT 1 FROM kb_meta LIMIT 1").fetchone():
            return
    for kb_dir in sorted(root.iterdir()):
        if not kb_dir.is_dir():
            continue
        name = kb_dir.name
        meta = _read_json(kb_dir / "meta.json", {}) or {}
        index = _read_json(kb_dir / "index.json", {}) or {}
        with connect(settings) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "INSERT OR REPLACE INTO kb_meta (name, payload, updated_at) VALUES (?, ?, ?)",
                    (name, json.dumps(meta, ensure_ascii=False), time.time()),
                )
                docs = kb_dir / "docs"
                if docs.is_dir():
                    for doc in sorted(docs.iterdir()):
                        if not doc.is_file() or doc.name.startswith("."):
                            continue
                        data = doc.read_bytes()
                        connection.execute(
                            """
                            INSERT OR REPLACE INTO kb_docs (kb, name, data, size)
                            VALUES (?, ?, ?, ?)
                            """,
                            (name, doc.name, data, len(data)),
                        )
                for position, chunk in enumerate(index.get("chunks") or []):
                    if not isinstance(chunk, dict):
                        continue
                    connection.execute(
                        """
                        INSERT OR REPLACE INTO kb_chunks
                            (kb, chunk_id, doc, text, tokens, seq)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            name,
                            str(chunk.get("id") or f"chunk-{position}"),
                            str(chunk.get("doc") or ""),
                            str(chunk.get("text") or ""),
                            json.dumps(chunk.get("tokens") or []),
                            position,
                        ),
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise


def migrate_legacy(settings: Settings) -> None:
    """Import every pre-SQLite store once, then leave the old files untouched."""
    data = settings.data_dir
    for key, path in (
        ("settings/catalog", data / "settings-catalog.json"),
        ("settings/selection", data / "settings.json"),
        ("settings/draft", data / "settings-draft.json"),
        ("workspaces", data / "workspaces.json"),
        ("memory", data / "memory.json"),
        ("learning", data / "learning.json"),
        ("mastery", data / "mastery.json"),
        ("question_bank", data / "question_bank.json"),
        ("reviews", data / "reviews.json"),
        ("cron/reports", data / "cron" / "reports.json"),
        ("notes/index", data / "notes" / ".notebook-index.json"),
        ("documents/history", data / "documents" / "history.json"),
    ):
        _import_kv(settings, key, path)
    _import_documents(settings, data / "documents")
    _import_ext(settings, data / "ext")
    if (data / "calendar" / "calendar.sqlite").exists():
        _import_calendar(settings, data / "calendar" / "calendar.sqlite")
    _import_cron(
        settings,
        data / "cron" / "jobs.sqlite3",
        data / "cron" / "jobs.json",
    )
    _import_kbs(settings, data / "kbs")


__all__ = [
    "SCHEMA",
    "connect",
    "database_path",
    "delete_item",
    "delete_state",
    "ensure_schema",
    "get_item",
    "get_state",
    "list_items",
    "migrate_legacy",
    "put_item",
    "put_state",
]
