"""Legacy markdown notes are migrated into Co-Writer notebook pages.

Older versions wrote standalone markdown files under ``data/notes`` while the
Notebook tab lists ``data/documents``. These tests pin that one-time bridge.
"""

from app.services.documents.notes import sync_legacy_notes
from app.services.documents.storage import get_co_writer_storage


def test_legacy_notes_are_imported_once(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    legacy = tmp_path / "notes" / "pn-junction-old.md"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(
        "---\ntitle: Old PN note\ntags: physics, diodes\n"
        "created: 2026-11-20T12:00:00\n---\n\n# Old PN note\n\nDepletion region.",
        encoding="utf-8",
    )

    sync_legacy_notes()
    storage = get_co_writer_storage()
    docs = storage.list_documents()
    assert len(docs) == 1
    page = storage.load_document(docs[0].id)
    assert page is not None
    assert page.title == "Old PN note"
    assert page.tags == ["physics", "diodes"]
    assert page.content.startswith("# Old PN note")

    sync_legacy_notes()
    assert len(storage.list_documents()) == 1, "import must be idempotent"
