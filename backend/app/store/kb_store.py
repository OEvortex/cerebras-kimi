"""Knowledge-base store: uploaded documents + a chunk index in SQLite.

Layout in the shared database (``data/deeptutor.sqlite3``)::

    kb_meta    (name, payload)            {name, created_at, last_updated}
    kb_docs    (kb, name, data, size)     original uploads (txt/md/pdf/docx)
    kb_chunks  (kb, chunk_id, doc, text)  parsed text, one row per chunk

Retrieval is dependency-free BM25-style keyword scoring — good enough for
tutor citations without an embedding service. Legacy ``data/kbs/<name>/``
directories are imported once by :mod:`app.store.database`.
"""

from __future__ import annotations

import io
import json
import math
import re
import time
from typing import Any, List

from ..config import Settings
from ..store import database

_CHUNK_SIZE = 1200
_CHUNK_OVERLAP = 150


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9]+", text.lower())


def _extract_text(name: str, data: bytes) -> str:
    suffix = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix == "pdf":
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            return "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception:
            return ""
    if suffix == "docx":
        try:
            import docx

            document = docx.Document(io.BytesIO(data))
            return "\n".join(paragraph.text for paragraph in document.paragraphs)
        except Exception:
            return ""
    return data.decode("utf-8", errors="replace")


def _chunk(text: str) -> list[str]:
    words = text.split()
    chunks, i = [], 0
    while i < len(words):
        chunk = " ".join(words[i : i + _CHUNK_SIZE])
        if chunk.strip():
            chunks.append(chunk)
        i += _CHUNK_SIZE - _CHUNK_OVERLAP
    return chunks or ([text] if text.strip() else [])


def _safe_name(name: str) -> str:
    return "".join(c for c in name if c.isalnum() or c in "-_ ").strip()


