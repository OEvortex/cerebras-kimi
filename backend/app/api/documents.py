"""Note pages (the Note tab and Co-Writer) — pages, review queue, assets, threads.

Pages live in the shared SQLite database. A page carries BlockNote blocks, a
Markdown projection, a revision counter for optimistic concurrency, and a
review queue of proposed edits that the learner accepts or dismisses one by
one.
"""

from __future__ import annotations

import json
import logging
import re
import time
import traceback
import urllib.parse
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import get_settings
from ..services import llm_text
from ..services.documents import editing
from ..services.documents import threads as thread_store
from ..services.documents.anki import cards_from_storage, render_anki_export
from ..services.documents.blocks import blocks_to_markdown, safe_link, validate_blocks
from ..services.documents.proposals import propose as create_proposal
from ..services.documents.proposals import list_proposals, review as review_proposal
from ..services.documents.review import due_cards, page_cards
from ..services.documents.review import grade_card as grade_review_card
from ..services.documents.storage import (
    CoWriterDocument,
    RevisionConflict,
    get_co_writer_storage,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_DOC_CHARS = 600_000


def _doc_id(raw: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{8,32}", raw or ""):
        raise HTTPException(status_code=400, detail="Invalid page ID")
    return raw


class CreateDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    content: str = Field(default="", max_length=_MAX_DOC_CHARS)
    blocks: list[dict[str, Any]] | None = None
    parent_id: str | None = None


class UpdateDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    content: str | None = Field(default=None, max_length=_MAX_DOC_CHARS)
    blocks: list[dict[str, Any]] | None = None
    expected_revision: int | None = None
    parent_id: str | None = None
    icon: str | None = Field(default=None, max_length=16)
    cover: str | None = Field(default=None, max_length=2000)
    pinned: bool | None = None


# ── AI edits (whole draft, selection, auto-mark) ─────────────────────────
#
# These live before the ``{doc_id}`` routes so "/documents/history" is not
# mistaken for a page id. They call the model configured in Settings; a
# provider or model failure surfaces as a 502 with the provider's message
# instead of a silent empty edit.

_ACTION_VERBS = {"rewrite", "shorten", "expand", "polish", "continue"}


class EditRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    text: str = Field(default="", max_length=_MAX_DOC_CHARS)
    instruction: str = Field(default="", max_length=4000)
    action: str = "rewrite"
    source: str | None = None
    kb_name: str | None = None
    llm_selection: dict[str, Any] | None = None


class ReactEditRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    selected_text: str = Field(default="", max_length=_MAX_DOC_CHARS)
    instruction: str = Field(default="", max_length=4000)
    mode: str = "none"
    tools: list[str] | None = None
    kb_name: str | None = None
    llm_selection: dict[str, Any] | None = None


class AutoMarkRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    text: str = Field(default="", max_length=_MAX_DOC_CHARS)
    llm_selection: dict[str, Any] | None = None


def _settings_for(request: Request) -> Any:
    return getattr(request.app.state, "settings", None) or get_settings()


async def _reference_context(
    request: Request, *, sources: list[str], kb_name: str | None, query: str
) -> tuple[str, list[str]]:
    """Retrieve reference material; a failing tool degrades to a plain edit."""
    blocks: list[str] = []
    used: list[str] = []
    for source in sources:
        if source == "rag" and kb_name:
            try:
                from ..agent import kb_tools

                search = kb_tools.knowledge_base_search
                result = await search.execute(
                    search.params(
                        action="search", query=query, kb_name=kb_name, top_k=5
                    )
                )
                text = str(getattr(result, "result", "") or "")
                if text and not text.startswith("No "):
                    blocks.append(f"[Knowledge base: {kb_name}]\n{text}")
                    used.append("rag")
            except Exception:  # noqa: BLE001 - retrieval must never block the edit
                logger.debug("rag reference failed", exc_info=True)
        elif source == "web":
            try:
                from ..agent import dt_tools

                web = dt_tools.web
                result = await web.execute(web.params(query=query, max_results=5))
                text = str(getattr(result, "result", "") or "")
                if text:
                    blocks.append(f"[Web search: {query}]\n{text}")
                    used.append("web")
            except Exception:  # noqa: BLE001
                logger.debug("web reference failed", exc_info=True)
    return "\n\n".join(blocks), used


@router.post("/api/documents/actions/edit")
async def edit_text(payload: EditRequest, request: Request) -> dict[str, Any]:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="There is nothing to edit yet.")
    settings = _settings_for(request)
    action = payload.action if payload.action in _ACTION_VERBS else "rewrite"
    context, used = await _reference_context(
        request,
        sources=[payload.source] if payload.source in {"rag", "web"} else [],
        kb_name=payload.kb_name,
        query=(payload.instruction or payload.text[:300]).strip(),
    )
    system, prompt = editing.edit_prompt(payload.text, payload.instruction, action)
    if context:
        prompt = f"{prompt}\n\nReference material:\n{context}"
    try:
        raw = await llm_text.complete_text(
            settings, system=system, prompt=prompt, llm_selection=payload.llm_selection
        )
    except Exception as exc:  # noqa: BLE001 - surface provider errors to the UI
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    edited = editing.clean_output(raw)
    if not edited:
        raise HTTPException(status_code=502, detail="The model returned no text.")
    operation_id = editing.new_operation_id()
    editing.record(
        operation_id=operation_id,
        action=action,
        model=str(llm_text.resolve(settings, payload.llm_selection).get("model") or ""),
        original=payload.text,
        edited=edited,
        instruction=payload.instruction,
        tools=used,
        kb_name=payload.kb_name,
    )
    return {"edited_text": edited, "operation_id": operation_id, "tools_used": used}


def _prepare_react_edit(payload: ReactEditRequest) -> tuple[str, str, list[str]]:
    tools = [t for t in (payload.tools or []) if t in {"rag", "web"}]
    instruction = payload.instruction.strip()
    if payload.mode == "none" and not instruction:
        raise HTTPException(
            status_code=400,
            detail="Provide an edit instruction, or choose shorten / expand / rewrite mode.",
        )
    selected = payload.selected_text.strip("\n")
    if not selected.strip():
        raise HTTPException(status_code=400, detail="Please select a text passage first.")
    return selected, instruction, tools


@router.post("/api/documents/actions/edit-react")
async def edit_text_react(payload: ReactEditRequest, request: Request) -> dict[str, Any]:
    selected, instruction, tools = _prepare_react_edit(payload)
    settings = _settings_for(request)
    context, used = await _reference_context(
        request,
        sources=tools,
        kb_name=payload.kb_name,
        query=(instruction or selected[:400]).strip(),
    )
    system, prompt = editing.react_edit_prompt(
        selected_text=selected, instruction=instruction, mode=payload.mode, context=context
    )
    try:
        raw = await llm_text.complete_text(
            settings, system=system, prompt=prompt, llm_selection=payload.llm_selection
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    edited = editing.clean_output(raw)
    if not edited:
        raise HTTPException(status_code=502, detail="The model returned no text.")
    operation_id = editing.new_operation_id()
    editing.record(
        operation_id=operation_id,
        action="react_edit",
        mode=payload.mode,
        model=str(llm_text.resolve(settings, payload.llm_selection).get("model") or ""),
        original=selected,
        edited=edited,
        instruction=instruction,
        tools=used,
        kb_name=payload.kb_name,
    )
    return {"edited_text": edited, "operation_id": operation_id, "tools_used": used}


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/api/documents/actions/edit-react/stream")
async def edit_text_react_stream(payload: ReactEditRequest, request: Request):
    selected, instruction, tools = _prepare_react_edit(payload)
    settings = _settings_for(request)

    async def events():
        operation_id = editing.new_operation_id()
        used: list[str] = []
        try:
            yield _sse("stream", {"type": "stage", "stage": "exploring"})
            context, used = await _reference_context(
                request,
                sources=tools,
                kb_name=payload.kb_name,
                query=(instruction or selected[:400]).strip(),
            )
            for tool in used:
                yield _sse(
                    "stream",
                    {
                        "type": "tool_call",
                        "stage": "exploring",
                        "content": tool,
                        "metadata": {"args": {"query": instruction or selected[:200]}},
                    },
                )
                yield _sse(
                    "stream",
                    {
                        "type": "tool_result",
                        "stage": "exploring",
                        "content": "[reference collected]",
                        "metadata": {"tool": tool},
                    },
                )
            system, prompt = editing.react_edit_prompt(
                selected_text=selected,
                instruction=instruction,
                mode=payload.mode,
                context=context,
            )
            yield _sse("stream", {"type": "stage", "stage": "responding"})
            chunks: list[str] = []
            async for delta in llm_text.stream_text(
                settings, system=system, prompt=prompt, llm_selection=payload.llm_selection
            ):
                chunks.append(delta)
                yield _sse(
                    "stream", {"type": "content", "stage": "responding", "content": delta}
                )
            edited = editing.clean_output("".join(chunks))
            if not edited:
                yield _sse("error", {"detail": "The model returned no text."})
                return
            editing.record(
                operation_id=operation_id,
                action="react_edit",
                mode=payload.mode,
                model=str(
                    llm_text.resolve(settings, payload.llm_selection).get("model") or ""
                ),
                original=selected,
                edited=edited,
                instruction=instruction,
                tools=used,
                kb_name=payload.kb_name,
            )
            yield _sse(
                "result",
                {
                    "edited_text": edited,
                    "operation_id": operation_id,
                    "tools_used": used,
                },
            )
        except Exception as exc:  # noqa: BLE001 - stream the failure to the UI
            yield _sse("error", {"detail": str(exc)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/api/documents/actions/automark")
async def auto_mark_text(payload: AutoMarkRequest, request: Request) -> dict[str, Any]:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Add some content before running auto-mark.")
    settings = _settings_for(request)
    system, prompt = editing.automark_prompt(payload.text)
    try:
        raw = await llm_text.complete_text(
            settings, system=system, prompt=prompt, llm_selection=payload.llm_selection
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    marked = editing.clean_output(raw) or payload.text
    operation_id = editing.new_operation_id()
    editing.record(
        operation_id=operation_id,
        action="automark",
        model=str(llm_text.resolve(settings, payload.llm_selection).get("model") or ""),
        original=payload.text,
        edited=marked,
        instruction="AI Auto Mark",
    )
    return {"marked_text": marked, "operation_id": operation_id}


@router.get("/api/documents/history")
def get_history() -> dict[str, Any]:
    history = editing.load_history()
    return {"history": history, "total": len(history)}


@router.get("/api/documents/history/{operation_id}")
def get_operation(operation_id: str) -> dict[str, Any]:
    for entry in editing.load_history():
        if entry.get("id") == operation_id:
            return entry
    raise HTTPException(status_code=404, detail="Operation not found")


@router.get("/api/documents/tool-calls/{operation_id}")
def get_tool_call(operation_id: str) -> dict[str, Any]:
    for entry in editing.load_history():
        if entry.get("id") == operation_id:
            return {
                "operation_id": operation_id,
                "tools": entry.get("tools") or [],
                "kb_name": entry.get("kb_name"),
            }
    raise HTTPException(status_code=404, detail="Tool call not found")


@router.get("/api/documents")
def list_documents() -> dict[str, list[dict[str, Any]]]:
    storage = get_co_writer_storage()
    return {"documents": [s.model_dump() for s in storage.list_documents()]}


@router.post("/api/documents")
def create_document(payload: CreateDocumentRequest) -> dict[str, Any]:
    try:
        doc = get_co_writer_storage().create_document(
            title=payload.title,
            content=payload.content,
            blocks=payload.blocks,
            parent_id=payload.parent_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return doc.model_dump()


@router.get("/api/documents/{doc_id}")
def get_document(doc_id: str) -> dict[str, Any]:
    doc = get_co_writer_storage().load_document(_doc_id(doc_id))
    if doc is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return doc.model_dump()


@router.put("/api/documents/{doc_id}")
def update_document(doc_id: str, payload: UpdateDocumentRequest) -> dict[str, Any]:
    try:
        doc = get_co_writer_storage().update_document(
            _doc_id(doc_id), **payload.model_dump(exclude_unset=True)
        )
    except RevisionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if doc is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return doc.model_dump()


@router.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str) -> dict[str, bool]:
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    if not storage.doc_exists(page_id):
        raise HTTPException(status_code=404, detail="Page not found")
    deleted = storage.delete_document(page_id)
    return {"deleted": deleted}


@router.get("/api/documents/{doc_id}/backlinks")
def note_backlinks(doc_id: str) -> dict[str, list[dict[str, Any]]]:
    """Pages whose text mentions this page's title or id."""
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    doc = storage.load_document(page_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Page not found")
    needle = (doc.title or "").strip().casefold()
    pages: list[dict[str, Any]] = []
    if len(needle) >= 2:
        for summary in storage.list_documents():
            if summary.id == page_id:
                continue
            other = storage.load_document(summary.id)
            if other is None:
                continue
            body = f"{other.content}\n{json.dumps(other.blocks or [])}".casefold()
            if needle in body or page_id in body:
                pages.append(summary.model_dump())
    return {"pages": pages}


# ── Review queue ─────────────────────────────────────────────────────────


class SuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: str = "insert"
    block_id: str = ""
    markdown: str = Field(default="", max_length=200_000)
    explanation: str = Field(default="", max_length=10_000)
    blocks: list[dict[str, Any]] | None = None
    source_turn_id: str = ""


class ReviewSuggestionRequest(BaseModel):
    accept: bool
    blocks: list[dict[str, Any]] | None = None


@router.get("/api/documents/{doc_id}/suggestions")
def note_suggestions(doc_id: str) -> dict[str, list[dict[str, Any]]]:
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    if not storage.doc_exists(page_id):
        raise HTTPException(status_code=404, detail="Page not found")
    return {"suggestions": list_proposals(storage, page_id)}


@router.post("/api/documents/{doc_id}/suggestions")
def add_note_suggestion(doc_id: str, payload: SuggestionRequest) -> dict[str, Any]:
    try:
        return create_proposal(
            get_co_writer_storage(),
            _doc_id(doc_id),
            operation=payload.operation,
            block_id=payload.block_id,
            markdown=payload.markdown,
            explanation=payload.explanation,
            blocks=payload.blocks,
            source_turn_id=payload.source_turn_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/documents/{doc_id}/suggestions/{suggestion_id}")
def review_note_suggestion(
    doc_id: str, suggestion_id: str, payload: ReviewSuggestionRequest
) -> dict[str, Any]:
    try:
        doc = review_proposal(
            get_co_writer_storage(),
            _doc_id(doc_id),
            suggestion_id,
            accept=payload.accept,
            blocks=payload.blocks,
        )
    except RevisionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return doc.model_dump()


# ── Attachments ──────────────────────────────────────────────────────────

_ASSET_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
}


@router.post("/api/documents/{doc_id}/assets")
async def upload_note_asset(doc_id: str, request: Request, file: UploadFile = File(...)):
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    if not storage.doc_exists(page_id):
        raise HTTPException(status_code=404, detail="Page not found")
    suffix = _ASSET_TYPES.get((file.content_type or "").split(";")[0].strip())
    if suffix is None:
        raise HTTPException(status_code=400, detail="Unsupported attachment type")
    data = await file.read(25 * 1024 * 1024 + 1)
    if not data or len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Attachments must be between 1 byte and 25 MB")
    name = uuid.uuid4().hex + suffix
    storage.save_asset(page_id, name, data, (file.content_type or "").split(";")[0].strip())
    workspace = request.query_params.get("dt_workspace") or ""
    return {
        "url": f"/api/documents/{page_id}/assets/{name}"
        + (f"?dt_workspace={urllib.parse.quote(workspace)}" if workspace else "")
    }


@router.get("/api/documents/{doc_id}/assets/{name}")
def read_note_asset(doc_id: str, name: str):
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    if not re.fullmatch(r"[0-9a-f]{32}\.(png|jpg|webp|gif|mp3|wav|mp4|pdf)", name):
        raise HTTPException(status_code=404, detail="Attachment not found")
    asset = storage.load_asset(page_id, name)
    if asset is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    data, content_type = asset
    return Response(
        data,
        media_type=content_type or "application/octet-stream",
        headers={"X-Content-Type-Options": "nosniff"},
    )


class ClipRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str = Field(default="", max_length=200)
    markdown: str = Field(default="", max_length=200_000)
    source_url: str = Field(default="", max_length=2000)
    source_id: str = Field(default="", max_length=200)
    favorite_type: str = Field(default="", max_length=60)
    summary: str = Field(default="", max_length=200_000)
    favorite_metadata: dict[str, Any] = Field(default_factory=dict)


@router.post("/api/documents/{doc_id}/clips")
def append_note_clip(doc_id: str, payload: ClipRequest) -> dict[str, Any]:
    if not safe_link(payload.source_url):
        raise HTTPException(status_code=400, detail="Unsupported source URL")
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    with storage.locked():
        doc = storage.load_document(page_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if doc.blocks is None:
            doc.blocks = []
        doc.blocks.append(
            {
                "id": uuid.uuid4().hex,
                "type": "clip",
                "props": {
                    "title": payload.title,
                    "markdown": payload.markdown,
                    "sourceUrl": payload.source_url,
                    "sourceId": payload.source_id,
                    "favoriteType": payload.favorite_type,
                    "summary": payload.summary,
                    "metadata": json.dumps(payload.favorite_metadata, ensure_ascii=False),
                    "expanded": False,
                },
                "children": [],
            }
        )
        try:
            validate_blocks(doc.blocks)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        doc.content = blocks_to_markdown(doc.blocks)
        doc.revision += 1
        doc.updated_at = time.time()
        storage._write(doc)
        return doc.model_dump()


# ── Flashcards ───────────────────────────────────────────────────────────


def _anki_response(text: str, filename: str) -> Response:
    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/documents/review/due")
def review_due(limit: int = 200) -> dict[str, list[dict[str, Any]]]:
    return {"cards": due_cards(get_co_writer_storage())[: max(1, min(limit, 500))]}


class GradeCardRequest(BaseModel):
    card_id: str
    remembered: bool = True


@router.post("/api/documents/{doc_id}/review")
def review_card(doc_id: str, payload: GradeCardRequest) -> dict[str, Any]:
    try:
        return grade_review_card(
            get_co_writer_storage(), _doc_id(doc_id), payload.card_id, payload.remembered
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/documents/flashcards/export")
def export_all_flashcards() -> Response:
    cards = cards_from_storage(get_co_writer_storage())
    if not cards:
        raise HTTPException(status_code=404, detail="No flashcards to export")
    return _anki_response(render_anki_export(cards), "deeptutor-flashcards.txt")


@router.get("/api/documents/{doc_id}/flashcards/export")
def export_page_flashcards(doc_id: str) -> Response:
    storage = get_co_writer_storage()
    doc = storage.load_document(_doc_id(doc_id))
    if doc is None:
        raise HTTPException(status_code=404, detail="Page not found")
    cards = list(page_cards(doc))
    if not cards:
        raise HTTPException(status_code=404, detail="No flashcards on this page")
    return _anki_response(
        render_anki_export(cards), f"deeptutor-{(doc.title or 'page')[:40]}.txt"
    )


# ── DOCX interchange ─────────────────────────────────────────────────────


class ExportDocxRequest(BaseModel):
    title: str = ""
    content: str = Field(default="", max_length=_MAX_DOC_CHARS)


def _docx_filename(title: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', "-", (title or "note").strip())[:80].strip(" .")
    return f"{(safe or 'note')}.docx"


@router.post("/api/documents/export/docx")
def export_docx(payload: ExportDocxRequest) -> Response:
    from ..services.documents.docx import DocxConversionError, markdown_to_docx

    try:
        data = markdown_to_docx(payload.content, title=payload.title)
    except DocxConversionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{_docx_filename(payload.title)}"'},
    )


@router.post("/api/documents/import/docx")
async def import_docx(file: UploadFile = File(...)) -> dict[str, Any]:
    from ..services.documents.docx import DocxConversionError, docx_to_markdown

    data = await file.read(40 * 1024 * 1024 + 1)
    if not data or len(data) > 40 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Documents must be between 1 byte and 40 MB")
    try:
        markdown = docx_to_markdown(data, filename=file.filename or "document.docx")
    except DocxConversionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    title = re.sub(r"\.docx$", "", file.filename or "", flags=re.I) or "Imported document"
    return get_co_writer_storage().create_document(title=title, content=markdown).model_dump()


# ── Conversations anchored to a line ─────────────────────────────────────


def _thread_fields(
    thread: dict[str, Any], session: dict[str, Any] | None
) -> dict[str, Any] | None:
    """A page anchor joined with its conversation's session state.

    The anchor only stores where the conversation lives. Title, status and
    the last message come from the chat session, so a thread whose session was
    deleted has nothing to show and is left out.
    """
    if session is None:
        return None
    messages = session.get("messages") or []
    last = messages[-1] if messages else {}
    turns = session.get("turns") or {}
    running = any(
        isinstance(turn, dict) and turn.get("status") == "running" for turn in turns.values()
    )
    return {
        **thread,
        "title": str(session.get("title") or ""),
        "status": "running" if running else str(session.get("status") or "idle"),
        "updated_at": (
            session.get("updated_at")
            or thread.get("updated_at")
            or thread.get("created_at")
            or 0.0
        ),
        "message_count": len(messages),
        "last_message": str(last.get("content") or "")[:400],
    }


@router.get("/api/documents/{doc_id}/threads")
def list_note_threads(doc_id: str, request: Request) -> dict[str, list[dict[str, Any]]]:
    storage = get_co_writer_storage()
    page_id = _doc_id(doc_id)
    if not storage.doc_exists(page_id):
        raise HTTPException(status_code=404, detail="Page not found")
    store = getattr(request.app.state, "store", None)
    rows = []
    for thread in thread_store.list_threads(storage, page_id):
        session = store.get(thread.get("session_id", "")) if store is not None else None
        row = _thread_fields(thread, session)
        if row is not None:
            rows.append(row)
    return {"threads": rows}


class AnchorThreadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=1, max_length=200)
    block_id: str = Field(default="", max_length=100)
    quote: str = Field(default="", max_length=2000)
    origin: str = "ask"


@router.post("/api/documents/{doc_id}/threads")
def anchor_note_thread(doc_id: str, payload: AnchorThreadRequest) -> dict[str, Any]:
    try:
        return thread_store.anchor(
            get_co_writer_storage(),
            _doc_id(doc_id),
            session_id=payload.session_id,
            block_id=payload.block_id,
            quote=payload.quote,
            origin=payload.origin,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/api/documents/{doc_id}/threads/{session_id}")
def delete_note_thread(doc_id: str, session_id: str) -> dict[str, bool]:
    return {
        "deleted": thread_store.remove(get_co_writer_storage(), _doc_id(doc_id), session_id)
    }


__all__ = ["router", "CoWriterDocument"]
