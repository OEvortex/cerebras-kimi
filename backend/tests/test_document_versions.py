"""Notebook pages keep restorable snapshots as they are edited."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.documents import router as documents_router
from app.services.documents.storage import (
    MAX_VERSIONS_PER_DOCUMENT,
    get_co_writer_storage,
)


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(documents_router)
    return TestClient(app)


def test_saves_create_coalesced_versions_and_restore_rebases_revision(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    storage = get_co_writer_storage()
    doc = storage.create_document(title="Signals", content="First paragraph.")
    assert doc is not None
    assert len(storage.list_versions(doc.id)) == 1

    # Rapid saves of the same continuous edit are folded into one version;
    # the page-creation snapshot is kept as the oldest point in history.
    updated = storage.update_document(
        doc.id, content="Second paragraph.", expected_revision=doc.revision
    )
    assert updated is not None
    updated = storage.update_document(
        doc.id, content="Third paragraph.", expected_revision=updated.revision
    )
    assert updated is not None
    versions = storage.list_versions(updated.id)
    assert len(versions) == 2
    assert versions[0].source == "save"
    assert storage.get_version(updated.id, versions[0].id).content == "Third paragraph."

    # A different kind of write starts a new version rather than coalescing.
    updated = storage.update_document(
        updated.id,
        content="Fourth paragraph.",
        expected_revision=updated.revision,
        source="suggestion",
    )
    assert updated is not None
    versions = storage.list_versions(updated.id)
    assert len(versions) == 3
    target = versions[1]

    client = _client()
    listed = client.get(f"/api/documents/{updated.id}/versions")
    assert listed.status_code == 200
    assert listed.json()["total"] == 3
    assert "payload" not in listed.json()["versions"][0]

    detail = client.get(f"/api/documents/{updated.id}/versions/{target.id}")
    assert detail.status_code == 200
    assert detail.json()["content"] == "Third paragraph."

    restored = client.post(
        f"/api/documents/{updated.id}/versions/{target.id}/restore",
        json={"expected_revision": updated.revision},
    )
    assert restored.status_code == 200
    page = restored.json()
    assert page["content"] == "Third paragraph."
    assert page["revision"] == updated.revision + 1

    # A stale revision is rejected rather than overwriting newer work.
    conflict = client.post(
        f"/api/documents/{updated.id}/versions/{target.id}/restore",
        json={"expected_revision": updated.revision},
    )
    assert conflict.status_code == 409


def test_version_endpoints_validate_ids_and_scope_by_document(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    storage = get_co_writer_storage()
    first = storage.create_document(title="One", content="Alpha")
    second = storage.create_document(title="Two", content="Beta")
    assert first and second
    version = storage.list_versions(first.id)[0]

    client = _client()
    assert client.get("/api/documents/nope/versions").status_code == 400
    assert client.get("/api/documents/000000000000/versions").status_code == 404
    assert (
        client.get(f"/api/documents/{second.id}/versions/{version.id}").status_code
        == 404
    )
    assert (
        client.post(
            f"/api/documents/{first.id}/versions/{version.id}/restore",
            json={"expected_revision": 99},
        ).status_code
        == 409
    )


def test_deleting_a_page_removes_its_versions(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    storage = get_co_writer_storage()
    doc = storage.create_document(title="Temporary", content="Gone soon")
    assert doc
    assert storage.list_versions(doc.id)
    assert storage.delete_document(doc.id)
    assert storage.list_versions(doc.id) == []


def test_pruning_keeps_the_newest_versions(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    storage = get_co_writer_storage()
    doc = storage.create_document(title="Long", content="0")
    assert doc
    revision = doc.revision
    # Alternate sources so each edit creates its own version.
    for index in range(1, MAX_VERSIONS_PER_DOCUMENT + 12):
        source = "edit" if index % 2 else "save"
        updated = storage.update_document(
            doc.id, content=str(index), expected_revision=revision, source=source
        )
        assert updated is not None
        revision = updated.revision
    versions = storage.list_versions(doc.id)
    assert len(versions) == MAX_VERSIONS_PER_DOCUMENT
    newest = storage.get_version(doc.id, versions[0].id)
    assert newest is not None and newest.content == str(MAX_VERSIONS_PER_DOCUMENT + 11)
