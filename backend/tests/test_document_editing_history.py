"""AI edit history lives in the shared SQLite state, not a JSON file."""

import json
import sqlite3

from app.config import Settings
from app.services.documents import editing
from app.store import database
from app.store.session_store import SessionStore


def test_history_round_trips_through_sqlite(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    editing.append_history({"id": "one"})
    editing.append_history({"id": "two"})

    assert [entry["id"] for entry in editing.load_history()] == ["two", "one"]
    assert not (tmp_path / "documents" / "history.json").exists()


def test_history_is_capped(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    for index in range(editing.MAX_HISTORY + 5):
        editing.append_history({"id": str(index)})

    entries = editing.load_history()
    assert len(entries) == editing.MAX_HISTORY
    assert entries[0]["id"] == str(editing.MAX_HISTORY + 4)


def test_legacy_history_file_is_imported_once(tmp_path, monkeypatch):
    monkeypatch.setenv("DT_DATA_DIR", str(tmp_path))
    legacy = tmp_path / "documents" / "history.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(json.dumps([{"id": "old"}]), encoding="utf-8")

    SessionStore(Settings(data_dir=tmp_path))

    assert [entry["id"] for entry in editing.load_history()] == ["old"]
    database.put_state(Settings(data_dir=tmp_path), "documents/history", [{"id": "new"}])
    SessionStore(Settings(data_dir=tmp_path))
    assert [entry["id"] for entry in editing.load_history()] == ["new"]


def test_all_state_shares_one_wal_database(tmp_path):
    settings = Settings(data_dir=tmp_path)
    SessionStore(settings)

    files = sorted(path.name for path in tmp_path.iterdir() if path.is_file())
    assert "deeptutor.sqlite3" in files
    with sqlite3.connect(tmp_path / "deeptutor.sqlite3") as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
