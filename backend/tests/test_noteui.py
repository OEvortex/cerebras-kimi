"""NoteUI Lang: DSL -> BlockNote blocks, fences, and Markdown round-trips."""

from __future__ import annotations

import json

import pytest

from app.services.documents.blocks import (
    blocks_to_markdown,
    coarse_markdown_to_blocks,
    validate_blocks,
)
from app.services.documents.noteui import NoteUIError, blocks_to_dsl, compile_noteui


def types(blocks):
    return [b["type"] for b in blocks]


def test_basic_program_compiles():
    blocks = compile_noteui(
        '''
        $name = "Ada"
        Page([
          Heading(1, "Notes on " + $name),
          Text("**Bold** and $x^2$ math."),
          Callout("warning", "Careful"),
        ])
        '''
    )
    assert types(blocks) == ["heading", "paragraph", "callout"]
    assert blocks[0]["props"]["level"] == 1
    assert any(i.get("styles", {}).get("bold") for i in blocks[1]["content"])
    assert any(i.get("type") == "math" for i in blocks[1]["content"])
    assert blocks[2]["props"]["tone"] == "warning"


def test_nested_children_and_columns():
    blocks = compile_noteui(
        "Columns([Column([Bullet(\"a\"), Bullet(\"b\", [Bullet(\"nested\")])]), Column([Text(\"r\")])])"
    )
    assert types(blocks) == ["noteColumns"]
    cols = blocks[0]["children"]
    assert [c["type"] for c in cols] == ["noteColumn", "noteColumn"]
    nested = cols[0]["children"][1]["children"]
    assert nested[0]["type"] == "bulletListItem"


def test_learning_components():
    blocks = compile_noteui(
        'Quiz({questions: [{question: "2+2?", options: {A: "3", B: "4"}, correct_answer: "B"}]})\n'
        'Flashcards({cards: [{front: "f", back: "b"}]})\n'
        'Mermaid(`graph TD; A-->B`)'
    )
    assert types(blocks) == ["learning", "learning", "learning"]
    quiz = json.loads(blocks[0]["props"]["data"])
    assert quiz["questions"][0]["correct_answer"] == "B"
    assert blocks[2]["props"]["kind"] == "mermaid"
    assert "graph TD" in blocks[2]["props"]["markdown"]


def test_functions_and_expressions():
    blocks = compile_noteui(
        'Text(@Plural(3, "guest") + " -> " + @Format(1234.5, "currency") + " " + @Upper("ok"))'
    )
    text = "".join(i.get("text", "") for i in blocks[0]["content"])
    assert "3 guests" in text and "$1,234.50" in text and "OK" in text


def test_each_expands_components():
    blocks = compile_noteui(
        '$items = [{name: "a"}, {name: "b"}]\n'
        "Page([@Each($items, \"i\", Bullet(i.name))])"
    )
    assert types(blocks) == ["bulletListItem", "bulletListItem"]
    assert blocks[0]["content"][0]["text"] == "a"


def test_errors():
    with pytest.raises(NoteUIError):
        compile_noteui("Bogus(1)")
    with pytest.raises(NoteUIError):
        compile_noteui("Text($missing)")
    with pytest.raises(NoteUIError):
        compile_noteui("Text(@Nope(1))")
    with pytest.raises(NoteUIError):
        compile_noteui("Columns([Column([Text(\"x\")])])")  # only one column


def test_fence_in_markdown_compiles():
    blocks = coarse_markdown_to_blocks(
        "# Hi\n\n```noteui\nPage([Callout(\"tip\", \"hi\"), Text(\"there\")])\n```\n"
    )
    assert types(blocks) == ["heading", "callout", "paragraph"]
    validate_blocks(blocks)


def test_learning_fences_still_work():
    blocks = coarse_markdown_to_blocks(
        '```quiz\n{"questions": [{"question": "Q?"}]}\n```\n'
        "```mermaid\ngraph TD; A-->B\n```"
    )
    assert types(blocks) == ["learning", "learning"]
    assert blocks[0]["props"]["kind"] == "quiz"
    assert blocks[1]["props"]["kind"] == "mermaid"
    validate_blocks(blocks)


def test_markdown_elements():
    blocks = coarse_markdown_to_blocks(
        "# T\n\npara **bold** $x$\n\n- [x] done\n- item\n\n1. one\n\n> quote\n\n---\n\n"
        "| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```"
    )
    kinds = types(blocks)
    assert kinds == [
        "heading", "paragraph", "checkListItem", "bulletListItem",
        "numberedListItem", "quote", "divider", "table", "codeBlock",
    ]
    validate_blocks(blocks)


def test_round_trip_rich_blocks():
    original = compile_noteui(
        "Page([\n"
        '  Heading(2, "Sec", [Bullet("child item")]),\n'
        '  Callout("info", "note"),\n'
        '  Columns([Column([Text("l")]), Column([Text("r")])]),\n'
        '  Quiz({questions: [{question: "Q?"}]}),\n'
        "  TableOfContents()\n"
        "])"
    )
    md = blocks_to_markdown(original)
    rebuilt = validate_blocks(coarse_markdown_to_blocks(md))
    assert types(rebuilt) == types(original)
    # Spot-check nested content survived.
    heading = next(b for b in rebuilt if b["type"] == "heading")
    assert heading["children"][0]["type"] == "bulletListItem"
    quiz = next(b for b in rebuilt if b["type"] == "learning")
    assert json.loads(quiz["props"]["data"])["questions"]


def test_dsl_serializer_covers_all_valid_types():
    blocks = [
        {"id": "a1", "type": "paragraph", "props": {}, "content": [{"type": "text", "text": "hi", "styles": {}}], "children": []},
        {"id": "a2", "type": "noteUpload", "props": {"url": "https://x.test/f.pdf", "name": "f"}, "children": []},
        {"id": "a3", "type": "webCard", "props": {"url": "https://x.test", "title": "t"}, "children": []},
        {"id": "a4", "type": "taskView", "props": {"view": "table"}, "children": []},
    ]
    dsl = blocks_to_dsl(blocks)
    rebuilt = validate_blocks(coarse_markdown_to_blocks("````noteui\n" + dsl + "\n````"))
    assert types(rebuilt) == ["paragraph", "noteUpload", "webCard", "taskView"]
