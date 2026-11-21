"""Knowledge-base agent tools backed by ``KnowledgeBaseStore`` (BM25 retrieval).

Mirrors DeepTutor's ``rag`` / ``kb_files`` / ``read_source`` tools closely
enough for the model to cite sources; the ``knowledge_bases`` turn field
selects which KBs are in scope (empty = all).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field
from vtx.agent.tools.base import BaseTool
from vtx.protocol.types import ToolResult

from ..config import Settings
from ..store.kb_store import KnowledgeBaseStore

_store: KnowledgeBaseStore | None = None


def _kb() -> KnowledgeBaseStore:
    global _store
    if _store is None:
        _store = KnowledgeBaseStore(Settings())
    return _store


def _scoped_kbs(command_kbs: list[str] | None) -> list[str]:
    all_kbs = [k["name"] for k in _kb().list()]
    if not all_kbs:
        return []
    if command_kbs:
        return [k for k in command_kbs if k in all_kbs]
    return all_kbs


class KnowledgeBaseSearchParams(BaseModel):
    action: Literal["search", "files", "read"] = Field(
        default="search",
        description=(
            "search = retrieve passages for query; files = list documents "
            "in the knowledge bases; read = full text of one document "
            "(needs kb_name + doc)."
        ),
    )
    query: str = Field(
        default="", description="Search query — search only."
    )
    knowledge_bases: str = Field(
        default="",
        description="Comma-separated KB names to scope — search/files; empty = all.",
    )
    top_k: int = Field(default=5, description="Passages per KB — search only.")
    kb_name: str = Field(
        default="", description="KB name — read only."
    )
    doc: str = Field(
        default="", description="Document filename from files — read only."
    )


class KnowledgeBaseSearchTool(BaseTool):
    name = "knowledge_base_search"
    tool_icon = "📚"
    params = KnowledgeBaseSearchParams
    mutating = False
    description = (
        "Search the user's knowledge bases: retrieve relevant passages, "
        "list indexed documents, or read one document's full text."
    )

    async def execute(
        self, params: KnowledgeBaseSearchParams, cancel_event: Any = None
    ) -> ToolResult:
        names = [n.strip() for n in params.knowledge_bases.split(",") if n.strip()] or None
        kbs = _scoped_kbs(names)

        if params.action == "files":
            if not kbs:
                return _ok("No knowledge bases configured.")
            out = []
            for name in kbs:
                docs = _kb().list_documents(name)
                out.append(f"KB '{name}': " + (", ".join(d["name"] for d in docs) if docs else "(empty)"))
            return _ok("\n".join(out))

        if params.action == "read":
            text = _kb().read_source(params.kb_name, params.doc)
            return _ok(text if text else f"No indexed content for {params.doc!r} in KB {params.kb_name!r}.")

        if not params.query:
            return _fail("knowledge_base_search needs a query (action='search').")
        if not kbs:
            return _ok("No knowledge bases configured.")
        out = []
        for name in kbs:
            hits = _kb().search(name, params.query, top_k=params.top_k)
            for h in hits:
                out.append(f"[KB: {name} | source: {h['doc']} | chunk: {h['id']}]\n{h['text']}")
        return _ok("\n\n---\n\n".join(out) if out else "No relevant passages found.")


def _ok(text: str) -> ToolResult:
    return ToolResult(success=True, result=text)


def _fail(text: str) -> ToolResult:
    return ToolResult(success=False, result=text)


knowledge_base_search = KnowledgeBaseSearchTool()
