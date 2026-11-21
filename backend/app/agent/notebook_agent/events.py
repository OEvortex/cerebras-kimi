"""Bridge the notebook writer sub-agent's progress into DeepTutor's live chat.

Two gaps this closes:

1. vtx's ``progress_callback`` is never installed by DeepTutor, so the writer's
   ``subagent_start`` / ``text_delta`` / ``tool_start`` / ``tool_result`` events
   went nowhere. Installing this module's sync callback on the vtx
   ``ConversationRuntime`` turns them into SSE ``progress`` events on the
   parent turn, so the chat shows a live panel while the notebook is written.

2. Background tasks settle long after the parent turn ended. ``notify_completion``
   broadcasts a completion frame to every connected browser client immediately,
   instead of waiting for vtx's between-turn drain.
"""

from __future__ import annotations

import asyncio
import contextvars
import itertools
import logging
import time
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

_Broadcast = Callable[[dict[str, Any]], Awaitable[None]]
_broadcast: _Broadcast | None = None
_runtime: Any = None
_current_turn: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "dt_notebook_turn", default=None
)
_seq = itertools.count(1)


def set_broadcast(fn: _Broadcast | None) -> None:
    global _broadcast
    _broadcast = fn


def set_runtime(runtime: Any) -> None:
    global _runtime
    _runtime = runtime


def set_current_turn(turn: Any) -> Any:
    """Bind the turn that owns the active tool call; returns a reset token."""
    return _current_turn.set(turn)


def reset_current_turn(token: Any) -> None:
    try:
        _current_turn.reset(token)
    except (ValueError, RuntimeError):
        pass


def progress_callback(tool_call_id: str, payload: dict[str, Any]) -> None:
    """Sync vtx callback: ``callback(tool_call_id, {kind, subagent, ...})``."""
    turn = _current_turn.get()
    runtime = _runtime
    if turn is None or runtime is None:
        return
    kind = str(payload.get("kind") or "progress")
    if payload.get("subagent") not in (None, "notebook-writer"):
        return

    labels = {
        "subagent_start": "Starting notebook writer",
        "text_delta": "Writing notebook",
        "tool_start": "Looking up notebook pages",
        "tool_result": "Finished a lookup",
        "turn_end": "Drafting pages",
        "subagent_end": "Notebook draft complete",
        "error": "Notebook writer hit an error",
        "cancelled": "Notebook writer cancelled",
        "interrupted": "Notebook writer interrupted",
    }
    content = str(labels.get(kind, kind))
    if kind == "tool_start":
        content = f"Calling {payload.get('tool_name') or 'a tool'}"
    if kind == "error":
        content = f"Notebook writer error: {str(payload.get('error') or '')[:300]}"

    meta: dict[str, Any] = {
        "tool_call_id": tool_call_id,
        "tool_name": "notebook",
        "notebook_progress": {
            "kind": kind,
            "delta": str(payload.get("delta") or "") if kind == "text_delta" else "",
            "tool": str(payload.get("tool_name") or "") if kind else "",
            "tool_counts": payload.get("tool_counts") or {},
            "turns": int(payload.get("turns") or 0),
            "subagent": "notebook-writer",
        },
    }
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_emit_progress(runtime, turn, content, meta))


async def _emit_progress(
    runtime: Any, turn: Any, content: str, meta: dict[str, Any]
) -> None:
    try:
        from ..runtime import AgentRuntime

        event = AgentRuntime._stream_event(
            turn,
            "progress",
            content=content,
            source="notebook",
            stage="responding",
            metadata=meta,
        )
        await runtime._emit(turn, event)
    except Exception:  # noqa: BLE001 - progress must never fail the writer
        logger.exception("Could not emit notebook progress event")


async def notify_completion(
    *,
    session_id: str,
    turn_id: str,
    task_id: str,
    label: str,
    report: str,
    status: str = "completed",
    error: str = "",
) -> None:
    """Push a completion frame to every connected client, immediately."""
    fn = _broadcast
    if fn is None or not session_id:
        return
    payload = {
        "task_id": task_id,
        "label": label,
        "report": report,
        "status": status,
        "error": error,
    }
    frame = {
        "type": "turn_event",
        "protocol_version": "2.0",
        "seq": next(_seq),
        "session_id": session_id,
        "turn_id": turn_id,
        "timestamp": time.time(),
        "source": "notebook",
        "stage": "responding",
        "content": (
            f"Notebook ready: {label}" if status == "completed"
            else f"Notebook failed: {label}"
        ),
        "metadata": {"notebook_completed": payload},
    }
    try:
        await fn(frame)
    except Exception:  # noqa: BLE001
        logger.exception("Could not broadcast notebook completion")
