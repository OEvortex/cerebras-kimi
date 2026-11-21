"""Legacy markdown notes are migrated into Co-Writer notebook pages.

Older versions wrote standalone markdown files under ``data/notes`` while the
Notebook tab lists ``data/documents``. These tests pin that one-time bridge.
"""

from app.services.documents.notes import (
    list_notes,
    search_notes,
    update_note,
    write_note,
)
from app.services.documents.storage import get_co_writer_storage


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

    # A note written through the store must not be imported a second time.
    write_note("New note", "Body", "physics")
    list_notes()
    assert len(storage.list_documents()) == 2


def test_update_note_patches_body_in_place(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    note_id = write_note("Fix me", "teh quick brown fox\n\nteh end", "misc")

    result = update_note(note_id, "teh", "the")
    assert "not found" not in result
    assert "matches 2 places" in result

    result = update_note(note_id, "teh quick", "the quick")
    assert "Updated note 'Fix me'" in result

    page = get_co_writer_storage().load_document(note_id)
    assert page is not None
    assert page.content == "the quick brown fox\n\nteh end"

    result = update_note(note_id, "teh", "the", replace_all=True)
    page = get_co_writer_storage().load_document(note_id)
    assert page is not None
    assert page.content == "the quick brown fox\n\nthe end"


def test_update_note_rejects_bad_input(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    note_id = write_note("Guard", "body text", "misc")

    assert "needs a note_id" in update_note("", "a", "b")
    assert "needs old_string" in update_note(note_id, "", "b")
    assert "differ" in update_note(note_id, "body", "body")
    assert "Note not found" in update_note("doc_missing", "a", "b")
    assert "old_string not found" in update_note(note_id, "missing", "x")

