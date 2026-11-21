"""Co-writer's tool surface, shared by the notebook chat and the sub-agent.

Co-writer's output is the notebook itself: pages are edited directly with
``nb_patch`` (create/update/delete/move), and ``nb_read``/``nb_list``/
``nb_search`` keep it from duplicating existing notes. The shared research
tools cover outside material. The same list is used by the sub-agent the main
assistant dispatches through its ``notebook`` tool.

These tools are registered into vtx's global tool registry (not the main
agent's explicit tool list) so a ``SubagentSpec`` can select exactly them via
``tools_allow``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field
from vtx.agent.tools.base import BaseTool
from vtx.protocol.types import ToolResult

from ...services.documents.blocks import (
    blocks_to_markdown,
    coarse_markdown_to_blocks,
    walk_blocks,
)
from ...services.documents.storage import (
    RevisionConflict,
    get_co_writer_storage,
)


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
    offset: int | None = Field(
        default=None, description="Start line of the Markdown body (1-based)."
    )
    limit: int | None = Field(
        default=None, description="Number of body lines to return."
    )


class NbReadTool(BaseTool):
    name = "nb_read"
    tool_icon = "📖"
    params = NbReadParams
    mutating = False
    description = (
        "Read a notebook page by id: title, block outline and Markdown body. "
        "Use offset/limit to paginate large pages. Use before writing about "
        "a topic the learner may already have notes on."
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
            body = doc.content or ""
        body_lines = body.splitlines()
        total = len(body_lines)
        start = max(1, params.offset or 1)
        end = total if params.limit is None else min(total, start + params.limit - 1)
        if start > total:
            return _ok("\n".join(lines) + f"\n\n--- Markdown (lines 1-{total} of {total}) ---\n")
        window = "\n".join(body_lines[start - 1:end])
        range_note = f"lines {start}-{end} of {total}"
        if end < total:
            range_note += f" — call again with offset={end + 1} for more"
        return _ok(
            "\n".join(lines)
            + f"\n\n--- Markdown ({range_note}) ---\n"
            + window
        )


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


# ---------------------------------------------------------------------------
# nb_patch — atomic multi-op page edits (apply_patch style)
# ---------------------------------------------------------------------------


class NbPatchEdit(BaseModel):
    old: str = Field(description="Exact text to replace (must match incl. whitespace).")
    new: str = Field(description="Replacement text (must differ from old).")
    replace_all: bool = Field(
        default=False, description="Replace all occurrences (default: first only)."
    )


class NbPatchOp(BaseModel):
    op: Literal["update", "create", "delete", "move"] = Field(
        description="update edits a page's Markdown, create makes a page, "
        "delete removes one, move reparents/renames."
    )
    page: str = Field(
        default="", description="Page id or title — required for update/delete/move."
    )
    edits: list[NbPatchEdit] | None = Field(
        default=None, description="Batch of exact-match edits for one 'update' op."
    )
    old: str | None = Field(default=None, description="Single edit: text to replace.")
    new: str | None = Field(default=None, description="Single edit: replacement text.")
    replace_all: bool = Field(default=False)
    content: str | None = Field(
        default=None,
        description="Full Markdown body — for 'create', or full rewrite on 'update'.",
    )
    append: str | None = Field(
        default=None, description="Markdown to append to the page body ('update' only)."
    )
    parent: str | None = Field(
        default=None,
        description="Parent page id/title — for 'create' and 'move'.",
    )
    new_title: str | None = Field(
        default=None, description="New title — for 'move' (rename) ops."
    )


class NbPatchParams(BaseModel):
    ops: list[NbPatchOp] = Field(
        description="Page operations applied in order. Every op is validated "
        "before anything is written; one failure aborts the whole patch."
    )


def _resolve_page(storage: Any, ref: str):
    ref = (ref or "").strip()
    if not ref:
        return None
    doc = storage.load_document(ref)
    if doc is not None:
        return doc
    needle = ref.lower()
    matches = [
        d
        for d in (storage.load_document(s.id) for s in storage.list_documents())
        if d is not None and (d.title or "").strip().lower() == needle
    ]
    if len(matches) == 1:
        return matches[0]
    partial = [
        d
        for d in (storage.load_document(s.id) for s in storage.list_documents())
        if d is not None and needle in (d.title or "").lower()
    ]
    return partial[0] if len(partial) == 1 else None


def _page_markdown(doc: Any) -> str:
    if doc.blocks:
        return blocks_to_markdown(doc.blocks)
    return doc.content or ""


def _apply_text_edits(body: str, edits: list[NbPatchEdit]) -> tuple[str | None, str | None]:
    for edit in edits:
        if edit.old == edit.new:
            return None, "old and new must differ."
        count = body.count(edit.old)
        if count == 0:
            return None, f"old_string not found: {edit.old[:80]!r}"
        if not edit.replace_all and count > 1:
            return (
                None,
                f"old_string matches {count} places; add more context or set replace_all.",
            )
        body = body.replace(edit.old, edit.new, -1 if edit.replace_all else 1)
    return body, None


class NbPatchTool(BaseTool):
    name = "nb_patch"
    tool_icon = "🩹"
    params = NbPatchParams
    mutating = True
    description = (
        "Apply page edits atomically, apply_patch style. ops: 'update' (page + "
        "edits[] or old/new/replace_all — exact-match Markdown edits), 'create' "
        "(page = new page title, content = body, parent = parent page title/id), "
        "'delete' (page), 'move' (page + parent and/or new_title). All ops are "
        "validated first; any failure writes nothing. Pages created earlier in "
        "the same patch can be referenced by title."
    )

    async def execute(
        self, params: NbPatchParams, cancel_event: Any = None
    ) -> ToolResult:
        storage = _storage()

        # Virtual pages let later ops reference pages created earlier in the
        # same patch (create hub, then children under it, then edit them).
        # key: lowercase title -> {"op", "content", "parent", "deleted"}
        virtual: dict[str, dict[str, Any]] = {}

        def resolve(ref: str) -> tuple[str, Any] | None:
            doc = _resolve_page(storage, ref)
            if doc is not None:
                return ("real", doc)
            entry = virtual.get((ref or "").strip().lower())
            return ("virtual", entry) if entry else None

        def resolve_parent(ref: str) -> tuple[str, Any] | None:
            return resolve(ref)

        # Pass 1: validate everything, building the plan + virtual overlay.
        plan: list[tuple[NbPatchOp, Any]] = []
        errors: list[str] = []
        for index, op in enumerate(params.ops):
            tag = f"op{index + 1}({op.op})"
            try:
                if op.op == "create":
                    title = (op.page or "").strip()
                    if not title:
                        errors.append(f"{tag}: create needs a title in 'page'.")
                        continue
                    parent = None
                    if op.parent:
                        parent = resolve_parent(op.parent)
                        if parent is None:
                            errors.append(
                                f"{tag}: parent page not found: {op.parent!r}"
                            )
                            continue
                    entry = {
                        "op": op,
                        "title": title,
                        "content": op.content or "",
                        "parent": parent,
                        "deleted": False,
                    }
                    virtual[title.lower()] = entry
                    plan.append((op, entry))
                    continue

                hit = resolve(op.page)
                if hit is None:
                    errors.append(f"{tag}: page not found: {op.page!r}")
                    continue
                kind, target = hit

                if op.op == "update":
                    edits = list(op.edits or [])
                    if op.old is not None or op.new is not None:
                        if op.old is None or op.new is None:
                            errors.append(
                                f"{tag}: old and new must be given together."
                            )
                            continue
                        edits.insert(
                            0,
                            NbPatchEdit(
                                old=op.old, new=op.new, replace_all=op.replace_all
                            ),
                        )
                    body = (
                        _page_markdown(target)
                        if kind == "real"
                        else target["content"]
                    )
                    if op.content is not None:
                        new_body = op.content
                    elif op.append is not None:
                        new_body = body.rstrip() + "\n\n" + op.append
                    else:
                        if not edits:
                            errors.append(
                                f"{tag}: update needs edits[] or old/new."
                            )
                            continue
                        new_body, err = _apply_text_edits(body, edits)
                        if err:
                            errors.append(f"{tag}: {err}")
                            continue
                    if kind == "virtual":
                        target["content"] = new_body
                    plan.append((op, (kind, target, new_body)))
                elif op.op == "move":
                    parent = None
                    has_parent = op.parent is not None
                    if has_parent and op.parent.strip():
                        parent = resolve_parent(op.parent)
                        if parent is None:
                            errors.append(
                                f"{tag}: parent page not found: {op.parent!r}"
                            )
                            continue
                    if kind == "virtual":
                        target["parent"] = parent if has_parent else target["parent"]
                        if op.new_title:
                            target["title"] = op.new_title.strip()
                    plan.append((op, (kind, target, parent)))
                else:  # delete
                    if kind == "virtual":
                        target["deleted"] = True
                    plan.append((op, (kind, target, None)))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{tag}: {exc}")
        if errors:
            return _fail("Patch aborted — nothing was written:\n" + "\n".join(errors))

        # Pass 2: write in order, tracking created pages for parent refs.
        created: dict[str, Any] = {}
        results: list[str] = []

        def parent_id_of(parent: Any) -> str | None:
            if parent is None:
                return None
            kind, target = parent
            if kind == "real":
                return target.id
            return created.get(target["title"].lower())

        for op, target in plan:
            try:
                if op.op == "create":
                    if target["deleted"]:
                        continue
                    doc = storage.create_document(
                        title=target["title"] or None,
                        content=target["content"],
                        parent_id=parent_id_of(target["parent"]),
                    )
                    created[target["title"].lower()] = doc.id
                    results.append(f'created "{doc.title}" ({doc.id})')
                    continue
                kind, doc_or_entry, payload = target
                if kind == "virtual":
                    continue  # folded into its create op
                doc = doc_or_entry
                if op.op == "update":
                    for _attempt in range(2):
                        try:
                            storage.update_document(
                                doc.id,
                                blocks=coarse_markdown_to_blocks(payload),
                                expected_revision=doc.revision,
                            )
                            break
                        except RevisionConflict:
                            fresh = storage.load_document(doc.id)
                            if fresh is None:
                                raise ValueError("page vanished mid-patch")
                            doc = fresh
                    results.append(f'updated "{doc.title}" ({doc.id})')
                elif op.op == "move":
                    kwargs: dict[str, Any] = {}
                    if op.new_title:
                        kwargs["title"] = op.new_title
                    if op.parent is not None:
                        kwargs["parent_id"] = parent_id_of(payload)
                    if kwargs:
                        storage.update_document(doc.id, **kwargs)
                    results.append(f'moved "{doc.title}" ({doc.id})')
                else:
                    storage.delete_document(doc.id)
                    results.append(f'deleted "{doc.title}" ({doc.id})')
            except Exception as exc:  # noqa: BLE001
                return _fail(
                    "Patch failed partway:\n"
                    + "\n".join(results)
                    + f"\nerror: {exc}"
                )
        return _ok("Patch applied:\n" + "\n".join(f"- {r}" for r in results))

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

nb_read = NbReadTool()
nb_list = NbListTool()
nb_search = NbSearchTool()
nb_patch = NbPatchTool()

NB_OWN_TOOL_NAMES = (
    "nb_read",
    "nb_list",
    "nb_search",
    "nb_patch",
)

# Research tools the writer may also use. They are DeepTutor tools registered
# under their usual names; "web" intentionally overrides vtx's built-in web
# tool inside the sub-agent registry (the main agent's tools are unaffected —
# they come from an explicit list, not this registry).
SHARED_TOOL_NAMES = ("web", "paper_search", "knowledge_base_search")

WRITER_TOOL_NAMES = NB_OWN_TOOL_NAMES + SHARED_TOOL_NAMES

# The Co-writer agent uses exactly this tool list, both as the sub-agent
# dispatched by the main assistant and as the companion in the notebook chat.
COWRITER_TOOL_NAMES = WRITER_TOOL_NAMES

_registered = False


def writer_tools() -> list[BaseTool]:
    return [
        nb_read,
        nb_list,
        nb_search,
        nb_patch,
    ]


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
    "register_writer_tools",
    "shared_tools",
    "writer_tools",
]
