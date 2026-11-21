"""Dito is the notebook pairing agent with its own tools.

These tests pin the pieces that make Dito separate from the main chat:
its narrower toolset and its notebook-turn prompt context.
"""

from __future__ import annotations

import pytest

from app.agent import co_writer
from app.agent.co_writer import CO_WRITER_SYSTEM_PROMPT
from app.agent.prompt import DEEPTUTOR_BASE
from app.agent.tools import builtin_tools
from app.agent.turn_context import set_note_context
from app.config import Settings
from app.services.documents.storage import get_co_writer_storage


@pytest.fixture(autouse=True)
def reset_note_context():
    yield
    set_note_context("")


def _page(title: str = "PN Junction"):
    return get_co_writer_storage().create_document(
        title=title, content=f"# {title}\n\nIt has a depletion region."
    )


def test_co_writer_has_its_own_narrower_toolset(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    settings = Settings(data_dir=tmp_path)
    chat = {tool.name for tool in builtin_tools(settings)}
    assert {"video", "cron", "mastery", "workspace", "question_bank"} <= chat

    page = _page()
    set_note_context(page.id, generation_kind="")
    names = {tool.name for tool in builtin_tools(settings)}
    assert set(co_writer.CO_WRITER_OWN_TOOL_NAMES) <= names
    assert names == set(co_writer.CO_WRITER_TOOL_NAMES)
    assert not {"video", "cron", "mastery", "workspace", "question_bank"} & names
    # Dito manages pages through the shared nb_* tools only.
    assert {"nb_read", "nb_list", "nb_search", "nb_patch"} <= names
    assert "notes" not in names
    assert "notes" in chat


def test_notebook_prompt_does_not_inject_earlier_conversations(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page()
    prompt = co_writer.notebook_context_block(page.id, "current", "", "")
    assert "PN Junction" in prompt


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
    cowriter_set = {tool.name for tool in builtin_tools(settings)}
    assert missing(CO_WRITER_SYSTEM_PROMPT, cowriter_set) == []
    assert cowriter_set == set(co_writer.CO_WRITER_TOOL_NAMES)
