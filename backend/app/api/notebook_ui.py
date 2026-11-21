"""OpenNotebookUI — stream a notebook-ui-lang program from the configured model.

The frontend renders the streamed program live with the notebook-ui-lang
component library. Unlike the chat's ``notebook`` tool (a background writer
sub-agent that reports pages later), this endpoint is the "generative UI" path:
the model's answer IS the notebook, so headings, LaTeX, multipage structure,
quizzes and flashcards appear as they stream, with no write tools involved.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import get_settings
from ..services import llm_text

router = APIRouter()

_SPEC_PATH = Path(__file__).resolve().parents[1] / "agent" / "notebook_ui_prompt.txt"
try:
    SYSTEM_PROMPT = _SPEC_PATH.read_text(encoding="utf-8").strip()
except OSError:  # pragma: no cover - the file ships with the app
    SYSTEM_PROMPT = ""


class NotebookUIRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    request: str = Field(default="", max_length=8000)
    """What the notebook should contain, in the learner's own words."""
    context: str = Field(default="", max_length=60000)
    """Optional source material: an existing page's Markdown, notes, etc."""
    page_id: str = Field(default="", max_length=64)
    """Optional bound page id, used as the parent when the program is applied."""
    llm_selection: dict[str, Any] | None = None


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _settings_for(request: Request) -> Any:
    return getattr(request.app.state, "settings", None) or get_settings()


@router.post("/api/notebook-ui/generate")
async def generate_notebook_ui(payload: NotebookUIRequest, request: Request):
    """Stream a ``notebook-ui-lang`` program as SSE.

    Events mirror ``/api/documents/actions/edit-react/stream``: ``stream``
    carries ``content`` deltas, ``result`` carries the full program, ``error``
    carries a failure message.
    """
    user_request = payload.request.strip()
    if not user_request and not payload.context.strip():
        raise HTTPException(status_code=400, detail="Give the notebook a topic or some source material.")

    if not SYSTEM_PROMPT:
        raise HTTPException(status_code=500, detail="The notebook-ui-lang spec is missing.")

    sections = [f"Build a study notebook for this request:\n\n{user_request}"]
    if payload.context.strip():
        sections.append(
            "Use the following source material. Preserve its facts, formulas and "
            "links; do not invent citations:\n\n---\n" + payload.context.strip() + "\n---"
        )
    if payload.page_id:
        sections.append(
            "This notebook is being built under notebook page id "
            f"{payload.page_id}. If you extend an existing page, keep its title."
        )
    prompt = "\n\n".join(sections)
    settings = _settings_for(request)

    async def events():
        chunks: list[str] = []
        try:
            async for delta in llm_text.stream_text(
                settings,
                system=SYSTEM_PROMPT,
                prompt=prompt,
                llm_selection=payload.llm_selection,
            ):
                chunks.append(delta)
                yield _sse("stream", {"type": "content", "stage": "responding", "content": delta})
            program = llm_text.clean_thinking_tags("".join(chunks)).strip()
            if not program:
                yield _sse("error", {"detail": "The model returned no notebook program."})
                return
            yield _sse("result", {"program": program})
        except Exception as exc:  # noqa: BLE001 - stream the failure to the UI
            yield _sse("error", {"detail": str(exc)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
