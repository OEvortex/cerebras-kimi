"""Compile a notebook document into Co-Writer pages.

The notebook writer's entire final message is one Markdown-superset document:

    <!-- page: Hub Title -->
    # Hub Title

    Prose with $inline$ and $$display$$ math.

    ```mermaid
    flowchart TD
      A --> B
    ```

    ```quiz
    {"questions": [{"question": "...", "question_type": "choice",
                    "options": {"A": "...", "B": "..."},
                    "correct_answer": "B", "explanation": "..."}]}
    ```

    <!-- page: Subpage Title | parent: Hub Title -->
    ...

``compile_notebook`` splits the document on ``<!-- page: ... -->`` directives,
turns each body into validated BlockNote blocks (fences become ``learning``
blocks, ``$$..$$`` becomes ``math``, pipe tables become ``table`` blocks), and
creates the page tree in the document store. The writer needs no write tools —
its output IS the notebook, the way an OpenUI program is the chat answer.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from ...services.documents.blocks import (
    coarse_markdown_to_blocks,
    validate_blocks,
)
from ...services.documents.storage import get_co_writer_storage

# Fence info-string -> learning block kind. ``mermaid`` is special-cased: its
# payload is the fence itself (the frontend renders props.markdown).
_FENCE_KINDS = {
    "quiz": ("quiz", "questions"),
    "flashcards": ("flashcards", "cards"),
    "timeline": ("timeline", "events"),
    "conceptmap": ("concept_map", "nodes"),
    "concept_map": ("concept_map", "nodes"),
    "geogebra": ("geogebra", "commands"),
    "research": ("research", "sub_topics"),
}

# concept_map may carry {"graph": ...} instead of nodes; research may carry
# only {"outline_preview": ...}.
_FENCE_ALT_KEYS = {"concept_map": "graph", "research": "outline_preview"}

_PAGE_DIRECTIVE = re.compile(
    r"^[ \t]*<!--\s*page:\s*(?P<title>[^|>\n]+?)\s*"
    r"(?:\|\s*(?P<attrs>[^>\n]*?))?\s*-->\s*$",
    re.M,
)
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\n]*)\n(.*?)^\1\s*$", re.S | re.M)
_DISPLAY_MATH = re.compile(r"\$\$(.+?)\$\$", re.S)
_TABLE_SEP = re.compile(r"^\s*\|?[\s:|-]+\|?\s*$")


@dataclass
class PageSpec:
    title: str
    parent: str
    body: str


@dataclass
class CompileReport:
    pages: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _new_block(type_: str, props: dict[str, Any] | None = None,
               content: Any = None) -> dict[str, Any]:
    block: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "type": type_,
        "props": props or {},
        "children": [],
    }
    if content is not None:
        block["content"] = content
    return block


def _text_inline(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text, "styles": {}}]


def _learning_block(kind: str, data: dict[str, Any],
                    markdown: str = "") -> dict[str, Any]:
    return _new_block("learning", {
        "kind": kind,
        "prompt": "",
        "markdown": markdown,
        "data": json.dumps(data, ensure_ascii=False),
        "sourceUrl": "",
    })


# ---------------------------------------------------------------------------
# Page splitting
# ---------------------------------------------------------------------------


def _parse_attrs(raw: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for part in (raw or "").split("|"):
        if ":" in part:
            key, _, value = part.partition(":")
            attrs[key.strip().lower()] = value.strip()
    return attrs


def split_pages(text: str) -> list[PageSpec]:
    """Split a notebook document on ``<!-- page: ... -->`` directives.

    Content before the first directive is prepended to the first page, so a
    model that forgets directives still yields one page.
    """
    matches = list(_PAGE_DIRECTIVE.finditer(text or ""))
    if not matches:
        return [PageSpec(title="", parent="", body=(text or "").strip())]

    specs: list[PageSpec] = []
    for i, match in enumerate(matches):
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end]
        if i == 0:
            body = text[:match.start()] + body
        attrs = _parse_attrs(match.group("attrs") or "")
        specs.append(PageSpec(
            title=match.group("title").strip(),
            parent=attrs.get("parent", "").strip(),
            body=body.strip(),
        ))
    return specs


# ---------------------------------------------------------------------------
# Body -> blocks
# ---------------------------------------------------------------------------


def _fence_block(lang: str, body: str, full_fence: str,
                 warnings: list[str]) -> dict[str, Any]:
    """One fenced block -> a block. Unknown/broken fences degrade to code."""
    lang = (lang or "").strip().lower()
    if lang == "mermaid":
        return _learning_block("mermaid", {}, markdown=full_fence)
    if lang in _FENCE_KINDS:
        kind, required = _FENCE_KINDS[lang]
        try:
            data = json.loads(body.strip())
        except (ValueError, TypeError):
            warnings.append(f"```{lang} fence had invalid JSON; kept as code.")
            return _code_block(lang, body)
        if not isinstance(data, dict):
            warnings.append(f"```{lang} fence must contain a JSON object; kept as code.")
            return _code_block(lang, body)
        alt = _FENCE_ALT_KEYS.get(kind)
        if required not in data and not (alt and alt in data):
            warnings.append(
                f"```{lang} fence is missing {required!r}; kept as code."
            )
            return _code_block(lang, body)
        return _learning_block(kind, data)
    return _code_block(lang, body)


def _code_block(lang: str, body: str) -> dict[str, Any]:
    return _new_block(
        "codeBlock", {"language": lang or ""}, _text_inline(body.rstrip("\n"))
    )


def _table_block(lines: list[str]) -> dict[str, Any] | None:
    """Pipe table -> table block. ``lines`` includes header + separator."""
    rows: list[dict[str, Any]] = []
    for line in lines:
        if _TABLE_SEP.match(line):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        rows.append({"cells": [_text_inline(c.replace("\\|", "|")) for c in cells]})
    if len(rows) < 2:  # header + separator produced nothing usable
        return None
    # BlockNote's client parser requires `type: "tableContent"` and plain
    # inline-content arrays for cells. Anything else makes opening the page
    # fail with "Error creating document from blocks passed as `initialContent`".
    return _new_block("table", {}, {"type": "tableContent", "rows": rows})


def _rich_text_blocks(text: str) -> list[dict[str, Any]]:
    """Markdown text chunk -> blocks, with $$..$$ regions as math blocks."""
    blocks: list[dict[str, Any]] = []
    pos = 0
    for match in _DISPLAY_MATH.finditer(text):
        before = text[pos:match.start()]
        if before.strip():
            blocks.extend(_text_with_tables(before))
        formula = match.group(1).strip()
        if formula:
            blocks.append(_new_block("math", {"formula": formula}))
        pos = match.end()
    tail = text[pos:]
    if tail.strip():
        blocks.extend(_text_with_tables(tail))
    return blocks


def _text_with_tables(text: str) -> list[dict[str, Any]]:
    """Markdown -> blocks, recognising pipe tables the coarse parser misses."""
    lines = text.splitlines()
    blocks: list[dict[str, Any]] = []
    buf: list[str] = []
    i = 0

    def flush() -> None:
        if buf:
            chunk = "\n".join(buf)
            if chunk.strip():
                blocks.extend(coarse_markdown_to_blocks(chunk))
            buf.clear()

    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("|") and i + 1 < len(lines) \
                and _TABLE_SEP.match(lines[i + 1]) and "|" in lines[i + 1]:
            # Collect the whole table: header, separator, body rows.
            table_lines = [line, lines[i + 1]]
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                table_lines.append(lines[j])
                j += 1
            flush()
            table = _table_block(table_lines)
            if table is not None:
                blocks.append(table)
            else:
                buf.extend(table_lines)
            i = j
            continue
        buf.append(line)
        i += 1
    flush()
    return blocks


def compile_body(markdown: str, warnings: list[str]) -> list[dict[str, Any]]:
    """One page body -> validated BlockNote blocks."""
    blocks: list[dict[str, Any]] = []
    pos = 0
    for match in _FENCE.finditer(markdown):
        before = markdown[pos:match.start()]
        if before.strip():
            blocks.extend(_rich_text_blocks(before))
        fence_char = match.group(1)
        lang = match.group(2).strip().split()[0] if match.group(2).strip() else ""
        body = match.group(3)
        # Rebuild the full fenced source for mermaid's props.markdown.
        full = f"{fence_char}{lang}\n{body}{fence_char}"
        blocks.append(_fence_block(lang, body, full, warnings))
        pos = match.end()
    tail = markdown[pos:]
    if tail.strip():
        blocks.extend(_rich_text_blocks(tail))
    return validate_blocks(blocks) if blocks else []


# ---------------------------------------------------------------------------
# Whole document -> page tree
# ---------------------------------------------------------------------------


def _resolve_parent(
    value: str,
    *,
    title_to_id: dict[str, str],
    default_parent_id: str,
    warnings: list[str],
) -> str | None:
    """parent: value resolves to a page in this document first, then to an
    existing notebook page (by id, then by unique title)."""
    wanted = value.strip()
    if not wanted:
        return default_parent_id or None
    key = wanted.lower()
    if key in title_to_id:
        return title_to_id[key]
    storage = get_co_writer_storage()
    if storage.load_document(wanted) is not None:
        return wanted
    matches = [
        s.id for s in storage.list_documents()
        if (s.title or "").strip().lower() == key
    ]
    if len(matches) == 1:
        return matches[0]
    warnings.append(
        f"parent {wanted!r} not found; page placed at the notebook root."
    )
    return None


def compile_notebook(
    text: str,
    *,
    parent_page_id: str = "",
    fallback_title: str = "",
) -> CompileReport:
    """Create the page tree described by a notebook document.

    Raises ``ValueError`` when the document produces no pages at all.
    """
    specs = split_pages(text or "")
    specs = [s for s in specs if s.body]
    if not specs:
        raise ValueError("the document contains no page content")

    storage = get_co_writer_storage()
    report = CompileReport()
    title_to_id: dict[str, str] = {}

    for index, spec in enumerate(specs):
        try:
            blocks = compile_body(spec.body, report.warnings)
        except ValueError as exc:
            report.warnings.append(f"page {spec.title or index + 1!r}: {exc}")
            continue
        if not blocks:
            report.warnings.append(
                f"page {spec.title or index + 1!r} had no usable content; skipped."
            )
            continue
        parent = _resolve_parent(
            spec.parent,
            title_to_id=title_to_id,
            default_parent_id=parent_page_id if index == 0 else "",
            warnings=report.warnings,
        )
        try:
            doc = storage.create_document(
                title=spec.title or None,
                blocks=blocks,
                parent_id=parent,
            )
        except ValueError as exc:
            report.warnings.append(
                f"page {spec.title or index + 1!r}: could not be created ({exc})."
            )
            continue
        title_to_id[doc.title.strip().lower()] = doc.id
        if spec.title:
            title_to_id[spec.title.strip().lower()] = doc.id
        report.pages.append({
            "id": doc.id,
            "title": doc.title,
            "parent_id": doc.parent_id,
            "blocks": len(blocks),
        })

    if not report.pages:
        raise ValueError("no pages could be created from the document")
    return report


def format_report(report: CompileReport, fallback_title: str = "") -> str:
    """The compact report the parent agent relays to the learner."""
    lines = [f"Notebook built: {len(report.pages)} page(s)."]
    by_parent: dict[str | None, list[dict[str, Any]]] = {}
    for page in report.pages:
        by_parent.setdefault(page.get("parent_id"), []).append(page)

    def emit(parent_id: str | None, depth: int) -> None:
        for page in by_parent.get(parent_id, []):
            lines.append(
                "  " * depth + f"- {page['title']} (id {page['id']}, "
                f"{page['blocks']} blocks)"
            )
            emit(page["id"], depth + 1)

    roots = [p for p in report.pages if not p.get("parent_id")]
    for page in roots:
        lines.append(f"- {page['title']} (id {page['id']}, {page['blocks']} blocks)")
        emit(page["id"], 1)
    # Pages whose parent is outside this document still appear under roots'
    # listing only if orphaned; attach leftovers at the end.
    seen = {p["id"] for p in roots}
    for parent_id, children in by_parent.items():
        if parent_id and parent_id not in seen:
            for page in children:
                if page["id"] not in seen:
                    lines.append(
                        f"- {page['title']} (id {page['id']}, "
                        f"{page['blocks']} blocks)"
                    )
                    seen.add(page["id"])
                    emit(page["id"], 1)
    if report.warnings:
        lines.append(f"Warnings ({len(report.warnings)}):")
        lines.extend(f"- {w}" for w in report.warnings[:10])
    if fallback_title:
        lines.insert(0, f"Requested as: {fallback_title}")
    return "\n".join(lines)


__all__ = [
    "CompileReport",
    "PageSpec",
    "compile_body",
    "compile_notebook",
    "format_report",
    "split_pages",
]
