"""Session persistence for the vtx-powered backend.

Sessions live in one WAL-mode SQLite database (``data/deeptutor.sqlite3``):

* ``sessions`` — record-level fields (title, status, preferences, the vtx
  header/entries).
* ``messages`` / ``turns`` — the UI-facing rows: chat messages with their
  streamed events, and per-turn event logs used for WS replay after reconnects.
* ``vtx_items`` — the raw input-item dicts the vtx ``Session`` protocol
  consumes via ``VtxSessionAdapter``.
* ``session_fts`` — an FTS5 index over message text used by the REST search
  endpoint.
* ``session_embeddings`` — cached message vectors for optional semantic search.

Legacy ``data/sessions/*.json`` records are imported on first open and moved to
``data/sessions-legacy/``; the files are not read after that.
"""

from __future__ import annotations

import contextlib
import copy
import json
import re
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, List

from ..config import Settings
from . import database


# Sentinel for ``append_user_message``: the wire may omit ``parent_message_id``
# entirely, which means "continue from the latest persisted row" rather than
# the explicit root edit signalled by ``null``.
AUTO_PARENT_MESSAGE = object()

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_INIT_LOCK = threading.Lock()
_INITIALIZED: set[Path] = set()


def _now() -> float:
    return time.time()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _loads(raw: Any, default: Any) -> Any:
    if raw is None or raw == "":
        return default
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


