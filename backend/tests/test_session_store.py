from app.config import Settings
from app.store.session_store import SessionStore


def _store(tmp_path):
    return SessionStore(Settings(data_dir=tmp_path / "data"))


def _message(message_id, role, parent=None, **extra):
    return {
        "id": message_id,
        "session_id": "sess_test",
        "role": role,
        "content": f"{role} {message_id}",
        "capability": None,
        "events": [],
        "attachments": [],
        "metadata": {},
        "created_at": 1.0,
        "parent_message_id": parent,
        **extra,
    }


def test_append_messages_chain_parents(tmp_path):
    store = _store(tmp_path)
    session = store.create()

    user1 = store.append_user_message(session, "first")
    assistant1 = store.append_assistant_message(
        session, "answer", events=[], turn_id="turn_1"
    )
    user2 = store.append_user_message(session, "second")
    assistant2 = store.append_assistant_message(
        session, "answer 2", events=[], turn_id="turn_2"
    )

    assert user1["parent_message_id"] is None
    assert assistant1["parent_message_id"] == user1["id"]
    assert user2["parent_message_id"] == assistant1["id"]
    assert assistant2["parent_message_id"] == user2["id"]


def test_explicit_parent_and_root_edit(tmp_path):
    store = _store(tmp_path)
    session = store.create()
    user1 = store.append_user_message(session, "first")
    assistant1 = store.append_assistant_message(
        session, "answer", events=[], turn_id="turn_1"
    )

    edited = store.append_user_message(
        session, "edited", parent_message_id=user1["parent_message_id"]
    )
    reply = store.append_assistant_message(
        session, "edited answer", events=[], turn_id="turn_2"
    )

    assert edited["parent_message_id"] is None
    assert reply["parent_message_id"] == edited["id"]
    assert assistant1["parent_message_id"] == user1["id"]


def test_get_repairs_flat_legacy_transcript(tmp_path):
    store = _store(tmp_path)
    session = store.create()
    session["messages"] = [
        _message(1, "user"),
        _message(2, "assistant"),
        _message(3, "user"),
        _message(4, "assistant"),
    ]
    session["next_message_id"] = 5
    store.save(session)

    loaded = store.get(session["id"])

    assert [m["parent_message_id"] for m in loaded["messages"]] == [
        None,
        1,
        2,
        3,
    ]


def test_get_repairs_duplicate_legacy_ids(tmp_path):
    store = _store(tmp_path)
    session = store.create()
    session["messages"] = [
        _message(1, "user"),
        _message(2, "assistant"),
        _message(1, "user"),
        _message(2, "assistant"),
        _message(1, "user"),
        _message(2, "assistant"),
    ]
    session["next_message_id"] = 3
    store.save(session)

    loaded = store.get(session["id"])

    assert [m["id"] for m in loaded["messages"]] == [1, 2, 3, 4, 5, 6]
    assert [m["parent_message_id"] for m in loaded["messages"]] == [
        None,
        1,
        2,
        3,
        4,
        5,
    ]
    assert loaded["next_message_id"] == 7


def test_get_preserves_existing_branch_tree(tmp_path):
    store = _store(tmp_path)
    session = store.create()
    session["messages"] = [
        _message(1, "user"),
        _message(2, "assistant", parent=1),
        _message(3, "user"),  # legitimate root-edit sibling
        _message(4, "assistant", parent=3),
        _message(5, "user", parent=4),
        _message(6, "assistant", parent=5),
    ]
    session["next_message_id"] = 7
    store.save(session)

    loaded = store.get(session["id"])

    assert [m["parent_message_id"] for m in loaded["messages"]] == [
        None,
        1,
        None,
        3,
        4,
        5,
    ]


def test_legacy_json_sessions_are_imported_and_archived(tmp_path):
    import json

    data = tmp_path / "data"
    legacy = data / "sessions"
    legacy.mkdir(parents=True)
    record = {
        "id": "sess_legacy",
        "title": "Legacy notes",
        "created_at": 10.0,
        "updated_at": 20.0,
        "status": "idle",
        "preferences": {"note_document_id": "page_1"},
        "messages": [
            _message(1, "user"),
            _message(2, "assistant", parent=1),
        ],
        "turns": {},
        "vtx_items": [],
        "next_message_id": 3,
    }
    (legacy / "sess_legacy.json").write_text(json.dumps(record), encoding="utf-8")

    store = SessionStore(Settings(data_dir=data))

    loaded = store.get("sess_legacy")
    assert loaded is not None
    assert loaded["title"] == "Legacy notes"
    assert loaded["updated_at"] == 20.0
    assert [m["session_id"] for m in loaded["messages"]] == ["sess_legacy", "sess_legacy"]
    assert not (legacy / "sess_legacy.json").exists()
    assert (data / "sessions-legacy" / "sess_legacy.json").exists()
    assert (data / "deeptutor.sqlite3").exists()


def test_search_uses_message_index_and_page_filter(tmp_path):
    store = _store(tmp_path)
    first = store.create(preferences={"note_document_id": "page_a"})
    store.append_user_message(first, "Why does the depletion region narrow under bias?")
    store.append_assistant_message(
        first, "It widens with reverse bias and narrows with forward bias.",
        events=[], turn_id="t1",
    )
    store.save(first)

    second = store.create(preferences={"note_document_id": "page_b"})
    store.append_user_message(second, "Explain threshold voltage.")
    store.append_assistant_message(
        second, "The gate voltage that inverts the channel.", events=[], turn_id="t2"
    )
    store.save(second)

    hits = store.search_hits("depletion OR bias", limit=5)
    assert [hit["session_id"] for hit in hits] == [first["id"]]
    assert "depletion" in hits[0]["question"].lower()
    assert "reverse bias" in hits[0]["answer"].lower()

    scoped = store.search_hits("voltage", limit=5, page_id="page_a")
    assert scoped == []

    found, total = store.search("threshold", limit=10)
    assert total == 1
    assert found[0]["id"] == second["id"]
    assert "threshold" in found[0]["_match_excerpt"].lower()


def test_delete_removes_index_rows(tmp_path):
    store = _store(tmp_path)
    session = store.create()
    store.append_user_message(session, "unique-zebra-term")
    store.save(session)
    assert store.search_hits("zebra")

    assert store.delete(session["id"]) is True
    assert store.get(session["id"]) is None
    assert store.search_hits("zebra") == []
    assert store.delete(session["id"]) is False
