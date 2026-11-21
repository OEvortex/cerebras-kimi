"""
Co-Writer Document Storage
==========================

Notebook pages live in the shared SQLite database (``data/deeptutor.sqlite3``):
each page is one row in ``documents``, with the review queue, margin threads and
flashcard scheduling kept in ``doc_extras`` and binary attachments in
``doc_assets``. Legacy ``data/documents/doc_*/manifest.json`` trees are imported
once by :mod:`app.store.database`.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import logging
import re
import threading
import time
from typing import Any
import uuid

from pydantic import BaseModel, Field

from ...config import get_settings
from ...store import database
from .blocks import blocks_to_markdown, coarse_markdown_to_blocks, validate_blocks

logger = logging.getLogger(__name__)


class CoWriterDocument(BaseModel):
    """Lightweight document model for Co-Writer projects."""

    id: str
    title: str = ""
    content: str = ""
    blocks: list[dict[str, Any]] | None = None
    schema_version: int = 1
    revision: int = 0
    parent_id: str | None = None
    icon: str = ""
    cover: str = ""
    pinned: bool = False
    # Tags attached by the agent's ``notes`` tool. Kept on the
    # page itself so notebook pages written by the tool stay searchable in the
    # same place they are displayed.
    tags: list[str] = Field(default_factory=list)
    applied_suggestion_ids: list[str] = Field(default_factory=list)
    created_at: float = Field(default_factory=lambda: time.time())
    updated_at: float = Field(default_factory=lambda: time.time())


class CoWriterDocumentSummary(BaseModel):
    """Summary view (without full content) used for list endpoints."""

    id: str
    title: str
    created_at: float
    updated_at: float
    preview: str = ""
    parent_id: str | None = None
    icon: str = ""
    cover: str = ""
    pinned: bool = False
    revision: int = 0


def _derive_title(content: str, fallback: str = "Untitled draft") -> str:
    """Pick a title from the first heading line; fallback otherwise."""
    if not content:
        return fallback
    for raw in content.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            stripped = line.lstrip("#").strip()
            if stripped:
                return stripped[:120]
        return line[:120]
    return fallback


_FENCE = re.compile(r"^\s*(```|~~~)")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_TAG = re.compile(r"</?[A-Za-z][^>]*>")
_LINE_MARK = re.compile(r"^(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)+")
_EMPHASIS = re.compile(r"(\*\*|__|~~|`)")
_RULE = re.compile(r"^\s*([-*_]\s*){3,}$")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{2,}")


def _plain_lines(content: str) -> list[str]:
    """Readable text of a markdown body: what a list card shows, not its syntax."""
    lines: list[str] = []
    fenced = False
    for raw in content.splitlines():
        if _FENCE.match(raw):
            fenced = not fenced
            continue
        if fenced or _RULE.match(raw) or _TABLE_RULE.match(raw):
            continue
        line = raw.strip()
        if line.startswith("|"):
            line = " · ".join(cell.strip() for cell in line.strip("|").split("|") if cell.strip())
        line = _TAG.sub("", _LINK.sub(r"\1", _IMAGE.sub("", line))).strip()
        line = _LINE_MARK.sub("", line)
        line = _EMPHASIS.sub("", line).replace("$$", "").strip()
        if line:
            lines.append(line)
    return lines


def _build_preview(content: str, limit: int = 160, title: str = "") -> str:
    if not content:
        return ""
    lines = _plain_lines(content)
    # A page usually opens with its own title as a heading; the card shows it already.
    if lines and title and lines[0].strip().casefold() == title.strip().casefold():
        lines = lines[1:]
    cleaned = "  ".join(lines)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rstrip() + "…"


class RevisionConflict(ValueError):
    """A write was based on a revision that is no longer current."""


_STORE_LOCK = threading.RLock()

# Page snapshots: coalesce rapid saves from one continuous editing session and
# keep a bounded tail per page. Mirrors the document-version strategy of the
# standalone editor this feature was ported from.
MAX_VERSIONS_PER_DOCUMENT = 100
VERSION_COALESCE_SECONDS = 300


class VersionSummary(BaseModel):
    id: str
    doc_id: str
    revision: int
    created_at: float
    source: str
    title: str
    char_count: int = 0
    word_count: int = 0


class VersionDetail(VersionSummary):
    content: str = ""
    blocks: list[dict[str, Any]] | None = None


class CoWriterStorage:
    """SQLite-backed store for note pages and everything attached to them."""

    def __init__(self, root: Any | None = None) -> None:
        # ``root`` is accepted for backwards compatibility with tests and older
        # callers; it is ignored because pages live in the shared database.
        self._settings = get_settings()
        database.ensure_tables(self._settings)

    @staticmethod
    def _check_id(doc_id: str) -> str:
        if not re.fullmatch(r"[0-9a-f]{8,32}", doc_id or ""):
            raise ValueError("Invalid page ID")
        return doc_id

    def doc_exists(self, doc_id: str) -> bool:
        try:
            doc_id = self._check_id(doc_id)
        except ValueError:
            return False
        with database.connect(self._settings) as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM documents WHERE id = ?", (doc_id,)
                ).fetchone()
                is not None
            )

    # ── CRUD ─────────────────────────────────────────────────────────────

    def list_doc_ids(self) -> list[str]:
        with database.connect(self._settings) as connection:
            rows = connection.execute(
                "SELECT id FROM documents ORDER BY updated_at DESC"
            ).fetchall()
        return [str(row["id"]) for row in rows]

    def list_documents(self) -> list[CoWriterDocumentSummary]:
        summaries: list[CoWriterDocumentSummary] = []
        for doc_id in self.list_doc_ids():
            doc = self.load_document(doc_id)
            if doc is None:
                continue
            summaries.append(
                CoWriterDocumentSummary(
                    id=doc.id,
                    title=doc.title or _derive_title(doc.content),
                    created_at=doc.created_at,
                    updated_at=doc.updated_at,
                    preview=_build_preview(doc.content, title=doc.title),
                    parent_id=doc.parent_id,
                    icon=doc.icon,
                    cover=doc.cover,
                    pinned=doc.pinned,
                    revision=doc.revision,
                )
            )
        summaries.sort(key=lambda s: s.updated_at, reverse=True)
        return summaries

    def create_document(
        self,
        *,
        title: str | None = None,
        content: str = "",
        blocks: list[dict[str, Any]] | None = None,
        parent_id: str | None = None,
        tags: list[str] | None = None,
    ) -> CoWriterDocument:
        with self.locked():
            if parent_id and self.load_document(parent_id) is None:
                raise ValueError("Parent page does not exist")
            if blocks is not None:
                content = blocks_to_markdown(validate_blocks(blocks))
            doc_id = uuid.uuid4().hex[:12]
            # Avoid extremely unlikely collisions.
            while self.doc_exists(doc_id):
                doc_id = uuid.uuid4().hex[:12]

            now = time.time()
            resolved_title = (title or "").strip() or _derive_title(content, "Untitled draft")
            document = CoWriterDocument(
                id=doc_id,
                title=resolved_title,
                content=content,
                blocks=blocks,
                parent_id=parent_id,
                tags=[t.strip() for t in (tags or []) if t.strip()],
                created_at=now,
                updated_at=now,
            )
            self._write(document, source="create")
            return document

    def ensure_block_document(self, doc_id: str) -> CoWriterDocument | None:
        """Give a markdown-only page block IDs so edits can be proposed on it.

        The markdown projection is left untouched; the next editor save writes
        the canonical projection from whatever blocks the learner accepts.
        """
        with self.locked():
            doc = self.load_document(doc_id)
            if doc is None or doc.blocks is not None:
                return doc
            doc.blocks = coarse_markdown_to_blocks(doc.content)
            self._write(doc, source="migrate")
            return doc

    def load_document(self, doc_id: str) -> CoWriterDocument | None:
        try:
            doc_id = self._check_id(doc_id)
        except ValueError:
            return None
        with database.connect(self._settings) as connection:
            row = connection.execute(
                "SELECT payload FROM documents WHERE id = ?", (doc_id,)
            ).fetchone()
        if row is None:
            return None
        try:
            return CoWriterDocument.model_validate(json.loads(row["payload"]))
        except Exception as exc:
            logger.warning(f"Failed to validate Co-Writer document {doc_id}: {exc}")
            return None

    @contextmanager
    def locked(self):
        # Writers are serialised in-process; SQLite handles the cross-process
        # case with its own write transaction.
        with _STORE_LOCK:
            yield

    # ── Extras (review queue, threads, flashcard scheduling) ─────────────

    def load_extra(self, doc_id: str, kind: str, default: Any = None) -> Any:
        doc_id = self._check_id(doc_id)
        with database.connect(self._settings) as connection:
            row = connection.execute(
                "SELECT payload FROM doc_extras WHERE doc_id = ? AND kind = ?",
                (doc_id, kind),
            ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["payload"])
        except (TypeError, ValueError):
            return default

    def save_extra(self, doc_id: str, kind: str, payload: Any) -> None:
        doc_id = self._check_id(doc_id)
        with database.connect(self._settings) as connection:
            connection.execute(
                """
                INSERT INTO doc_extras (doc_id, kind, payload, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(doc_id, kind) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (doc_id, kind, json.dumps(payload, ensure_ascii=False), time.time()),
            )

    # ── Page versions ────────────────────────────────────────────────────

    @staticmethod
    def _version_counts(content: str) -> tuple[int, int]:
        return len(content), len(content.split())

    def _snapshot(self, document: CoWriterDocument, source: str) -> None:
        """Store a complete snapshot of ``document``, coalescing a live session.

        Called from :meth:`_write` inside its connection and lock. A snapshot is
        skipped when the page's text and title did not change, so pinning or
        moving a page does not pollute its history.
        """
        now = time.time()
        payload = json.dumps(document.model_dump(mode="json"), ensure_ascii=False, default=str)
        with database.connect(self._settings) as connection:
            row = connection.execute(
                """
                SELECT id, created_at, source, title, content, revision,
                       char_count, word_count
                FROM document_versions WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1
                """,
                (document.id,),
            ).fetchone()
            if row is not None:
                same_state = (
                    row["title"] == document.title
                    and row["content"] == document.content
                    and row["revision"] == document.revision - 1
                )
                coalesce = (
                    row["source"] == source
                    and now - float(row["created_at"]) <= VERSION_COALESCE_SECONDS
                )
                if same_state:
                    # The text is unchanged (metadata-only write): keep the tail.
                    return
                if coalesce:
                    char_count, word_count = self._version_counts(document.content)
                    connection.execute(
                        """
                        UPDATE document_versions
                        SET revision = ?, created_at = ?, title = ?, content = ?,
                            payload = ?, char_count = ?, word_count = ?
                        WHERE id = ?
                        """,
                        (
                            document.revision,
                            now,
                            document.title,
                            document.content,
                            payload,
                            char_count,
                            word_count,
                            row["id"],
                        ),
                    )
                    return
            char_count, word_count = self._version_counts(document.content)
            connection.execute(
                """
                INSERT INTO document_versions
                    (id, doc_id, revision, created_at, source, title, content,
                     payload, char_count, word_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    document.id,
                    document.revision,
                    now,
                    source,
                    document.title,
                    document.content,
                    payload,
                    char_count,
                    word_count,
                ),
            )
            connection.execute(
                """
                DELETE FROM document_versions WHERE doc_id = ? AND id NOT IN (
                    SELECT id FROM document_versions WHERE doc_id = ?
                    ORDER BY created_at DESC LIMIT ?
                )
                """,
                (document.id, document.id, MAX_VERSIONS_PER_DOCUMENT),
            )

    def list_versions(self, doc_id: str) -> list[VersionSummary]:
        doc_id = self._check_id(doc_id)
        with database.connect(self._settings) as connection:
            rows = connection.execute(
                """
                SELECT id, doc_id, revision, created_at, source, title,
                       char_count, word_count
                FROM document_versions WHERE doc_id = ? ORDER BY created_at DESC
                """,
                (doc_id,),
            ).fetchall()
        return [VersionSummary(**dict(row)) for row in rows]

    def create_version(self, doc_id: str, source: str = "manual") -> VersionSummary | None:
        """Snapshot the current page explicitly (e.g. from a "Save version" action)."""
        with self.locked():
            document = self.load_document(doc_id)
            if document is None:
                return None
            self._snapshot(document, source)
            versions = self.list_versions(doc_id)
            return versions[0] if versions else None

    def get_version(self, doc_id: str, version_id: str) -> VersionDetail | None:
        doc_id = self._check_id(doc_id)
        if not re.fullmatch(r"[0-9a-f]{8,32}", version_id or ""):
            return None
        with database.connect(self._settings) as connection:
            row = connection.execute(
                """
                SELECT id, doc_id, revision, created_at, source, title, content,
                       payload, char_count, word_count
                FROM document_versions WHERE doc_id = ? AND id = ?
                """,
                (doc_id, version_id),
            ).fetchone()
        if row is None:
            return None
        data = dict(row)
        payload = data.pop("payload", None)
        blocks = None
        if payload:
            try:
                blocks = json.loads(payload).get("blocks")
            except (TypeError, ValueError):
                blocks = None
        return VersionDetail(**data, blocks=blocks)

    def restore_version(
        self, doc_id: str, version_id: str, expected_revision: int
    ) -> CoWriterDocument | None:
        """Restore a snapshot as a *new* revision, never rolling time back."""
        with self.locked():
            version = self.get_version(doc_id, version_id)
            current = self.load_document(doc_id)
            if version is None or current is None:
                return None
            if current.revision != expected_revision:
                raise RevisionConflict("This page changed elsewhere. Reload before restoring.")
            # Keep the state being left behind available as its own version.
            self._snapshot(current, "before-restore")
            with database.connect(self._settings) as connection:
                row = connection.execute(
                    "SELECT payload FROM document_versions WHERE id = ?", (version.id,)
                ).fetchone()
            if row is None:
                return None
            try:
                snapshot = CoWriterDocument.model_validate(json.loads(row["payload"]))
            except (TypeError, ValueError):
                return None
            for key in (
                "title",
                "content",
                "blocks",
                "tags",
                "applied_suggestion_ids",
                "parent_id",
                "icon",
                "cover",
                "pinned",
            ):
                setattr(current, key, getattr(snapshot, key))
            current.revision += 1
            current.updated_at = time.time()
            self._write(current, source="restore")
            return current

    # ── Assets ───────────────────────────────────────────────────────────

    def save_asset(
        self, doc_id: str, name: str, data: bytes, content_type: str = ""
    ) -> None:
        doc_id = self._check_id(doc_id)
        with database.connect(self._settings) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO doc_assets
                    (doc_id, name, content_type, data, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (doc_id, name, content_type, data, time.time()),
            )

    def load_asset(self, doc_id: str, name: str) -> tuple[bytes, str] | None:
        doc_id = self._check_id(doc_id)
        with database.connect(self._settings) as connection:
            row = connection.execute(
                "SELECT data, content_type FROM doc_assets WHERE doc_id = ? AND name = ?",
                (doc_id, name),
            ).fetchone()
        if row is None:
            return None
        return bytes(row["data"]), str(row["content_type"] or "")


    def update_document(
        self,
        doc_id: str,
        *,
        title: str | None = None,
        content: str | None = None,
        blocks: list[dict[str, Any]] | None = None,
        expected_revision: int | None = None,
        source: str = "save",
        **metadata,
    ) -> CoWriterDocument | None:
        with self.locked():
            document = self.load_document(doc_id)
            if document is None:
                return None
            if expected_revision is not None and document.revision != expected_revision:
                raise RevisionConflict("This page changed elsewhere. Reload before saving.")
            if (
                blocks is not None or (document.blocks is not None and content is not None)
            ) and expected_revision is None:
                raise RevisionConflict("Block pages require expected_revision.")
            if document.blocks is not None and content is not None and blocks is None:
                raise RevisionConflict("Edit this page through its block editor.")
            previous_blocks = document.blocks or []
            if blocks is not None:
                validate_blocks(blocks)
                if document.blocks is None:
                    if self.load_extra(doc_id, "legacy_markdown") is None:
                        self.save_extra(doc_id, "legacy_markdown", document.content)
                document.blocks = blocks
                content = blocks_to_markdown(blocks)
            if content is not None:
                document.content = content
                if title is None and (not document.title or document.title == "Untitled draft"):
                    document.title = _derive_title(content, document.title or "Untitled draft")
            if title is not None:
                document.title = title.strip() or _derive_title(document.content)
            if "parent_id" in metadata:
                parent = metadata["parent_id"] or None
                cursor, seen = parent, {doc_id}
                while cursor:
                    if cursor in seen:
                        raise ValueError("Pages cannot contain themselves")
                    seen.add(cursor)
                    ancestor = self.load_document(cursor)
                    if ancestor is None:
                        raise ValueError("Parent page does not exist")
                    cursor = ancestor.parent_id
                document.parent_id = parent
            for key in ("icon", "cover", "pinned"):
                if key in metadata:
                    setattr(document, key, metadata[key])
            document.revision += 1
            document.updated_at = time.time()
            self._write(document, source=source)
            if blocks is not None:
                from .proposals import refresh_review_anchors

                refresh_review_anchors(self, doc_id, blocks, previous_blocks)
            return document

    def delete_document(self, doc_id: str) -> bool:
        with self.locked():
            document = self.load_document(doc_id)
            if document is None:
                return False
            # Preserve children by promoting them to the deleted page's parent.
            for summary in self.list_documents():
                if summary.parent_id == doc_id:
                    child = self.load_document(summary.id)
                    if child is None:
                        continue
                    child.parent_id = document.parent_id
                    child.revision += 1
                    self._write(child, source="move")
            with database.connect(self._settings) as connection:
                connection.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
                connection.execute("DELETE FROM doc_extras WHERE doc_id = ?", (doc_id,))
                connection.execute("DELETE FROM doc_assets WHERE doc_id = ?", (doc_id,))
                connection.execute("DELETE FROM document_versions WHERE doc_id = ?", (doc_id,))
            return True

    # ── Internal ─────────────────────────────────────────────────────────

    def _write(self, document: CoWriterDocument, source: str = "edit") -> None:
        with database.connect(self._settings) as connection:
            connection.execute(
                """
                INSERT INTO documents (id, payload, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (
                    document.id,
                    json.dumps(
                        document.model_dump(mode="json"), ensure_ascii=False, default=str
                    ),
                    float(document.created_at or 0),
                    float(document.updated_at or 0),
                ),
            )
        # A saved page always leaves a restorable trail. Coalescing inside
        # _snapshot keeps a fast typist from filling the list with one row per
        # debounced save.
        self._snapshot(document, source)


_storages: dict[str, CoWriterStorage] = {}


def get_co_writer_storage() -> CoWriterStorage:
    key = str(get_settings().data_dir.resolve())
    store = _storages.get(key)
    if store is None:
        store = _storages[key] = CoWriterStorage()
    return store


__all__ = [
    "CoWriterDocument",
    "CoWriterDocumentSummary",
    "CoWriterStorage",
    "get_co_writer_storage",
]