class KnowledgeBaseStore:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        database.ensure_tables(settings)

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _meta_payload(raw: Any) -> dict[str, Any]:
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _meta(self, name: str) -> dict[str, Any] | None:
        with database.connect(self._settings) as connection:
            row = connection.execute(
                "SELECT payload FROM kb_meta WHERE name = ?", (name,)
            ).fetchone()
        return None if row is None else self._meta_payload(row["payload"])

    def _save_meta(self, name: str, payload: dict[str, Any]) -> None:
        with database.connect(self._settings) as connection:
            connection.execute(
                """
                INSERT INTO kb_meta (name, payload, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (name, json.dumps(payload, ensure_ascii=False), time.time()),
            )

    # -- CRUD ---------------------------------------------------------------

    def list(self) -> List[dict[str, Any]]:
        with database.connect(self._settings) as connection:
            rows = connection.execute(
                "SELECT name, payload FROM kb_meta ORDER BY name"
            ).fetchall()
            counts = {
                row["kb"]: row["count"]
                for row in connection.execute(
                    "SELECT kb, COUNT(*) AS count FROM kb_chunks GROUP BY kb"
                )
            }
            doc_counts = {
                row["kb"]: row["count"]
                for row in connection.execute(
                    "SELECT kb, COUNT(*) AS count FROM kb_docs GROUP BY kb"
                )
            }
        out = []
        for row in rows:
            meta = self._meta_payload(row["payload"])
            chunks = int(counts.get(row["name"], 0))
            out.append(
                {
                    "name": meta.get("name", row["name"]),
                    "id": row["name"],
                    "is_default": False,
                    "status": "ready",
                    "path": f"sqlite:///{self._settings.sessions_db.name}?kb={row['name']}",
                    "metadata": {
                        "created_at": meta.get("created_at"),
                        "last_updated": meta.get("last_updated"),
                        "last_indexed_count": chunks,
                        "rag_provider": "keyword",
                    },
                    "statistics": {
                        "raw_documents": int(doc_counts.get(row["name"], 0)),
                        "rag_initialized": chunks > 0,
                        "status": "ready",
                    },
                }
            )
        return out

    def create(self, name: str) -> dict[str, Any]:
        safe = _safe_name(name)
        if not safe:
            raise ValueError("Knowledge base needs a name")
        if self._meta(safe) is None:
            stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
            self._save_meta(safe, {"name": safe, "created_at": stamp, "last_updated": stamp})
        return {"name": safe, "id": safe, "status": "ready"}

    def delete(self, name: str) -> bool:
        safe = _safe_name(name)
        with database.connect(self._settings) as connection:
            exists = connection.execute(
                "SELECT 1 FROM kb_meta WHERE name = ?", (safe,)
            ).fetchone()
            if exists is None:
                return False
            connection.execute("DELETE FROM kb_meta WHERE name = ?", (safe,))
            connection.execute("DELETE FROM kb_docs WHERE kb = ?", (safe,))
            connection.execute("DELETE FROM kb_chunks WHERE kb = ?", (safe,))
        return True

    def exists(self, name: str) -> bool:
        return self._meta(_safe_name(name)) is not None

    # -- documents ------------------------------------------------------------

    def add_document(self, name: str, filename: str, data: bytes) -> dict[str, Any]:
        safe = _safe_name(name)
        if not self.exists(safe):
            self.create(safe)
        doc_name = filename.rsplit("/", 1)[-1] or "upload.bin"
        with database.connect(self._settings) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO kb_docs (kb, name, data, size) VALUES (?, ?, ?, ?)
                """,
                (safe, doc_name, data, len(data)),
            )
        self.reindex(safe)
        return {"filename": doc_name, "size": len(data)}

    def list_documents(self, name: str) -> List[dict[str, Any]]:
        safe = _safe_name(name)
        with database.connect(self._settings) as connection:
            rows = connection.execute(
                "SELECT name, size FROM kb_docs WHERE kb = ? ORDER BY name", (safe,)
            ).fetchall()
        return [
            {
                "name": row["name"],
                "size": int(row["size"] or 0),
                "suffix": ("." + row["name"].rsplit(".", 1)[-1]) if "." in row["name"] else "",
            }
            for row in rows
        ]

    def delete_document(self, name: str, filename: str) -> bool:
        safe = _safe_name(name)
        doc_name = filename.rsplit("/", 1)[-1]
        with database.connect(self._settings) as connection:
            cursor = connection.execute(
                "DELETE FROM kb_docs WHERE kb = ? AND name = ?", (safe, doc_name)
            )
            if cursor.rowcount == 0:
                return False
        self.reindex(safe)
        return True

    # -- indexing / retrieval ---------------------------------------------------

    def reindex(self, name: str) -> int:
        safe = _safe_name(name)
        with database.connect(self._settings) as connection:
            docs = connection.execute(
                "SELECT name, data FROM kb_docs WHERE kb = ? ORDER BY name", (safe,)
            ).fetchall()
        chunks: list[tuple[str, str, str, str, int]] = []
        for doc in docs:
            text = _extract_text(doc["name"], bytes(doc["data"]))
            if not text.strip():
                continue
            for index, chunk in enumerate(_chunk(text)):
                chunks.append(
                    (
                        safe,
                        f"{doc['name']}#{index}",
                        doc["name"],
                        chunk,
                        len(chunks),
                    )
                )
        with database.connect(self._settings) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DELETE FROM kb_chunks WHERE kb = ?", (safe,))
                connection.executemany(
                    """
                    INSERT OR REPLACE INTO kb_chunks
                        (kb, chunk_id, doc, text, tokens, seq)
                    VALUES (?, ?, ?, ?, '[]', ?)
                    """,
                    chunks,
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        meta = self._meta(safe) or {"name": safe}
        meta["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._save_meta(safe, meta)
        return len(chunks)

    def search(self, name: str, query: str, top_k: int = 5) -> List[dict[str, Any]]:
        safe = _safe_name(name)
        with database.connect(self._settings) as connection:
            rows = connection.execute(
                "SELECT chunk_id, doc, text FROM kb_chunks WHERE kb = ?", (safe,)
            ).fetchall()
        if not rows:
            return []
        q_tokens = _tokenize(query)
        if not q_tokens:
            return []
        chunks = [
            {
                "id": row["chunk_id"],
                "doc": row["doc"],
                "text": row["text"],
                "tokens": _tokenize(row["text"]),
            }
            for row in rows
        ]
        df: dict[str, int] = {}
        for chunk in chunks:
            for token in set(chunk["tokens"]):
                df[token] = df.get(token, 0) + 1
        total = len(chunks)
        scored = []
        for chunk in chunks:
            tf: dict[str, int] = {}
            for token in chunk["tokens"]:
                tf[token] = tf.get(token, 0) + 1
            score = 0.0
            for token in q_tokens:
                if token in tf:
                    idf = math.log(1 + (total - df.get(token, 0) + 0.5) / (df.get(token, 0) + 0.5))
                    score += idf * (tf[token] * 2.2) / (tf[token] + 1.2)
            if score > 0:
                scored.append((score, chunk))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [
            {"id": chunk["id"], "doc": chunk["doc"], "text": chunk["text"], "score": round(score, 3)}
            for score, chunk in scored[:top_k]
        ]

    def read_source(self, name: str, doc: str) -> str:
        safe = _safe_name(name)
        with database.connect(self._settings) as connection:
            rows = connection.execute(
                "SELECT text FROM kb_chunks WHERE kb = ? AND doc = ? ORDER BY seq",
                (safe, doc),
            ).fetchall()
        return "\n\n".join(row["text"] for row in rows)[:30000] if rows else ""


__all__ = ["KnowledgeBaseStore"]
