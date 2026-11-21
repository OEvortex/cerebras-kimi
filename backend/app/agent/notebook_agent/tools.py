"""The notebook writer's tool surface.

The writer's *output* is the notebook: its final message is a notebook
document (see ``document.py``) that the host compiles into pages, so it needs
no write tools at all. What remains is navigation — finding existing pages so
the document can extend them instead of duplicating — plus ``nb_update_page``
for retitling/reparenting after the fact, and the shared research tools.

These tools are registered into vtx's global tool registry (not the main
agent's explicit tool list) so a ``SubagentSpec`` can select exactly them via
``tools_allow``.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from vtx.agent.tools.base import BaseTool
from vtx.protocol.types import ToolResult

from ...services.documents.blocks import blocks_to_markdown, walk_blocks
from ...services.documents.storage import get_co_writer_storage


def _ok(text: str) -> ToolResult:
    return ToolResult(success=True, result=text)


def _fail(text: str) -> ToolResult:
    return ToolResult(success=False, result=text)


def _storage():
    return get_co_writer_storage()


# ---------------------------------------------------------------------------
# Params + tools
# ---------------------------------------------------------------------------


class NbReadParams(BaseModel):
    page_id: str = Field(description="Page id to read.")
    max_chars: int = Field(default=20000, description="Maximum characters to return.")


class NbReadTool(BaseTool):
    name = "nb_read"
    tool_icon = "📖"
    params = NbReadParams
    mutating = False
    description = (
        "Read a notebook page by id: title, block outline and Markdown. Use "
        "before writing about a topic the learner may already have notes on."
    )

    async def execute(
        self, params: NbReadParams, cancel_event: Any = None
    ) -> ToolResult:
        doc = _storage().load_document(params.page_id.strip())
        if doc is None:
            return _fail("No notebook page with that id.")
        lines = [f"Title: {doc.title}", f"Id: {doc.id}"]
        if doc.parent_id:
            lines.append(f"Parent: {doc.parent_id}")
        if doc.blocks:
            for block in walk_blocks(doc.blocks):
                text = " ".join(
                    str(b.get("text", "")) for b in block.get("content", [])
                    if isinstance(b, dict)
                )
                lines.append(
                    f"{block.get('id')} | {block.get('type')} | {text[:160]}"
                )
            body = blocks_to_markdown(doc.blocks)
        else:
            body = doc.content
        return _ok("\n".join(lines) + "\n\n--- Markdown ---\n" + body[:params.max_chars])


class NbListParams(BaseModel):
    query: str = Field(default="", description="Case-insensitive title substring.")
    limit: int = Field(default=40, description="Maximum pages to return.")


class NbListTool(BaseTool):
    name = "nb_list"
    tool_icon = "📚"
    params = NbListParams
    mutating = False
    description = "List notebook pages (id | title | parent), optionally filtered."

    async def execute(
        self, params: NbListParams, cancel_event: Any = None
    ) -> ToolResult:
        needle = params.query.strip().lower()
        rows = []
        for summary in _storage().list_documents():
            title = summary.title or "Untitled"
            if needle and needle not in title.lower():
                continue
            parent = f" <- {summary.parent_id}" if summary.parent_id else ""
            rows.append(f"{summary.id} | {title}{parent}")
            if len(rows) >= max(1, min(params.limit, 200)):
                break
        return _ok("\n".join(rows) if rows else "No matching notebook pages.")


class NbSearchParams(BaseModel):
    query: str = Field(description="Text to find in page titles or content.")
    limit: int = Field(default=10, description="Maximum pages to return.")


class NbSearchTool(BaseTool):
    name = "nb_search"
    tool_icon = "🔎"
    params = NbSearchParams
    mutating = False
    description = "Search notebook pages by title and body text."

    async def execute(
        self, params: NbSearchParams, cancel_event: Any = None
    ) -> ToolResult:
        needle = params.query.strip().lower()
        if not needle:
            return _fail("nb_search needs a query.")
        storage = _storage()
        hits = []
        for summary in storage.list_documents():
            doc = storage.load_document(summary.id)
            if doc is None:
                continue
            haystack = f"{doc.title}\n{doc.content}".lower()
            index = haystack.find(needle)
            if index < 0:
                continue
            snippet = doc.content[max(0, index - 80):index + 200].replace("\n", " ")
            hits.append(f"[{doc.id}] {doc.title} …{snippet}…")
            if len(hits) >= max(1, min(params.limit, 50)):
                break
        return _ok("\n\n".join(hits) if hits else "No matching notebook pages.")


class NbUpdatePageParams(BaseModel):
    page_id: str = Field(description="Page id to update.")
    title: str = Field(default="", description="New title; empty keeps the current one.")
    parent_id: str = Field(
        default="",
        description="New parent page id; empty string keeps the current parent.",
    )


class NbUpdatePageTool(BaseTool):
    name = "nb_update_page"
    tool_icon = "🛠️"
    params = NbUpdatePageParams
    mutating = True
    description = "Rename a page or move it under a different parent page."

    async def execute(
        self, params: NbUpdatePageParams, cancel_event: Any = None
    ) -> ToolResult:
        storage = _storage()
        doc = storage.load_document(params.page_id.strip())
        if doc is None:
            return _fail("No notebook page with that id.")
        metadata: dict[str, Any] = {}
        if params.parent_id.strip():
            metadata["parent_id"] = params.parent_id.strip()
        try:
            updated = storage.update_document(
                doc.id,
                title=params.title.strip() or None,
                **metadata,
            )
        except ValueError as exc:
            return _fail(f"Could not update the page: {exc}")
        if updated is None:
            return _fail("No notebook page with that id.")
        return _ok(f'Updated page "{updated.title}" ({updated.id}).')


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

nb_read = NbReadTool()
nb_list = NbListTool()
nb_search = NbSearchTool()
nb_update_page = NbUpdatePageTool()

NB_OWN_TOOL_NAMES = (
    "nb_read",
    "nb_list",
    "nb_search",
    "nb_update_page",
)

# Research tools the writer may also use. They are DeepTutor tools registered
# under their usual names; "web" intentionally overrides vtx's built-in web
# tool inside the sub-agent registry (the main agent's tools are unaffected —
# they come from an explicit list, not this registry).
SHARED_TOOL_NAMES = ("web", "paper_search", "knowledge_base_search")

WRITER_TOOL_NAMES = NB_OWN_TOOL_NAMES + SHARED_TOOL_NAMES

_registered = False


def writer_tools() -> list[BaseTool]:
    return [nb_read, nb_list, nb_search, nb_update_page]


def shared_tools() -> list[BaseTool]:
    from .. import dt_tools
    from .. import kb_tools

    return [dt_tools.web, dt_tools.paper_search, kb_tools.knowledge_base_search]


def register_writer_tools() -> None:
    """Put the writer's tools into vtx's global registry (idempotent).

    ``SubagentSpec.tools_allow`` only resolves names found in
    ``get_all_tools()``, so the ``nb_*`` tools — and the shared research
    tools — must live there before dispatch.
    """
    global _registered
    if _registered:
        return
    from vtx.agent.tools import register_tool

    for tool_ in writer_tools() + shared_tools():
        register_tool(tool_)
    _registered = True


__all__ = [
    "NB_OWN_TOOL_NAMES",
    "SHARED_TOOL_NAMES",
    "WRITER_TOOL_NAMES",
    "nb_list",
    "nb_read",
    "nb_search",
    "nb_update_page",
    "register_writer_tools",
    "shared_tools",
    "writer_tools",
]
