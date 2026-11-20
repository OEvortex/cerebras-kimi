"""Dito is a temporary notebook pairing agent with its own tools.

These tests pin the pieces that make Dito separate from the main chat:
its narrower toolset, its page-management tools, and its session search over
earlier conversations.
"""

from __future__ import annotations

import asyncio

import pytest

from app.agent import dito
from app.agent.dito import DITO_SYSTEM_PROMPT
from app.agent.prompt import DEEPTUTOR_BASE
from app.agent.tools import builtin_tools
from app.agent.turn_context import set_note_context
from app.config import Settings
from app.services import session_search
from app.services.documents.storage import get_co_writer_storage
from app.store.session_store import SessionStore


@pytest.fixture(autouse=True)
def reset_note_context():
    yield
    set_note_context("")


def _run(tool, **kwargs):
    return asyncio.run(tool.execute(tool.params(**kwargs)))


def _page(title: str = "PN Junction"):
    return get_co_writer_storage().create_document(
        title=title, content=f"# {title}\n\nIt has a depletion region."
    )


def test_dito_has_its_own_narrower_toolset(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    settings = Settings(data_dir=tmp_path)
    chat = {tool.name for tool in builtin_tools(settings)}
    assert {"video", "cron", "mastery", "workspace", "question_bank"} <= chat

    page = _page()
    set_note_context(page.id, generation_kind="")
    names = {tool.name for tool in builtin_tools(settings)}
    assert set(dito.DITO_OWN_TOOL_NAMES) <= names
    assert names == set(dito.DITO_TOOL_NAMES)
    assert not {"video", "cron", "mastery", "workspace", "question_bank"} & names
    # The standalone `notes` tool duplicates note_create/note_list/note_search,
    # so Dito manages pages through the note_* tools only.
    assert "notes" not in names
    assert "notes" in chat


def test_note_create_and_list_manage_the_notebook(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page()
    set_note_context(page.id)

    created = _run(
        dito.note_create, title="MOSFET", content="# MOSFET\n\nA field-effect device."
    )
    assert created.success and "MOSFET" in created.result

    storage = get_co_writer_storage()
    child = next(doc for doc in storage.list_documents() if doc.title == "MOSFET")
    child_doc = storage.load_document(child.id)
    assert child_doc is not None
    assert child_doc.parent_id is None

    sub = _run(dito.note_create, title="Channel", content="body", parent_here=True)
    assert sub.success
    nested = next(doc for doc in storage.list_documents() if doc.title == "Channel")
    nested_doc = storage.load_document(nested.id)
    assert nested_doc is not None
    assert nested_doc.parent_id == page.id

    listed = _run(dito.note_list, query="mos")
    assert "MOSFET" in listed.result and "PN Junction" not in listed.result

    found = _run(dito.note_search, query="depletion")
    assert "PN Junction" in found.result

    opened = _run(dito.note_open, page_id=nested.id)
    assert opened.success and "body" in opened.result


def _session(tmp_path, question: str, answer: str, *, page_id: str = "") -> str:
    store = SessionStore(Settings(data_dir=tmp_path))
    preferences = {"note_document_id": page_id} if page_id else {}
    session = store.create(preferences=preferences)
    store.append_user_message(session, question)
    store.append_assistant_message(
        session, answer, events=[], turn_id="t", parent_message_id=1
    )
    store.save(session)
    return session["id"]


def test_session_search_finds_earlier_conversations(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page()
    set_note_context(page.id, generation_kind="")
    mine = _session(
        tmp_path,
        "Why does a depletion region form?",
        "Carriers diffuse and recombine near the junction.",
        page_id=page.id,
    )
    other = _session(
        tmp_path,
        "What is threshold voltage?",
        "The gate voltage that inverts the channel.",
    )

    page_only = session_search.search(Settings(data_dir=tmp_path), "depletion", page_id=page.id)
    assert [item["session_id"] for item in page_only] == [mine]
    assert "Carriers diffuse" in session_search.render(page_only)

    found = _run(dito.session_search, query="depletion")
    assert found.success and "Carriers diffuse" in found.result
    assert "threshold" not in found.result

    everywhere = _run(dito.session_search, query="threshold", all_sessions=True)
    assert everywhere.success and "inverts the channel" in everywhere.result

    all_hits = session_search.search(Settings(data_dir=tmp_path), "voltage")
    assert [item["session_id"] for item in all_hits] == [other]


def test_notebook_prompt_does_not_inject_earlier_conversations(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page()
    _session(
        tmp_path,
        "earlier question about doping",
        "earlier answer",
        page_id=page.id,
    )
    prompt = dito.notebook_context_block(page.id, "current", "", "")
    assert "earlier question" not in prompt
    assert "PN Junction" in prompt


def test_session_search_scopes_through_the_active_page(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page()
    other = _page("MOSFET")
    set_note_context(page.id, generation_kind="")
    _session(tmp_path, "depletion width?", "It narrows with doping.", page_id=page.id)
    _session(tmp_path, "threshold voltage?", "Gate inverts the channel.", page_id=other.id)

    here = _run(dito.session_search, query="voltage")
    assert here.success and "No matching earlier conversations" in here.result

    everywhere = _run(dito.session_search, query="voltage", all_sessions=True)
    assert everywhere.success and "inverts the channel" in everywhere.result


def test_every_tool_named_in_a_prompt_is_registered(tmp_path, monkeypatch):
    import re

    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    settings = Settings(data_dir=tmp_path)

    def missing(prompt: str, available: set[str]) -> list[str]:
        named = set(re.findall(r"`([a-z_][a-z0-9_]*)`", prompt))
        return sorted(name for name in named if name not in available)

    chat = {tool.name for tool in builtin_tools(settings)}
    assert missing(DEEPTUTOR_BASE, chat) == []

    page = _page()
    set_note_context(page.id)
    dito_set = {tool.name for tool in builtin_tools(settings)}
    assert missing(DITO_SYSTEM_PROMPT, dito_set) == []
    assert dito_set == set(dito.DITO_TOOL_NAMES)
