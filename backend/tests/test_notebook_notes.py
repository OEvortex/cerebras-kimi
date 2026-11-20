"""Notes saved by the agent must show up as Co-Writer notebook pages.

The old tool wrote standalone markdown files under ``data/notes`` while the
Notebook tab lists ``data/documents``. These tests pin the bridge between the
two, including migration of notes saved before the fix.
"""

import asyncio

from app.agent.dt_tools import notes
from app.services.documents.notes import list_notes, search_notes, write_note
from app.services.documents.storage import get_co_writer_storage


def _run(tool, **kwargs):
    return asyncio.run(tool.execute(tool.params(**kwargs)))


def test_notes_write_creates_a_notebook_page(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))

    result = _run(
        notes,
        action="write",
        title="PN Junction",
        content="# PN Junction\n\nCarriers diffuse across the junction.",
        tags="electronics, semiconductors",
    )
    assert result.success, result.result

    storage = get_co_writer_storage()
    docs = storage.list_documents()
    assert len(docs) == 1
    page = storage.load_document(docs[0].id)
    assert page is not None
    assert page.title == "PN Junction"
    assert page.tags == ["electronics", "semiconductors"]
    assert "Carriers diffuse" in page.content
    assert page.id in result.result

    # Markdown mirrors are no longer written: the page is the only copy.
    assert list((tmp_path / "notes").glob("*.md")) == []


def test_legacy_notes_are_imported_once_and_are_searchable(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    legacy = tmp_path / "notes" / "pn-junction-old.md"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(
        "---\ntitle: Old PN note\ntags: physics, diodes\n"
        "created: 2026-11-20T12:00:00\n---\n\n# Old PN note\n\nDepletion region.",
        encoding="utf-8",
    )

    listed = list_notes()
    assert "Old PN note" in listed
    storage = get_co_writer_storage()
    docs = storage.list_documents()
    assert len(docs) == 1
    page = storage.load_document(docs[0].id)
    assert page is not None
    assert page.tags == ["physics", "diodes"]
    assert page.content.startswith("# Old PN note")

    list_notes()
    assert len(storage.list_documents()) == 1, "import must be idempotent"

    found = search_notes("diodes")
    assert page.id in found

    # A note written by the tool must not be imported a second time.
    write_note("New note", "Body", "physics")
    list_notes()
    assert len(storage.list_documents()) == 2