EMPTY_SESSION: dict[str, Any] = {
    "id": "",
    "title": "",
    "created_at": 0.0,
    "updated_at": 0.0,
    "status": "idle",
    "preferences": {},
    "messages": [],
    "turns": {},
    "vtx_items": [],
    "next_message_id": 1,
    "last_input": None,
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    preferences TEXT NOT NULL DEFAULT '{}',
    next_message_id INTEGER NOT NULL DEFAULT 1,
    last_input TEXT,
    title_auto INTEGER NOT NULL DEFAULT 0,
    last_output TEXT NOT NULL DEFAULT '',
    page_id TEXT NOT NULL DEFAULT '',
    vtx_header TEXT,
    vtx_entries TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_page ON sessions(page_id);

CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    capability TEXT,
    events TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL DEFAULT 0,
    parent_message_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running',
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL DEFAULT 0,
    finished_at REAL,
    PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

CREATE TABLE IF NOT EXISTS vtx_items (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_vtx_items_session ON vtx_items(session_id, seq);

CREATE TABLE IF NOT EXISTS session_embeddings (
    model TEXT NOT NULL,
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    vec TEXT NOT NULL,
    PRIMARY KEY (model, session_id)
);
"""

_FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    session_id UNINDEXED,
    message_id UNINDEXED,
    role UNINDEXED,
    title,
    content,
    tokenize = 'porter unicode61'
);
"""


class SessionStore:
    """SQLite-backed session index shared by the API, runtime and agent tools."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._settings.data_dir.mkdir(parents=True, exist_ok=True)
        self._db_path = settings.sessions_db
        self._fts = True
        self._last_total = 0
        # Tools construct a store per call (session search, calendar layers).
        # Schema creation and the one-shot JSON import only need to run once
        # per database per process.
        if self._db_path in _INITIALIZED and self._db_path.exists():
            return
        with _INIT_LOCK, self._boot_lock():
            # The data directory can be removed while the server is running
            # (reset, container remount, user cleanup); a missing database is
            # rebuilt on the next store access.
            if self._db_path not in _INITIALIZED or not self._db_path.exists():
                self._initialize()
                self._migrate_legacy_json()
                _INITIALIZED.add(self._db_path)

    # -- connection / schema ----------------------------------------------

    @contextlib.contextmanager
    def _connect(self) -> Any:
        with database.connect(self._settings) as connection:
            yield connection

    def _initialize(self) -> None:
        # The database module owns the shared schema and the one-shot import of
        # pre-SQLite stores; session tables are added on top of it.
        database.ensure_schema(self._settings)
        with self._connect() as connection:
            # executescript manages its own transaction; the schema is
            # idempotent, so a retry after a crash is always safe.
            connection.executescript(_SCHEMA)
            self._migrate_messages_table(connection)
            try:
                connection.executescript(_FTS_SCHEMA)
            except sqlite3.OperationalError:
                # Some Python builds omit FTS5. Search degrades to LIKE.
                self._fts = False

    @staticmethod
    def _migrate_messages_table(connection: sqlite3.Connection) -> None:
        """Drop the old unique (session_id, id) constraint.

        Legacy transcripts can contain duplicate message ids (they are repaired
        on read), so storage must accept them rather than reject the save.
        """
        row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
        ).fetchone()
        if row is None or "PRIMARY KEY" not in str(row["sql"] or ""):
            return
        connection.execute("BEGIN IMMEDIATE")
        try:
            # The old index keeps its name across the rename, which would make
            # CREATE INDEX below a no-op and leave the new table unindexed.
            for statement in (
                "DROP TABLE IF EXISTS messages_old",
                "DROP INDEX IF EXISTS idx_messages_session",
                "ALTER TABLE messages RENAME TO messages_old",
                """
                CREATE TABLE messages (
                    session_id TEXT NOT NULL,
                    id INTEGER NOT NULL,
                    role TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    capability TEXT,
                    events TEXT NOT NULL DEFAULT '[]',
                    attachments TEXT NOT NULL DEFAULT '[]',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL DEFAULT 0,
                    parent_message_id INTEGER
                )
                """,
                "INSERT INTO messages SELECT * FROM messages_old",
                "DROP TABLE messages_old",
                "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)",
            ):
                connection.execute(statement)
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise

    @contextlib.contextmanager
    def _boot_lock(self):
        lock_path = self._db_path.with_name(f".{self._db_path.name}.boot.lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+b") as handle:
            handle.seek(0, 2)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if sys.platform == "win32":  # pragma: no cover - platform specific
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if sys.platform == "win32":  # pragma: no cover
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _migrate_legacy_json(self) -> None:
        root = self._settings.sessions_dir
        files = sorted(root.glob("*.json"))
        if not files:
            return
        archive = self._settings.data_dir / "sessions-legacy"
        archive.mkdir(parents=True, exist_ok=True)
        for path in files:
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(record, dict) or not record.get("id"):
                continue
            session_id = str(record["id"])
            with self._connect() as connection:
                exists = connection.execute(
                    "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
            if not exists:
                try:
                    # ``_write`` (not ``save``) keeps the original updated_at,
                    # so imported history keeps its place in the sidebar.
                    self._write(record)
                except Exception:  # noqa: BLE001 - a bad row must not block boot
                    continue
            try:
                path.replace(archive / path.name)
            except OSError:
                pass

    # -- row encoding ------------------------------------------------------

    @staticmethod
    def _encode_message(message: dict[str, Any]) -> tuple[Any, ...]:
        return (
            str(message.get("session_id") or ""),
            int(message.get("id") or 0),
            str(message.get("role") or ""),
            str(message.get("content") or ""),
            message.get("capability"),
            _dumps(message.get("events") or []),
            _dumps(message.get("attachments") or []),
            _dumps(message.get("metadata") or {}),
            float(message.get("created_at") or 0),
            message.get("parent_message_id"),
        )

    @staticmethod
    def _decode_message(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "role": row["role"],
            "content": row["content"],
            "capability": row["capability"],
            "events": _loads(row["events"], []),
            "attachments": _loads(row["attachments"], []),
            "metadata": _loads(row["metadata"], {}),
            "created_at": row["created_at"],
            "parent_message_id": row["parent_message_id"],
        }

    @staticmethod
    def _page_id(session: dict[str, Any]) -> str:
        preferences = session.get("preferences")
        if not isinstance(preferences, dict):
            return ""
        return str(preferences.get("note_document_id") or "")

    def _write_rows(self, connection: sqlite3.Connection, session: dict[str, Any]) -> None:
        session_id = str(session["id"])
        connection.execute(
            """
            INSERT INTO sessions (
                id, title, created_at, updated_at, status, preferences,
                next_message_id, last_input, title_auto, last_output, page_id,
                vtx_header, vtx_entries
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                status = excluded.status,
                preferences = excluded.preferences,
                next_message_id = excluded.next_message_id,
                last_input = excluded.last_input,
                title_auto = excluded.title_auto,
                last_output = excluded.last_output,
                page_id = excluded.page_id,
                vtx_header = excluded.vtx_header,
                vtx_entries = excluded.vtx_entries
            """,
            (
                session_id,
                str(session.get("title") or ""),
                float(session.get("created_at") or 0),
                float(session.get("updated_at") or 0),
                str(session.get("status") or "idle"),
                _dumps(session.get("preferences") or {}),
                int(session.get("next_message_id") or 1),
                None if session.get("last_input") is None else _dumps(session["last_input"]),
                1 if session.get("title_auto") else 0,
                str(session.get("last_output") or ""),
                self._page_id(session),
                None
                if session.get("vtx_header") is None
                else _dumps(session["vtx_header"]),
                _dumps(session.get("vtx_entries") or []),
            ),
        )

        for table in ("messages", "turns", "vtx_items"):
            connection.execute(f"DELETE FROM {table} WHERE session_id = ?", (session_id,))
        if self._fts:
            connection.execute("DELETE FROM session_fts WHERE session_id = ?", (session_id,))

        title = str(session.get("title") or "")
        messages = [m for m in session.get("messages") or [] if isinstance(m, dict)]
        for message in messages:
            # The record owns its rows; a stale ``session_id`` left on a dict
            # copied between records must never orphan the row.
            message["session_id"] = session_id
            connection.execute(
                """
                INSERT INTO messages (
                    session_id, id, role, content, capability, events,
                    attachments, metadata, created_at, parent_message_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                self._encode_message(message),
            )
            if (
                self._fts
                and message.get("role") in {"user", "assistant"}
                and str(message.get("content") or "").strip()
            ):
                connection.execute(
                    """
                    INSERT INTO session_fts (session_id, message_id, role, title, content)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        int(message.get("id") or 0),
                        str(message.get("role") or ""),
                        title,
                        str(message.get("content") or ""),
                    ),
                )

        turns = session.get("turns") or {}
        if isinstance(turns, dict):
            for turn_id, turn in turns.items():
                if not isinstance(turn, dict):
                    continue
                connection.execute(
                    """
                    INSERT INTO turns (
                        session_id, turn_id, events, status, last_seq,
                        created_at, finished_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        str(turn_id),
                        _dumps(turn.get("events") or []),
                        str(turn.get("status") or "running"),
                        int(turn.get("last_seq") or 0),
                        float(turn.get("created_at") or 0),
                        turn.get("finished_at"),
                    ),
                )

        for seq, item in enumerate(session.get("vtx_items") or []):
            connection.execute(
                "INSERT INTO vtx_items (session_id, seq, item) VALUES (?, ?, ?)",
                (session_id, seq, _dumps(item)),
            )

    # -- CRUD -------------------------------------------------------------

    def create(self, preferences: dict[str, Any] | None = None) -> dict[str, Any]:
        session = copy.deepcopy(EMPTY_SESSION)
        session["id"] = _new_id("sess")
        session["created_at"] = session["updated_at"] = _now()
        session["preferences"] = dict(preferences or {})
        self._write(session)
        return session

    def get(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM sessions WHERE id = ?", (str(session_id),)
            ).fetchone()
            if row is None:
                return None
            messages = [
                self._decode_message(item)
                for item in connection.execute(
                    "SELECT * FROM messages WHERE session_id = ? ORDER BY rowid",
                    (str(session_id),),
                )
            ]
            turns = {
                str(turn["turn_id"]): {
                    "events": _loads(turn["events"], []),
                    "status": turn["status"],
                    "last_seq": turn["last_seq"],
                    "created_at": turn["created_at"],
                    "finished_at": turn["finished_at"],
                }
                for turn in connection.execute(
                    "SELECT * FROM turns WHERE session_id = ?", (str(session_id),)
                )
            }
            vtx_items = [
                _loads(item["item"], {})
                for item in connection.execute(
                    "SELECT item FROM vtx_items WHERE session_id = ? ORDER BY seq",
                    (str(session_id),),
                )
            ]
        session = {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "status": row["status"],
            "preferences": _loads(row["preferences"], {}),
            "messages": messages,
            "turns": turns,
            "vtx_items": vtx_items,
            "next_message_id": row["next_message_id"],
            "last_input": _loads(row["last_input"], None),
            "title_auto": bool(row["title_auto"]),
            "last_output": row["last_output"],
            "vtx_header": _loads(row["vtx_header"], None),
            "vtx_entries": _loads(row["vtx_entries"], []),
        }
        self._repair_legacy_message_tree(session)
        return session

    @staticmethod
    def _resolve_parent_message_id(
        session: dict[str, Any], parent_message_id: Any
    ) -> int | None:
        messages = session.get("messages") or []
        latest_id = messages[-1].get("id") if messages else None
        if parent_message_id is AUTO_PARENT_MESSAGE:
            return latest_id
        if parent_message_id is None:
            return None
        if (
            isinstance(parent_message_id, int)
            and not isinstance(parent_message_id, bool)
            and parent_message_id > 0
            and any(m.get("id") == parent_message_id for m in messages)
        ):
            return parent_message_id
        return latest_id

    def _repair_legacy_message_tree(self, session: dict[str, Any]) -> bool:
        """Rebuild parent links for sessions written before branching existed.

        Legacy rows all carry ``parent_message_id: null``, which the web client
        interprets as competing root branches and collapses to a single visible
        message. A leading run of null-parent rows is therefore a flat
        transcript: chain it in storage order. Later null rows are left alone —
        they can be legitimate root siblings created by editing the first
        message.
        """
        messages = session.get("messages")
        if not isinstance(messages, list) or len(messages) < 2:
            return False
        if not all(isinstance(message, dict) for message in messages):
            return False

        changed = False
        old_ids = [message.get("id") for message in messages]
        id_values = [value for value in old_ids if isinstance(value, int) and not isinstance(value, bool)]
        needs_reid = (
            len(id_values) != len(old_ids)
            or len(set(id_values)) != len(id_values)
            or any(value <= 0 for value in id_values)
        )
        if needs_reid:
            old_to_latest: dict[Any, int] = {}
            for index, old_id in enumerate(old_ids):
                if old_id is not None:
                    old_to_latest[old_id] = index + 1
            for index, message in enumerate(messages):
                message["id"] = index + 1
            for index, message in enumerate(messages):
                parent = message.get("parent_message_id")
                if parent is None:
                    continue
                new_parent = None
                for candidate in range(index - 1, -1, -1):
                    if old_ids[candidate] == parent:
                        new_parent = candidate + 1
                        break
                message["parent_message_id"] = new_parent
            preferences = session.get("preferences")
            selections = preferences.get("selected_branches") if isinstance(preferences, dict) else None
            if isinstance(preferences, dict) and isinstance(selections, dict):
                remapped: dict[str, int] = {}
                for parent_key, child_id in selections.items():
                    if parent_key == "null":
                        new_parent_key = "null"
                    else:
                        try:
                            new_parent_key = str(old_to_latest.get(int(parent_key), parent_key))
                        except (TypeError, ValueError):
                            continue
                    new_child = old_to_latest.get(child_id)
                    if new_child is not None:
                        remapped[new_parent_key] = new_child
                preferences["selected_branches"] = remapped
            session["next_message_id"] = len(messages) + 1
            changed = True
        else:
            max_id = max(id_values)
            if int(session.get("next_message_id") or 0) <= max_id:
                session["next_message_id"] = max_id + 1
                changed = True

        first_linked = next(
            (
                index
                for index, message in enumerate(messages)
                if message.get("parent_message_id") is not None
            ),
            len(messages),
        )
        legacy_run = first_linked if first_linked < len(messages) else len(messages)
        if legacy_run < 2:
            return changed

        # Assistant rows always continue a user turn, so a null-parent
        # assistant is unambiguous legacy-flat evidence. A prefix containing
        # only user rows may instead be deliberate root-edit siblings; only
        # collapse it when the entire session is flat.
        has_flat_assistant = any(
            messages[index].get("role") == "assistant"
            and messages[index].get("parent_message_id") is None
            for index in range(legacy_run)
        )
        if not has_flat_assistant and first_linked != len(messages):
            return changed

        for index in range(1, legacy_run):
            expected_parent = messages[index - 1].get("id")
            if messages[index].get("parent_message_id") != expected_parent:
                messages[index]["parent_message_id"] = expected_parent
                changed = True
        return changed

    def save(self, session: dict[str, Any]) -> None:
        session["updated_at"] = _now()
        self._write(session)

    def _write(self, session: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                self._write_rows(connection, session)
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def delete(self, session_id: str) -> bool:
        session_id = str(session_id)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                exists = connection.execute(
                    "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
                if exists is None:
                    connection.execute("ROLLBACK")
                    return False
                for table in ("messages", "turns", "vtx_items", "session_embeddings"):
                    connection.execute(
                        f"DELETE FROM {table} WHERE session_id = ?", (session_id,)
                    )
                connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
                if self._fts:
                    connection.execute(
                        "DELETE FROM session_fts WHERE session_id = ?", (session_id,)
                    )
                connection.execute("COMMIT")
                return True
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def all(self) -> List[dict[str, Any]]:
        """Every stored session, newest first."""
        with self._connect() as connection:
            ids = [
                str(row["id"])
                for row in connection.execute(
                    "SELECT id FROM sessions ORDER BY updated_at DESC"
                )
            ]
        return [session for session in (self.get(session_id) for session_id in ids) if session]

    def list(self, limit: int = 50, offset: int = 0) -> List[dict[str, Any]]:
        with self._connect() as connection:
            ids = [
                str(row["id"])
                for row in connection.execute(
                    "SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                    (int(limit), int(offset)),
                )
            ]
        return [session for session in (self.get(session_id) for session_id in ids) if session]

    # -- search ------------------------------------------------------------

    @staticmethod
    def _query_terms(query: str) -> List[str]:
        operators = {"and", "or", "not", "near"}
        return [
            token
            for token in _WORD.findall(query or "")
            if token.lower() not in operators
        ][:24]

    @classmethod
    def _fts_query(cls, query: str) -> str:
        """Quote user words into an FTS5 prefix query.

        Bare words would let FTS5 operators (OR, NOT, NEAR) or syntax
        characters in a learner's question raise ``OperationalError``; quoting
        every token keeps the query literal.
        """
        return " OR ".join(f'"{token}"*' for token in cls._query_terms(query))

    def search_hits(
        self,
        query: str,
        *,
        limit: int = 5,
        page_id: str = "",
    ) -> List[dict[str, Any]]:
        """Ranked message hits grouped by session (best hit per session).

        Uses the FTS5 index when available and falls back to a token LIKE scan.
        """
        needle = (query or "").strip()
        self._last_total = 0
        if not needle:
            return []
        limit = max(1, min(int(limit or 5), 500))
        raw: list[dict[str, Any]] = []
        with self._connect() as connection:
            if self._fts:
                match = self._fts_query(needle)
                if match:
                    try:
                        rows = connection.execute(
                            """
                            SELECT session_fts.session_id AS session_id,
                                   session_fts.message_id AS message_id,
                                   session_fts.role AS role,
                                   session_fts.content AS content,
                                   sessions.title AS title,
                                   sessions.updated_at AS updated_at,
                                   sessions.page_id AS page_id,
                                   bm25(session_fts) AS rank
                            FROM session_fts
                            JOIN sessions ON sessions.id = session_fts.session_id
                            WHERE session_fts MATCH ?
                              AND (? = '' OR sessions.page_id = ?)
                            ORDER BY rank
                            LIMIT ?
                            """,
                            (match, page_id, page_id, max(limit * 8, 40)),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        rows = []
                    for row in rows:
                        raw.append(
                            {
                                "session_id": row["session_id"],
                                "message_id": row["message_id"],
                                "role": row["role"],
                                "content": row["content"],
                                "title": row["title"],
                                "updated_at": row["updated_at"],
                                "page_id": row["page_id"],
                                "rank": float(row["rank"]),
                            }
                        )
            if not raw:
                # No FTS5 in this Python build (or the index is empty): fall
                # back to a token LIKE scan with the same OR semantics.
                terms = self._query_terms(needle) or [needle]
                clauses = " OR ".join("m.content LIKE ?" for _ in terms)
                rows = connection.execute(
                    f"""
                    SELECT m.session_id AS session_id, m.id AS message_id,
                           m.role AS role, m.content AS content,
                           s.title AS title, s.updated_at AS updated_at,
                           s.page_id AS page_id
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE ({clauses})
                      AND (? = '' OR s.page_id = ?)
                    ORDER BY s.updated_at DESC, m.id
                    LIMIT ?
                    """,
                    (
                        *(f"%{term}%" for term in terms),
                        page_id,
                        page_id,
                        max(limit * 8, 40),
                    ),
                ).fetchall()
                for position, row in enumerate(rows):
                    raw.append(
                        {
                            "session_id": row["session_id"],
                            "message_id": row["message_id"],
                            "role": row["role"],
                            "content": row["content"],
                            "title": row["title"],
                            "updated_at": row["updated_at"],
                            "page_id": row["page_id"],
                            "rank": float(position),
                        }
                    )
            # Title-only matches keep the old search behaviour (a session can be
            # found before its first message exists).
            title_terms = self._query_terms(needle) or [needle]
            title_clauses = " OR ".join("title LIKE ?" for _ in title_terms)
            title_rows = connection.execute(
                f"""
                SELECT id AS session_id, title, updated_at, page_id
                FROM sessions
                WHERE ({title_clauses}) AND (? = '' OR page_id = ?)
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (
                    *(f"%{term}%" for term in title_terms),
                    page_id,
                    page_id,
                    limit,
                ),
            ).fetchall()
            total = self._count_matches(connection, needle, page_id)

        seen: set[str] = set()
        results: list[dict[str, Any]] = []
        for hit in raw:
            if hit["session_id"] in seen:
                continue
            seen.add(hit["session_id"])
            results.append(self._enrich_hit(hit, needle))
            if len(results) >= limit:
                break
        for row in title_rows:
            if len(results) >= limit:
                break
            if row["session_id"] in seen:
                continue
            seen.add(row["session_id"])
            results.append(
                {
                    "session_id": row["session_id"],
                    "title": row["title"] or "Untitled conversation",
                    "updated_at": float(row["updated_at"] or 0),
                    "page_id": row["page_id"] or "",
                    "score": 0.1,
                    "question": "",
                    "answer": "",
                    "excerpt": "",
                    "message_id": 0,
                    "role": "",
                }
            )
        self._last_total = total
        return results

    def last_total(self) -> int:
        """Match count for the most recent :meth:`search_hits` call."""
        return self._last_total

    def _count_matches(
        self, connection: sqlite3.Connection, needle: str, page_id: str
    ) -> int:
        ids: set[str] = set()
        if self._fts:
            match = self._fts_query(needle)
            if match:
                try:
                    rows = connection.execute(
                        """
                        SELECT DISTINCT session_fts.session_id AS session_id
                        FROM session_fts
                        JOIN sessions ON sessions.id = session_fts.session_id
                        WHERE session_fts MATCH ?
                          AND (? = '' OR sessions.page_id = ?)
                        """,
                        (match, page_id, page_id),
                    ).fetchall()
                    ids.update(str(row["session_id"]) for row in rows)
                except sqlite3.OperationalError:
                    pass
        if not ids:
            terms = self._query_terms(needle) or [needle]
            clauses = " OR ".join("m.content LIKE ?" for _ in terms)
            rows = connection.execute(
                f"""
                SELECT DISTINCT m.session_id AS session_id
                FROM messages m
                JOIN sessions s ON s.id = m.session_id
                WHERE ({clauses}) AND (? = '' OR s.page_id = ?)
                """,
                (*(f"%{term}%" for term in terms), page_id, page_id),
            ).fetchall()
            ids.update(str(row["session_id"]) for row in rows)
        title_terms = self._query_terms(needle) or [needle]
        title_clauses = " OR ".join("title LIKE ?" for _ in title_terms)
        rows = connection.execute(
            f"""
            SELECT id AS session_id FROM sessions
            WHERE ({title_clauses}) AND (? = '' OR page_id = ?)
            """,
            (*(f"%{term}%" for term in title_terms), page_id, page_id),
        ).fetchall()
        ids.update(str(row["session_id"]) for row in rows)
        return len(ids)

    def _enrich_hit(self, hit: dict[str, Any], needle: str) -> dict[str, Any]:
        session = self.get(hit["session_id"]) or {}
        messages = [
            message
            for message in session.get("messages") or []
            if message.get("role") in {"user", "assistant"}
        ]
        index = next(
            (
                position
                for position, message in enumerate(messages)
                if message.get("id") == hit["message_id"]
            ),
            -1,
        )
        question = answer = ""
        if index >= 0:
            message = messages[index]
            if message.get("role") == "user":
                question = str(message.get("content") or "")
                if index + 1 < len(messages) and messages[index + 1].get("role") == "assistant":
                    answer = str(messages[index + 1].get("content") or "")
            else:
                answer = str(message.get("content") or "")
                if index > 0 and messages[index - 1].get("role") == "user":
                    question = str(messages[index - 1].get("content") or "")
        excerpt = self._snippet(
            (question + "\n" + answer).strip() or str(hit.get("content") or ""),
            needle,
        )
        return {
            "session_id": hit["session_id"],
            "title": hit["title"] or "Untitled conversation",
            "updated_at": float(hit["updated_at"] or session.get("updated_at") or 0),
            "page_id": hit["page_id"] or "",
            "score": round(-hit.get("rank", 0.0), 4),
            "question": self._snippet(question, needle) if question else "",
            "answer": self._snippet(answer, needle, width=900) if answer else "",
            "excerpt": excerpt,
            "message_id": hit["message_id"],
            "role": hit["role"],
        }

    @staticmethod
    def _snippet(text: str, query: str, width: int = 260) -> str:
        lowered = text.lower()
        index = lowered.find((query or "").lower())
        if index < 0:
            for token in _WORD.findall(query or ""):
                index = lowered.find(token.lower())
                if index >= 0:
                    break
        start = max(0, index - width // 3) if index >= 0 else 0
        return text[start : start + width].replace("\n", " ").strip()

    def search(self, query: str, limit: int = 50, offset: int = 0) -> tuple[List[dict[str, Any]], int]:
        """Sessions matching ``query`` plus the total match count."""
        q = (query or "").strip()
        if not q:
            return [], 0
        hits = self.search_hits(q, limit=offset + limit)
        total = self.last_total()
        page = hits[offset : offset + limit]
        sessions: list[dict[str, Any]] = []
        for hit in page:
            session = self.get(hit["session_id"])
            if session is None:
                continue
            session["_match_excerpt"] = hit.get("excerpt", "")
            sessions.append(session)
        return sessions, total

    # -- turn / message helpers -------------------------------------------

    def append_user_message(
        self,
        session: dict[str, Any],
        content: str,
        *,
        attachments: List[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
        parent_message_id: Any = AUTO_PARENT_MESSAGE,
    ) -> dict[str, Any]:
        message = {
            "id": session["next_message_id"],
            "session_id": session["id"],
            "role": "user",
            "content": content,
            "capability": None,
            "events": [],
            "attachments": list(attachments or []),
            "metadata": dict(metadata or {}),
            "created_at": _now(),
            "parent_message_id": self._resolve_parent_message_id(
                session, parent_message_id
            ),
        }
        session["next_message_id"] += 1
        session["messages"].append(message)
        if not session.get("title"):
            session["title"] = _derive_title(content)
            # Marks the placeholder so the runtime can replace it with a
            # generated title once the first turn completes.
            session["title_auto"] = True
        return message

    def append_assistant_message(
        self,
        session: dict[str, Any],
        content: str,
        *,
        events: List[dict[str, Any]],
        turn_id: str,
        capability: str | None = None,
        metadata: dict[str, Any] | None = None,
        parent_message_id: Any = AUTO_PARENT_MESSAGE,
    ) -> dict[str, Any]:
        message = {
            "id": session["next_message_id"],
            "session_id": session["id"],
            "role": "assistant",
            "content": content,
            "capability": capability,
            "events": events,
            "attachments": [],
            "metadata": {"turn_id": turn_id, **(metadata or {})},
            "created_at": _now(),
            "parent_message_id": self._resolve_parent_message_id(
                session, parent_message_id
            ),
        }
        session["next_message_id"] += 1
        session["messages"].append(message)
        return message

    def record_turn_event(
        self, session: dict[str, Any], turn_id: str, event: dict[str, Any]
    ) -> None:
        turn = session["turns"].setdefault(
            turn_id,
            {"events": [], "status": "running", "last_seq": 0, "created_at": _now()},
        )
        turn["events"].append(event)
        turn["last_seq"] = event.get("seq", turn["last_seq"])

    def finish_turn(
        self, session: dict[str, Any], turn_id: str, status: str
    ) -> None:
        turn = session["turns"].get(turn_id)
        if turn is not None:
            turn["status"] = status
            turn["finished_at"] = _now()
        session["status"] = "idle" if status == "completed" else status

    # -- embedding cache (optional semantic search) -------------------------

    def load_embeddings(self) -> dict[str, dict[str, Any]]:
        """Cached message embeddings keyed ``"<model>:<session_id>"``."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT model, session_id, hash, vec FROM session_embeddings"
            ).fetchall()
        cache: dict[str, dict[str, Any]] = {}
        for row in rows:
            vector = _loads(row["vec"], [])
            if isinstance(vector, list) and vector:
                cache[f"{row['model']}:{row['session_id']}"] = {
                    "hash": row["hash"],
                    "vec": vector,
                }
        return cache

    def save_embeddings(self, entries: dict[str, dict[str, Any]]) -> None:
        rows = []
        for key, entry in entries.items():
            model, _, session_id = key.partition(":")
            vector = entry.get("vec")
            if not (model and session_id and isinstance(vector, list) and vector):
                continue
            rows.append((model, session_id, str(entry.get("hash") or ""), _dumps(vector)))
        if not rows:
            return
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.executemany(
                    """
                    INSERT INTO session_embeddings (model, session_id, hash, vec)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(model, session_id) DO UPDATE SET
                        hash = excluded.hash,
                        vec = excluded.vec
                    """,
                    rows,
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def turn_events(self, turn_id: str, after_seq: int = 0) -> List[dict[str, Any]]:
        """Persisted event log for a finished turn (WS replay after restart)."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT events FROM turns WHERE turn_id = ?", (str(turn_id),)
            ).fetchall()
        for row in rows:
            events = [
                event
                for event in _loads(row["events"], [])
                if isinstance(event, dict) and (event.get("seq") or 0) > after_seq
            ]
            if events:
                return events
        return []


def _derive_title(content: str) -> str:
    text = " ".join(content.split())
    return text[:60] + ("…" if len(text) > 60 else "")


class VtxSessionAdapter:
    """vtx ``Session`` protocol over a session document's ``vtx_items``.

    The runner calls these methods around every turn; each mutation is
    persisted immediately so a crash mid-turn never loses committed history.
    """

    def __init__(self, store: SessionStore, session: dict[str, Any]) -> None:
        self._store = store
        self._session = session
        self.session_id = session["id"]

    async def get_items(self, limit: int | None = None) -> list[dict[str, Any]]:
        items = self._session.get("vtx_items", [])
        if limit is not None:
            items = items[-limit:]
        return [dict(item) for item in items]

    async def add_items(self, items: list[dict[str, Any]]) -> None:
        self._session.setdefault("vtx_items", []).extend(dict(i) for i in items)
        self._store.save(self._session)

    async def pop_item(self) -> dict[str, Any] | None:
        items = self._session.get("vtx_items", [])
        if not items:
            return None
        item = items.pop()
        self._store.save(self._session)
        return item

    async def clear_session(self) -> None:
        self._session["vtx_items"] = []
        self._store.save(self._session)
