"""Notebook Ask Dito has its own prompt and tools.

Dito shares the Co-writer toolset (``nb_*`` plus research tools) with the
sub-agent, and keeps the Markdown-only prompt out of ordinary chat turns.
"""

from __future__ import annotations

import pytest

from app.agent import co_writer
from app.agent.co_writer import CO_WRITER_SYSTEM_PROMPT
from app.agent.tools import builtin_tools
from app.agent.turn_context import set_note_context
from app.config import Settings


@pytest.fixture(autouse=True)
def reset_note_context():
    yield
    set_note_context("")


def test_notebook_tools_are_only_exposed_for_note_threads(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    settings = Settings(data_dir=tmp_path)
    def names() -> set[str]:
        return {t.name for t in builtin_tools(settings)}

    assert "nb_read" not in names()

    set_note_context("abc123")
    exposed = names()
    assert {"nb_read", "nb_list", "nb_search", "nb_patch"} <= exposed
    assert "note_suggest" not in exposed


def test_notebook_prompt_uses_markdown_not_openui(tmp_path, monkeypatch):
    from app.agent import prompt as prompt_module

    captured = {}

    def fake_build(cwd, **kwargs):
        captured.update(kwargs)
        return "prompt"

    monkeypatch.setattr("vtx.agent.prompts.builder.build_system_prompt", fake_build)
    monkeypatch.setattr(prompt_module, "OPENUI_SPEC", "root = Col([...])")
    set_note_context("page-1")

    class Runtime:
        cwd = str(tmp_path)

        def declared_tools(self):
            return []

    prompt_module.build_deeptutor_prompt(Runtime())
    base = captured["base_content"]
    assert "# Notebook companion" in base
    assert "Do not emit OpenUI" in base
    assert "root = Col" not in base


def test_co_writer_toolset_matches_cowriter_names():
    names = {tool.name for tool in co_writer.co_writer_tools()}
    assert set(co_writer.CO_WRITER_TOOL_NAMES) == names
    assert CO_WRITER_SYSTEM_PROMPT
