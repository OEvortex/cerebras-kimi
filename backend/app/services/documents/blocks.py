"""Validate portable BlockNote JSON and derive a read-only Markdown projection."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .noteui import NoteUIError, block_to_dsl, compile_noteui, parse_inline_md

MAX_BLOCK_BYTES = 4 * 1024 * 1024

# Fenced-block info strings that become ``learning`` blocks (info -> props.kind).
# Keep in sync with ``web/features/notes/model/markdown.ts``.
FENCE_LEARNING_KINDS = {
    "quiz": "quiz",
    "flashcards": "flashcards",
    "flashcard": "flashcards",
    "timeline": "timeline",
    "conceptmap": "concept_map",
    "concept_map": "concept_map",
    "geogebra": "geogebra",
    "research": "research",
    "task": "task",
}
DIAGRAM_FENCES = frozenset({"mermaid", "flow", "seq"})
# ```noteui fences hold a NoteUI Lang program (see noteui.py) compiled to blocks.
NOTEUI_FENCES = frozenset({"noteui", "nb", "note"})
_KIND_FENCES = {
    "quiz": "quiz",
    "flashcards": "flashcards",
    "timeline": "timeline",
    "concept_map": "conceptmap",
    "geogebra": "geogebra",
    "research": "research",
    "task": "task",
}
_FENCE_OPEN = re.compile(r"^\s*(`{3,}|~{3,})(\S*)\s*$")

# Blocks with no inline content of their own (BlockNote ``content: "none"``).
LEAF_BLOCK_TYPES = frozenset(
    {
        "learning",
        "noteUpload",
        "clip",
        "math",
        "divider",
        "image",
        "video",
        "audio",
        "file",
        "noteColumn",
        "noteColumns",
        "tableOfContents",
        "webCard",
        "htmlEmbed",
        "taskView",
    }
)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _text_block(type_: str, text: str, props: dict | None = None) -> dict:
    return {
        "id": _new_id(),
        "type": type_,
        "props": props or {},
        "content": parse_inline_md(text),
        "children": [],
    }


def _fence_learning_block(info: str, body: str, source: str) -> dict:
    """Build the ``learning`` block the browser makes from a fenced block."""
    kind = FENCE_LEARNING_KINDS.get(info)
    if kind is None:
        kind = "mermaid" if info == "mermaid" else "legacy_diagram"
    data = "{}"
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            data = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        pass
    return {
        "id": _new_id(),
        "type": "learning",
        "props": {
            "kind": kind,
            # Structured fences keep their JSON body; diagrams keep the whole
            # fence because their Markdown renderer understands the delimiters.
            "markdown": body if kind in FENCE_LEARNING_KINDS.values() else source,
            "prompt": "",
            "data": data,
            "sourceUrl": "",
        },
        "children": [],
    }


def _html_embed_block(source: str) -> dict:
    return {"id": _new_id(), "type": "htmlEmbed", "props": {"source": source}, "children": []}


def _parse_table_row(line: str) -> list[str] | None:
    stripped = line.strip()
    if "|" not in stripped:
        return None
    cells = [c.strip() for c in stripped.strip("|").split("|")]
    return cells or None


def _is_table_sep(line: str) -> bool:
    cells = _parse_table_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells)


def coarse_markdown_to_blocks(content: str) -> list[dict[str, Any]]:
    """Markdown (plus ```noteui / learning fences) -> BlockNote blocks.

    Used when a page must be edited through ``nb_patch``: the model's Markdown
    body becomes real blocks so rich content survives the round trip. It is a
    pragmatic parser, not a full CommonMark implementation — the editor still
    owns exotic conversions.
    """
    blocks: list[dict[str, Any]] = []
    paragraph: list[str] = []
    lines = content.splitlines()

    def flush() -> None:
        if paragraph:
            text = "\n".join(paragraph).strip()
            paragraph.clear()
            if text:
                blocks.append(_text_block("paragraph", text))

    index = 0
    while index < len(lines):
        line = lines[index]
        fence = _FENCE_OPEN.match(line)
        if fence:
            marker = fence.group(1)
            info = fence.group(2)
            close = re.compile(r"^\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$")
            end = index + 1
            while end < len(lines) and not close.match(lines[end]):
                end += 1
            if end < len(lines):
                body = "\n".join(lines[index + 1 : end])
                source = "\n".join(lines[index : end + 1])
                flush()
                if info in NOTEUI_FENCES:
                    try:
                        blocks.extend(compile_noteui(body))
                    except NoteUIError as exc:
                        blocks.append(
                            _text_block(
                                "paragraph",
                                f"```{info}\n{body}\n```\n\n(noteui compile failed: {exc})",
                            )
                        )
                elif info in FENCE_LEARNING_KINDS or info in DIAGRAM_FENCES:
                    blocks.append(_fence_learning_block(info, body, source))
                elif info == "html":
                    blocks.append(_html_embed_block(body))
                else:
                    blocks.append(
                        _blk_code(info, body)
                    )
                index = end + 1
                continue
            # Unterminated fence: treat the rest as literal lines.
        stripped = line.strip()
        if not stripped:
            flush()
            index += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            flush()
            blocks.append(
                _text_block("heading", heading.group(2), {"level": len(heading.group(1))})
            )
            index += 1
            continue
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
            flush()
            blocks.append({"id": _new_id(), "type": "divider", "props": {}, "children": []})
            index += 1
            continue
        # Pipe table: header row followed by a |---| separator row.
        if "|" in stripped and index + 1 < len(lines) and _is_table_sep(lines[index + 1]):
            flush()
            header = _parse_table_row(stripped) or []
            rows = [[{"type": "text", "text": c, "styles": {}} for c in header]]
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                cells = _parse_table_row(lines[index]) or []
                rows.append([{"type": "text", "text": c, "styles": {}} for c in cells])
                index += 1
            blocks.append(
                {
                    "id": _new_id(),
                    "type": "table",
                    "props": {},
                    "content": {"rows": [{"cells": r} for r in rows]},
                    "children": [],
                }
            )
            continue
        # Blockquote: consecutive "> " lines.
        if stripped.startswith(">"):
            flush()
            quote_lines = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote_lines.append(lines[index].strip().lstrip(">").strip())
                index += 1
            blocks.append(_text_block("quote", "\n".join(quote_lines)))
            continue
        task = re.match(r"^[-*+]\s+\[([ xX])\]\s+(.*)$", stripped)
        bullet = re.match(r"^[-*+]\s+(.*)$", stripped)
        numbered = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if task or bullet or numbered:
            flush()
            if task:
                blocks.append(
                    _text_block(
                        "checkListItem",
                        task.group(2),
                        {"checked": task.group(1).lower() == "x"},
                    )
                )
            elif bullet:
                blocks.append(_text_block("bulletListItem", bullet.group(1)))
            else:
                blocks.append(_text_block("numberedListItem", numbered.group(1)))
            index += 1
            continue
        # Display math on its own line(s): $$...$$
        if stripped.startswith("$$"):
            if stripped.endswith("$$") and len(stripped) > 4:
                formula = stripped[2:-2].strip()
                flush()
                blocks.append(
                    {"id": _new_id(), "type": "mathBlock", "props": {}, "content": formula, "children": []}
                )
                index += 1
                continue
            end = index + 1
            while end < len(lines) and not lines[end].strip().endswith("$$"):
                end += 1
            if end < len(lines):
                formula = "\n".join(lines[index + 1 : end])
                flush()
                blocks.append(
                    {"id": _new_id(), "type": "mathBlock", "props": {}, "content": formula.strip(), "children": []}
                )
                index = end + 1
                continue
        paragraph.append(stripped)
        index += 1
    flush()
    return blocks


def _blk_code(language: str, code: str) -> dict:
    return {
        "id": _new_id(),
        "type": "codeBlock",
        "props": {"language": language},
        "content": [{"type": "text", "text": code, "styles": {}}],
        "children": [],
    }


# A URI scheme is a leading ``name:`` token. Only these may navigate away from
# the app; everything else (javascript:, data:, file:, …) is page-provided code
# or an unsupported target and must never reach a rendered ``href``.
_ALLOWED_URI_SCHEMES = frozenset({"http", "https", "mailto"})
_URI_SCHEME = re.compile(r"^([a-z][a-z0-9+.-]*):", re.I)
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def safe_link(value: str) -> bool:
    """Only links the editor can display without executing page-provided code.

    Absolute http(s)/mailto URLs, root-relative paths and fragments are safe.
    Plain relative paths are safe too: they resolve against the app origin and
    carry no scheme, so a notebook's ``[Lasers](Lasers)`` cross-reference does
    not break saving. Executable schemes, protocol-relative ``//host`` URLs and
    control characters (which browsers can fold into a scheme) are rejected.
    """
    if not isinstance(value, str):
        return False
    if not value:
        return True
    if _CONTROL_CHARS.search(value) or value.startswith("//"):
        return False
    scheme = _URI_SCHEME.match(value)
    if scheme:
        return scheme.group(1).lower() in _ALLOWED_URI_SCHEMES
    return True


def validate_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(json.dumps(blocks, ensure_ascii=False).encode()) > MAX_BLOCK_BYTES:
        raise ValueError("Page exceeds the 4 MB block limit")
    ids: set[str] = set()

    def inline(items, depth=0):
        if depth > 16:
            raise ValueError("Inline nesting exceeds 16 levels")
        if isinstance(items, str):
            return
        if not isinstance(items, list):
            raise ValueError("Invalid inline content")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Invalid inline content")
            kind = item.get("type")
            if kind == "text":
                if not isinstance(item.get("text"), str) or not isinstance(
                    item.get("styles", {}), dict
                ):
                    raise ValueError("Invalid styled text")
            elif kind == "link":
                if not safe_link(item.get("href")):
                    raise ValueError("Unsupported link URL")
                inline(item.get("content", []), depth + 1)
            elif kind == "math":
                inline(item.get("content", []), depth + 1)
            elif kind in {"pageLink", "inlineMath", "noteDate"}:
                props = item.get("props", {})
                if not isinstance(props, dict) or any(
                    not isinstance(v, str) for v in props.values()
                ):
                    raise ValueError("Invalid inline properties")
                if kind == "pageLink" and not re.fullmatch(
                    r"[0-9a-f]{8,32}", props.get("pageId", "")
                ):
                    raise ValueError("Invalid linked page ID")
            else:
                raise ValueError("Unsupported inline content")

    def visit(items, depth=0, parent=None):
        if not isinstance(items, list) or depth > 16:
            raise ValueError("Invalid block tree or nesting exceeds 16 levels")
        for block in items:
            if not isinstance(block, dict):
                raise ValueError("Each block must be an object")
            bid = block.get("id")
            if not isinstance(bid, str) or not re.fullmatch(r"[\w-]{1,128}", bid) or bid in ids:
                raise ValueError("Blocks require unique, valid IDs")
            ids.add(bid)
            if len(ids) > 10000:
                raise ValueError("Page exceeds 10000 blocks")
            supported = {
                "paragraph",
                "heading",
                "bulletListItem",
                "numberedListItem",
                "checkListItem",
                "toggleListItem",
                "quote",
                "codeBlock",
                "table",
                "image",
                "video",
                "audio",
                "file",
                "divider",
                "math",
                "mathBlock",
                "clip",
                "learning",
                "noteUpload",
                "callout",
                "toggleHeading",
                "noteColumn",
                "noteColumns",
                "tableOfContents",
                "webCard",
                "htmlEmbed",
                "taskView",
            }
            if block.get("type") not in supported:
                raise ValueError("Unsupported block type")
            if not isinstance(block.get("type"), str) or not isinstance(
                block.get("props", {}), dict
            ):
                raise ValueError("Invalid block type or properties")
            if block["type"] == "noteColumn" and parent != "noteColumns":
                raise ValueError("Column blocks must belong to a columns layout")
            props = block.get("props", {})
            if any(not isinstance(v, (str, int, float, bool)) for v in props.values()):
                raise ValueError("Block properties must be scalar values")
            for name in ("url", "sourceUrl"):
                if name in props and not safe_link(props[name]):
                    raise ValueError("Unsupported block URL")
            if block["type"] in {"heading", "toggleHeading"} and props.get("level", 1) not in {
                1,
                2,
                3,
                4,
                5,
                6,
            }:
                raise ValueError("Heading level must be between 1 and 6")
            if block["type"] == "learning":
                try:
                    data = json.loads(props.get("data", "{}"))
                    if not isinstance(data, dict):
                        raise ValueError()
                except (ValueError, TypeError):
                    raise ValueError("Learning data must be a JSON object") from None
                for name in (
                    "questions",
                    "cards",
                    "events",
                    "nodes",
                    "edges",
                    "workspace_items",
                    "artifacts",
                ):
                    if name in data and (
                        not isinstance(data[name], list)
                        or any(not isinstance(row, dict) for row in data[name])
                    ):
                        raise ValueError(f"Learning {name} must be a list of objects")
            if block["type"] in LEAF_BLOCK_TYPES:
                # Models often echo the kind as text content ("timeline"); a
                # block without inline content cannot hold it, and the editor
                # refuses the whole page if it is kept.
                block.pop("content", None)
            content = block.get("content", [])
            if block["type"] == "table":
                if not isinstance(content, dict) or not isinstance(content.get("rows"), list):
                    raise ValueError("Invalid table")
                for row in content["rows"]:
                    if not isinstance(row, dict) or not isinstance(row.get("cells"), list):
                        raise ValueError("Invalid table row")
                    for cell in row["cells"]:
                        inline(cell.get("content", []) if isinstance(cell, dict) else cell)
            elif block["type"] not in LEAF_BLOCK_TYPES:
                inline(content)
            if block["type"] == "noteColumns":
                columns = block.get("children", [])
                if (
                    not isinstance(columns, list)
                    or not 2 <= len(columns) <= 5
                    or any(c.get("type") != "noteColumn" for c in columns if isinstance(c, dict))
                ):
                    raise ValueError("Columns require between 2 and 5 column blocks")
            visit(block.get("children", []), depth + 1, block["type"])

    visit(blocks)
    return blocks


def inline_markdown(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    result = []
    for item in content:
        if not isinstance(item, dict):
            continue
        text = (
            str(item.get("text", ""))
            if item.get("type") == "text"
            else inline_markdown(item.get("content"))
        )
        if item.get("type") in {"math", "inlineMath"}:
            formula = item.get("props", {}).get("formula")
            if formula is None:
                formula = inline_markdown(item.get("content"))
            text = "$" + str(formula) + "$"
        if item.get("type") == "pageLink":
            props = item.get("props", {})
            text = f"[{props.get('title', 'Page')}](/co-writer/{props.get('pageId', '')})"
        if item.get("type") == "noteDate":
            text = str(item.get("props", {}).get("date", ""))
        styles = item.get("styles") or {}
        for key, marker in (("code", "`"), ("bold", "**"), ("italic", "*"), ("strike", "~~")):
            if styles.get(key):
                text = marker + text + marker
        if item.get("type") == "link":
            text = f"[{text}]({item.get('href', '')})"
        result.append(text)
    return "".join(result)


# Block types Markdown cannot represent (or only lossily); they serialize to a
# ```noteui fence so nb_patch can compile them back losslessly.
_DSL_ALWAYS = {
    "callout",
    "toggleHeading",
    "toggleListItem",
    "noteColumns",
    "noteColumn",
    "tableOfContents",
    "webCard",
    "htmlEmbed",
    "taskView",
    "clip",
    "noteUpload",
}
# These keep a Markdown form, but children would be lost — prefer DSL then.
_DSL_WITH_CHILDREN = {
    "heading",
    "quote",
    "bulletListItem",
    "numberedListItem",
    "checkListItem",
}


def _special_markdown(block: dict[str, Any]) -> str | None:
    """Fence-serialized form for blocks plain Markdown cannot carry, else None."""
    kind = block.get("type")
    props = block.get("props") or {}
    children = block.get("children") or []
    if kind in _DSL_ALWAYS or (kind in _DSL_WITH_CHILDREN and children):
        try:
            return "````noteui\n" + block_to_dsl(block) + "\n````"
        except NoteUIError:
            return None
    if kind == "learning":
        try:
            data = json.loads(props.get("data", "{}"))
        except (TypeError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        lkind = str(props.get("kind") or "")
        info = _KIND_FENCES.get(lkind)
        if info and (data or props.get("markdown")):
            body = (
                json.dumps(data, ensure_ascii=False)
                if data
                else str(props.get("markdown") or "")
            )
            fence = "`" * max(3, max((len(m[0]) + 1 for m in re.finditer(r"`+", body)), default=3))
            return f"{fence}{info}\n{body}\n{fence}"
        markdown = str(props.get("markdown") or "")
        if lkind in ("mermaid", "legacy_diagram") and markdown.strip().startswith("```"):
            return markdown
        try:
            return "````noteui\n" + block_to_dsl(block) + "\n````"
        except NoteUIError:
            return None
    return None


def blocks_to_markdown(blocks: list[dict[str, Any]], depth: int = 0) -> str:
    parts = []
    for block in blocks:
        kind, props = block.get("type"), block.get("props") or {}
        special = _special_markdown(block)
        if special is not None:
            parts.append("\n".join("  " * depth + line for line in special.splitlines()))
            continue
        text = inline_markdown(block.get("content"))
        if kind in {"heading", "toggleHeading"}:
            text = "#" * max(1, min(6, int(props.get("level", 1)))) + " " + text
        elif kind in ("bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"):
            prefix = {
                "bulletListItem": "- ",
                "numberedListItem": "1. ",
                "toggleListItem": "- ",
                "checkListItem": "- [x] " if props.get("checked") else "- [ ] ",
            }[kind]
            text = prefix + text
        elif kind in {"quote", "callout"}:
            text = "\n".join("> " + line for line in text.splitlines())
        elif kind == "codeBlock":
            fence = "`" * max(3, max((len(m[0]) + 1 for m in re.finditer(r"`+", text)), default=3))
            text = f"{fence}{props.get('language', '')}\n{text}\n{fence}"
        elif kind in ("image", "video", "audio", "file"):
            text = f"{'!' if kind == 'image' else ''}[{props.get('caption') or props.get('name', kind)}]({props.get('url', '')})"
        elif kind == "table":
            rows = (block.get("content") or {}).get("rows", [])
            lines = [
                "| "
                + " | ".join(
                    inline_markdown(c.get("content") if isinstance(c, dict) else c)
                    .replace("|", "\\|")
                    .replace("\n", "<br>")
                    for c in row.get("cells", [])
                )
                + " |"
                for row in rows
            ]
            if lines:
                lines.insert(1, "| " + " | ".join("---" for _ in rows[0].get("cells", [])) + " |")
            text = "\n".join(lines)
        elif kind == "webCard":
            text = f"[{props.get('title') or props.get('url', '')}]({props.get('url', '')})\n\n{props.get('description', '')}"
        elif kind == "htmlEmbed":
            source = str(props.get("source", ""))
            fence = "`" * max(
                3, max((len(m[0]) + 1 for m in re.finditer(r"`+", source)), default=3)
            )
            text = f"{fence}html\n{source}\n{fence}"
        elif kind == "taskView":
            text = "[Workspace tasks](/kanban)"
        elif kind == "tableOfContents":
            text = ""
        elif kind == "divider":
            text = "---"
        elif kind in {"math", "mathBlock"}:
            formula = props.get("formula")
            if formula is None:
                formula = inline_markdown(block.get("content"))
            text = "$$\n" + str(formula) + "\n$$"
        elif kind in ("learning", "clip"):
            text = str(props.get("markdown") or props.get("prompt") or props.get("title") or "")
            if kind == "learning":
                data = json.loads(props.get("data", "{}"))
                if props.get("kind") == "flashcards" and data.get("cards"):
                    text = "\n\n".join(
                        f"**{c.get('front', '')}**\n\n{c.get('back', '')}" for c in data["cards"]
                    )
                if props.get("kind") == "quiz" and data.get("questions"):
                    questions = []
                    for q in data["questions"]:
                        options = q.get("options") or {}
                        option_text = (
                            "\n".join(f"- {k}: {v}" for k, v in options.items())
                            if isinstance(options, dict)
                            else ""
                        )
                        questions.append(
                            f"{q.get('question', '')}\n\n{option_text}\n\nAnswer: {q.get('correct_answer', '')}\n\n{q.get('explanation', '')}"
                        )
                    text = "\n\n".join(questions)
                if props.get("kind") == "timeline" and data.get("events"):
                    text = "\n\n".join(
                        f"{e.get('date', '')} — {e.get('title', '')}\n{e.get('description', '')}"
                        for e in data["events"]
                    )
                for item in data.get("workspace_items", []) or data.get("artifacts", []):
                    if safe_link(item.get("url", "")) and item.get("url"):
                        text += f"\n\n[{item.get('filename') or item.get('title') or 'Media'}]({item['url']})"
            if props.get("sourceUrl"):
                text += f"\n\n[Source]({props['sourceUrl']})"
        if text:
            parts.append("\n".join("  " * depth + line for line in text.splitlines()))
        if block.get("children"):
            parts.append(
                blocks_to_markdown(
                    block["children"], depth if kind in {"noteColumns", "noteColumn"} else depth + 1
                )
            )
    return "\n\n".join(parts)


def walk_blocks(blocks):
    for block in blocks or []:
        yield block
        yield from walk_blocks(block.get("children", []))


async def resolve_image_queries(blocks: list[dict[str, Any]]) -> None:
    """Fill ``url`` on image blocks that carry a NoteUI ``query`` prop.

    ``SearchImage``/``WikiImage`` compile to image blocks with ``query`` (and
    ``via``) instead of a URL; the patch path resolves them once so the stored
    document keeps a stable link. Failures leave the block query-only — the
    frontend preview resolves lazily at render time.
    """
    targets = [
        b
        for b in walk_blocks(blocks)
        if b.get("type") == "image"
        and isinstance(b.get("props"), dict)
        and b["props"].get("query")
        and not b["props"].get("url")
    ]
    if not targets:
        return
    from ...api.openui import search_images, wiki_photos

    async def one(props: dict[str, Any]) -> None:
        query = str(props["query"]).strip()
        try:
            if props.get("via") == "wiki":
                info = await wiki_photos(query)
                url = (info.get("photos") or [None])[0]
            else:
                url = (await search_images(query) or [None])[0]
        except Exception:  # noqa: BLE001 - resolution is best-effort
            url = None
        if url:
            props["url"] = url

    import asyncio

    await asyncio.gather(*(one(b["props"]) for b in targets))
