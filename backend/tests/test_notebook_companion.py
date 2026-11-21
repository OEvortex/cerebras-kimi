"""Notebook Ask Dito has its own prompt and tools.

Mirror the reference `notes` capability: read the page with IDs, propose
reviewable changes (including flashcards as learning blocks), and keep the
Markdown-only prompt out of ordinary chat turns.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.agent.dt_tools import flashcards, note_read, note_suggest
from app.agent.turn_context import set_note_context
from app.agent.tools import builtin_tools
from app.config import Settings
from app.services.documents.proposals import list_proposals
from app.services.documents.storage import get_co_writer_storage


@pytest.fixture(autouse=True)
def reset_note_context():
    yield
    set_note_context("")


def _run(tool, **kwargs):
    return asyncio.run(tool.execute(tool.params(**kwargs)))


def _page(tmp_path):
    return get_co_writer_storage().create_document(
        title="PN Junction",
        content="# PN Junction\n\nIt has a depletion region.",
        blocks=[
            {
                "id": "block-one",
                "type": "paragraph",
                "props": {},
                "content": [{"type": "text", "text": "It has a depletion region.", "styles": {}}],
                "children": [],
            }
        ],
    )


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


def test_note_read_returns_block_ids(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page(tmp_path)
    set_note_context(page.id)

    result = _run(note_read)
    assert result.success, result.result
    assert "block-one" in result.result
    assert "PN Junction" in result.result

    single = _run(note_read, block_id="block-one")
    assert single.success and "depletion region" in single.result


def test_flashcards_propose_reviewable_learning_block(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page(tmp_path)
    set_note_context(page.id)

    result = _run(
        flashcards,
        cards_json=json.dumps([
            {"front": "What is a PN junction?", "back": "A p-n boundary."},
            {"front": "Depletion region?", "back": "Carrier-free zone."},
        ]),
    )
    assert result.success, result.result
    assert "for review" in result.result

    storage = get_co_writer_storage()
    proposals = list_proposals(storage, page.id)
    assert len(proposals) == 1
    assert proposals[0]["status"] == "pending"
    block = proposals[0]["blocks"][0]
    assert block["type"] == "learning"
    assert block["props"]["kind"] == "flashcards"
    assert len(json.loads(block["props"]["data"])["cards"]) == 2

    # Nothing is written to the page until the learner accepts the proposal.
    persisted = storage.load_document(page.id)
    assert persisted is not None
    assert persisted.blocks == page.blocks


def test_note_suggest_rejects_unknown_operation(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    page = _page(tmp_path)
    set_note_context(page.id)
    result = _run(note_suggest, operation="explode", block_id="block-one")
    assert not result.success or "Could not propose" in result.result


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
