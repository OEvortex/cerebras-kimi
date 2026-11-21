"""Live notebook writer progress and completion notification."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.agent.notebook_agent import events as notebook_events
from app.agent.notebook_agent.capability import launch_notebook_job


class FakeTurn:
    turn_id = "turn-live"
    session_id = "session-live"
    events: list[dict] = []

    def next_seq(self) -> int:
        return len(self.events) + 1


class FakeRuntime:
    def __init__(self) -> None:
        self.emitted: list[dict] = []

    def active_turn_for_session(self, session_id: str):
        return TURN if session_id == TURN.session_id else None

    async def _emit(self, turn, event) -> None:  # type: ignore[no-untyped-def]
        self.emitted.append(event)


TURN = FakeTurn()
RUNTIME = FakeRuntime()


@pytest.fixture(autouse=True)
def reset_events():
    TURN.events.clear()
    RUNTIME.emitted.clear()
    notebook_events.set_runtime(RUNTIME)
    notebook_events.set_current_turn(TURN)
    yield


def test_progress_callback_emits_notebook_progress(monkeypatch):
    async def run() -> None:
        from vtx.agent.dispatcher import set_context

        class Ctx:
            session = type("S", (), {"id": TURN.session_id})()

        set_context(Ctx())  # type: ignore[arg-type]
        notebook_events.progress_callback(
            "notebook_1",
            {"kind": "text_delta", "subagent": "notebook-writer", "delta": "root = Notebook(["},
        )
        await asyncio.sleep(0)

    asyncio.run(run())

    assert len(RUNTIME.emitted) == 1
    event = RUNTIME.emitted[0]
    assert event["type"] == "progress"
    assert event["source"] == "notebook"
    assert event["metadata"]["notebook_progress"]["delta"] == "root = Notebook(["


def test_notify_completion_broadcasts_a_single_frame(monkeypatch):
    sent: list[dict] = []

    async def broadcast(frame: dict) -> None:
        sent.append(frame)

    notebook_events.set_broadcast(broadcast)
    asyncio.run(notebook_events.notify_completion(
        session_id="session-live",
        turn_id="turn-live",
        task_id="bg_0001",
        label="Water cycle",
        report="Notebook built: 1 page(s).",
    ))

    assert len(sent) == 1
    frame = sent[0]
    assert frame["type"] == "turn_event"
    assert frame["turn_id"] == "turn-live"
    assert frame["metadata"]["notebook_completed"]["task_id"] == "bg_0001"
    notebook_events.set_broadcast(None)


def test_background_launch_returns_machine_readable_marker(monkeypatch):
    """The tool result carries the marker the runtime turns into a live panel."""
    import app.agent.dt_tools as dt_tools

    class FakeManager:
        async def register(self, **kwargs):
            return type("R", (), {"task_id": "bg_0042", "notified": False})()

    class FakeCtx:
        model = "test"
        session = type("S", (), {"id": "session-live"})()
        background_manager = FakeManager()
        progress_callback = None

    monkeypatch.setattr("vtx.agent.dispatcher.get_context", lambda: FakeCtx())
    monkeypatch.setattr("app.agent.notebook_agent.tools.register_writer_tools", lambda: None)

    text = asyncio.run(launch_notebook_job(request="water cycle", title="Water"))
    assert "NOTEBOOK_TASK:" in text
    marker = text.split("NOTEBOOK_TASK:", 1)[1].strip().splitlines()[0]
    payload = json.loads(marker)
    assert payload["task_id"] == "bg_0042"
    assert payload["label"] == "Water"
