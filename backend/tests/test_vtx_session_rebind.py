"""The cached vtx runtime must persist into the current turn's record.

`AgentRuntime` keeps one ConversationRuntime per DeepTutor session, but each
turn loads a fresh session dict. Without rebind, vtx appends history to the
dict captured on the first turn and the turn-end save overwrites it with the
fresh one — leaving the model with stale context forever.
"""

from __future__ import annotations

from app.agent.dt_session import rebind


class _Session:
    _dt_store: object
    _dt_record: object


def test_rebind_points_at_the_current_record() -> None:
    store = object()
    first, second = {}, {}
    session = _Session()
    session._dt_store = store
    session._dt_record = first

    rebind(session, store, second)
    assert session._dt_record is second
    assert session._dt_store is store

    # Idempotent: rebinding the same record is a no-op.
    rebind(session, store, second)
    assert session._dt_record is second


def test_rebind_works_on_a_plain_vtx_session() -> None:
    store, record = object(), {}
    session = _Session()
    rebind(session, store, record)
    assert session._dt_store is store
    assert session._dt_record is record
