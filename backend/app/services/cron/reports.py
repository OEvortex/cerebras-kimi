"""Recent reminders that actually fired, for live in-app delivery.

A due job writes one entry here so an open tab can surface it without
reloading the conversation: the calendar runtime polls
``GET /api/cron/reports?since=`` and raises the same toast/notification it
uses for event reminders. The store is a bounded ring buffer in the shared
SQLite database — the durable copy of every reminder is the conversation it
was appended to.
"""

from __future__ import annotations

import time
from typing import Any

from ...config import get_settings
from ...store import database

MAX_REPORTS = 200
_KEY = "cron/reports"


def _read() -> list[dict[str, Any]]:
    raw = database.get_state(get_settings(), _KEY, [])
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def record(*, job_id: str, name: str, text: str, status: str) -> dict[str, Any]:
    """Append one delivered reminder and return its entry."""
    entry = {
        "id": f"{job_id}:{int(time.time() * 1000)}",
        "job_id": job_id,
        "name": name,
        "text": " ".join((text or "").split())[:1000],
        "status": status,
        "at": time.time(),
    }
    items = [*_read(), entry][-MAX_REPORTS:]
    database.put_state(get_settings(), _KEY, items)
    return entry


def since(epoch_seconds: float) -> list[dict[str, Any]]:
    """Reports at or after ``epoch_seconds``, oldest first."""
    return [item for item in _read() if float(item.get("at") or 0) >= epoch_seconds]


__all__ = ["record", "since"]
