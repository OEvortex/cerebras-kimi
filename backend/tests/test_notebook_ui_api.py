"""The notebook-ui-lang generator streams a program as SSE."""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.notebook_ui import SYSTEM_PROMPT, router
from app.config import Settings
from app.services import llm_text

PROGRAM = 'root = Notebook([page], "Test")\npage = Page([para], "Test")\npara = Para("Hello.")'


async def fake_stream(settings, *, system, prompt, llm_selection=None):
    assert "notebook-ui-lang" in system
    assert "photosynthesis" in prompt
    for piece in ["root = Notebook(", "[page], \"Test\")\n", "page = Page([para], \"Test\")\n", "para = Para(\"Hello.\")"]:
        yield piece


def test_generate_streams_deltas_then_the_full_program(monkeypatch):
    monkeypatch.setattr(llm_text, "stream_text", fake_stream)
    app = FastAPI()
    app.include_router(router)
    app.state.settings = Settings()
    client = TestClient(app)

    response = client.post("/api/notebook-ui/generate", json={"request": "photosynthesis notes"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    frames = [block for block in response.text.split("\n\n") if block.strip()]
    events = [block.splitlines()[0] for block in frames]
    assert events[0] == "event: stream"
    assert events[-1] == "event: result"
    payload = json.loads(frames[-1].splitlines()[1].removeprefix("data: "))
    assert payload["program"] == PROGRAM


def test_generate_rejects_an_empty_request():
    app = FastAPI()
    app.include_router(router)
    app.state.settings = Settings()
    client = TestClient(app)
    assert client.post("/api/notebook-ui/generate", json={"request": ""}).status_code == 400


def test_spec_is_shipped():
    assert "root = Notebook" in SYSTEM_PROMPT
    assert "Flashcards(" in SYSTEM_PROMPT
