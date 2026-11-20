"""Conversations held at one line of a note page.

The transcript itself lives in the chat session; the page only keeps where the
conversation belongs, so reopening a note restores the margin threads without
copying messages. Stored beside the page manifest.
"""

from __future__ import annotations

import time
from typing import Any

from .storage import CoWriterStorage


def list_threads(storage: CoWriterStorage, doc_id: str) -> list[dict[str, Any]]:
    raw = storage.load_extra(doc_id, "threads", [])
    return raw if isinstance(raw, list) else []


def anchor(
    storage: CoWriterStorage,
    doc_id: str,
    *,
    session_id: str,
    block_id: str,
    quote: str = "",
    origin: str = "ask",
) -> dict[str, Any]:
    if not session_id:
        raise ValueError("A thread needs a session")
    with storage.locked():
        if storage.load_document(doc_id) is None:
            raise ValueError("Page not found")
        threads = list_threads(storage, doc_id)
        now = time.time()
        for thread in threads:
            if thread.get("session_id") == session_id:
                thread.update(
                    block_id=block_id or thread.get("block_id", ""),
                    quote=quote or thread.get("quote", ""),
                    origin=origin or thread.get("origin", "ask"),
                    updated_at=now,
                )
                storage.save_extra(doc_id, "threads", threads)
                return thread
        thread = {
            "session_id": session_id,
            "block_id": block_id,
            "quote": quote,
            "origin": origin if origin in {"ask", "generate"} else "ask",
            "created_at": now,
            "updated_at": now,
        }
        threads.append(thread)
        storage.save_extra(doc_id, "threads", threads)
        return thread


def remove(storage: CoWriterStorage, doc_id: str, session_id: str) -> bool:
    with storage.locked():
        threads = list_threads(storage, doc_id)
        kept = [thread for thread in threads if thread.get("session_id") != session_id]
        if len(kept) == len(threads):
            return False
        storage.save_extra(doc_id, "threads", kept)
        return True
