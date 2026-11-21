"""The chat title is generated asynchronously in parallel with the turn.

The title request runs non-blocking in the background from the user's message
and emits `session_meta` as soon as it resolves (without waiting for the
turn to complete or holding up assistant generation).
"""

import asyncio

from app.agent.runtime import AgentRuntime, TurnHandle
from app.config import Settings
from app.store.session_store import SessionStore


class _Store(SessionStore):
    """SessionStore with saves counted, so a failed title can be asserted to
    leave the record alone."""

    def __init__(self, tmp_path):
        super().__init__(Settings(data_dir=tmp_path / "data"))
        self.saves = 0

    def save(self, session):  # type: ignore[override]
        self.saves += 1
        return super().save(session)


def _runtime(tmp_path):
    store = _Store(tmp_path)
    return AgentRuntime(store._settings, store), store


def _handle():
    return TurnHandle(turn_id="turn_1", session_id="sess_1")


def _session():
    return {"id": "sess_1", "title": "Untitled", "title_auto": True, "turns": {}}


def test_title_runs_non_blocking_and_emits_immediately(tmp_path, monkeypatch):
    runtime, store = _runtime(tmp_path)
    handle = _handle()
    session = _session()
    started = asyncio.Event()
    release = asyncio.Event()

    async def fake_generate(user_text, assistant_text="", *, settings=None):
        started.set()
        await release.wait()
        return "PN junction study notes"

    monkeypatch.setattr("app.services.title_gen.generate_title", fake_generate)

    async def scenario():
        task = runtime._start_title_request(
            handle, session, "make me notes on pn junction"
        )
        # The turn is not waiting on the title endpoint.
        assert not handle.settled.is_set()
        assert session.get("title") == "Untitled"
        # The attempt is claimed up front, so a second turn cannot start a rival
        # call while this one is still in flight.
        assert session["title_auto"] is False
        await started.wait()
        release.set()
        await task
        assert handle.settled.is_set()

    asyncio.run(scenario())

    assert session["title"] == "PN junction study notes"
    assert store.saves == 1
    frames = [e for e in handle.events if e["type"] == "session_meta"]
    assert [f["metadata"] for f in frames] == [{"title": "PN junction study notes"}]


def test_a_dead_title_endpoint_never_blocks_or_retries(tmp_path, monkeypatch):
    runtime, store = _runtime(tmp_path)
    handle = _handle()
    session = _session()

    async def broken(user_text, assistant_text="", *, settings=None):
        raise RuntimeError("title endpoint down")

    monkeypatch.setattr("app.services.title_gen.generate_title", broken)

    async def scenario():
        task = runtime._start_title_request(handle, session, "hi")
        await task
        assert handle.settled.is_set()

    asyncio.run(scenario())

    # One shot per session: the placeholder stays and the attempt is not retried.
    assert session["title"] == "Untitled"
    assert session["title_auto"] is False
    assert store.saves == 0
    assert [e for e in handle.events if e["type"] == "session_meta"] == []


def test_no_title_work_leaves_the_pump_free_to_close(tmp_path):
    runtime, _store = _runtime(tmp_path)
    session = {"id": "sess_1", "title": "Named by the learner", "turns": {}}
    assert not session.get("title_auto")
    handle = _handle()
    handle.settled.set()
    assert handle.settled.is_set()
