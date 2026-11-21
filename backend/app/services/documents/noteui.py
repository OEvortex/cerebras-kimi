"""NoteUI Lang — an openui-style DSL that compiles to BlockNote blocks.

Co-writer page bodies are Markdown; anything Markdown cannot express (columns,
callouts with tones, embedded cards, computed text) goes in a ```` ```noteui ````
fence as a small program:

    ```noteui
    $name = "Ada"
    Page([
      Heading(1, "Notes on " + $name),
      Text("**Bold** and inline $x^2$ math."),
      Columns([Column([Text("left")]), Column([Text("right")])]),
      Quiz({questions: [{question: "2+2?", options: {A: "3", B: "4"}, correct_answer: "B"}]}),
    ])
    ```

Syntax mirrors OpenUI Lang: ``name = expr`` bindings, ``$name`` references,
``Component(positional, args)`` calls whose last argument may be an array of
child components, ``@Function(args)`` compile-time functions, arrays ``[...]``,
objects ``{key: value}``, strings (``"..."``, ``'...'``, `` `raw` ``), numbers,
``true``/``false``/``null``, ``+ - * / %``, comparisons, ``&&``/``||``/``!``,
ternary ``cond ? a : b``, member access ``obj.field`` / ``list.field`` plucking,
and indexing ``a[i]``.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Callable


class NoteUIError(ValueError):
    """A DSL syntax or evaluation failure, with a line number when known."""


# ---------------------------------------------------------------------------
# Inline Markdown (shared by the DSL and the coarse Markdown converter)
# ---------------------------------------------------------------------------

_MARKERS = ("**", "__", "~~", "*", "_", "`", "[", "$")


def _find_close(text: str, start: int, marker: str) -> int:
    idx = text.find(marker, start)
    return idx


def _parse_spans(text: str, styles: dict[str, bool]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    buf: list[str] = []
    i, n = 0, len(text)

    def flush() -> None:
        if buf:
            out.append({"type": "text", "text": "".join(buf), "styles": dict(styles)})
            buf.clear()

    while i < n:
        ch = text[i]
        matched = False
        for marker in _MARKERS:
            if not text.startswith(marker, i):
                continue
            # A backslash-escaped marker stays literal.
            if i > 0 and text[i - 1] == "\\":
                buf.append(text[i : i + len(marker)])
                i += len(marker)
                matched = True
                break
            if marker in ("**", "__"):
                close = _find_close(text, i + 2, marker)
                if close < 0:
                    buf.append(marker)
                    i += 2
                    matched = True
                    break
                flush()
                key = "bold"
                out.extend(_parse_spans(text[i + 2 : close], {**styles, key: True}))
                i = close + 2
                matched = True
                break
            if marker == "~~":
                close = _find_close(text, i + 2, "~~")
                if close < 0:
                    buf.append("~~")
                    i += 2
                    matched = True
                    break
                flush()
                out.extend(_parse_spans(text[i + 2 : close], {**styles, "strike": True}))
                i = close + 2
                matched = True
                break
            if marker in ("*", "_"):
                # Avoid treating snake_case underscores as emphasis.
                if marker == "_" and (
                    (i > 0 and (text[i - 1].isalnum() or text[i - 1] == "_"))
                    or (i + 1 < n and (text[i + 1].isalnum() or text[i + 1] == "_"))
                ):
                    continue
                close = _find_close(text, i + 1, marker)
                if close < 0:
                    buf.append(marker)
                    i += 1
                    matched = True
                    break
                flush()
                out.extend(_parse_spans(text[i + 1 : close], {**styles, "italic": True}))
                i = close + 1
                matched = True
                break
            if marker == "`":
                close = _find_close(text, i + 1, "`")
                if close < 0:
                    buf.append("`")
                    i += 1
                    matched = True
                    break
                flush()
                out.append(
                    {
                        "type": "text",
                        "text": text[i + 1 : close],
                        "styles": {**styles, "code": True},
                    }
                )
                i = close + 1
                matched = True
                break
            if marker == "[":
                mid = text.find("](", i + 1)
                if mid > 0:
                    end = text.find(")", mid + 2)
                    if end > 0:
                        href = text[mid + 2 : end]
                        label = text[i + 1 : mid]
                        from .blocks import safe_link

                        if safe_link(href):
                            flush()
                            out.append(
                                {
                                    "type": "link",
                                    "href": href,
                                    "content": _parse_spans(label, {}),
                                }
                            )
                            i = end + 1
                            matched = True
                            break
                buf.append("[")
                i += 1
                matched = True
                break
            if marker == "$":
                # Display $$...$$ first, then inline $...$ (no space padding).
                if text.startswith("$$", i):
                    close = text.find("$$", i + 2)
                    if close > i + 2:
                        formula = text[i + 2 : close].strip()
                        if formula:
                            flush()
                            out.append({"type": "math", "content": formula})
                            i = close + 2
                            matched = True
                            break
                    buf.append("$$")
                    i += 2
                    matched = True
                    break
                close = _find_close(text, i + 1, "$")
                if close > i + 1:
                    formula = text[i + 1 : close]
                    if formula.strip() and not formula.startswith(" ") and not formula.endswith(" "):
                        flush()
                        out.append({"type": "math", "content": formula.strip()})
                        i = close + 1
                        matched = True
                        break
                buf.append("$")
                i += 1
                matched = True
                break
        if not matched:
            buf.append(ch)
            i += 1
    flush()
    return out


def parse_inline_md(text: str) -> list[dict[str, Any]]:
    """Markdown-lite inline content: **bold** *italic* `code` ~~strike~~ [t](u) $math$."""
    if not text:
        return []
    return _parse_spans(text, {})


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

_PUNCT = {
    "(": "(", ")": ")", "[": "[", "]": "]", "{": "{", "}": "}",
    ",": ",", ":": ":", ".": ".", "?": "?",
    "+": "+", "-": "-", "*": "*", "/": "/", "%": "%",
    "=": "=", "!": "!", "<": "<", ">": ">", "&": "&", "|": "|",
}
_TWO_CHAR = {"==", "!=", "<=", ">=", "&&", "||"}


def _tokenize(source: str) -> list[tuple[str, Any, int]]:
    tokens: list[tuple[str, Any, int]] = []
    i, n = 0, len(source)
    line = 1
    while i < n:
        ch = source[i]
        if ch in " \t\r":
            i += 1
            continue
        if ch == "\n":
            line += 1
            i += 1
            continue
        if ch == "/" and source.startswith("//", i):
            end = source.find("\n", i)
            i = n if end < 0 else end
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and source[i + 1].isdigit()):
            j = i
            while j < n and (source[j].isdigit() or source[j] == "."):
                j += 1
            raw = source[i:j]
            try:
                tokens.append(("num", float(raw) if "." in raw else int(raw), line))
            except ValueError:
                raise NoteUIError(f"Bad number {raw!r} (line {line})")
            i = j
            continue
        if ch in "\"'":
            quote = ch
            j = i + 1
            buf: list[str] = []
            while j < n and source[j] != quote:
                if source[j] == "\\" and j + 1 < n:
                    nxt = source[j + 1]
                    buf.append({"n": "\n", "t": "\t", "r": "\r", '"': '"', "'": "'", "\\": "\\", "`": "`", "$": "$"}.get(nxt, nxt))
                    j += 2
                    continue
                if source[j] == "\n":
                    line += 1
                buf.append(source[j])
                j += 1
            if j >= n:
                raise NoteUIError(f"Unterminated string (line {line})")
            tokens.append(("str", "".join(buf), line))
            i = j + 1
            continue
        if ch == "`":
            j = source.find("`", i + 1)
            if j < 0:
                raise NoteUIError(f"Unterminated raw string (line {line})")
            tokens.append(("str", source[i + 1 : j], line))
            line += source.count("\n", i, j)
            i = j + 1
            continue
        if ch == "@":
            j = i + 1
            while j < n and (source[j].isalnum() or source[j] == "_"):
                j += 1
            if j == i + 1:
                raise NoteUIError(f"'@' must be followed by a function name (line {line})")
            tokens.append(("fn", source[i + 1 : j], line))
            i = j
            continue
        if ch == "$":
            j = i + 1
            while j < n and (source[j].isalnum() or source[j] == "_"):
                j += 1
            if j == i + 1:
                raise NoteUIError(f"'$' must be followed by a variable name (line {line})")
            tokens.append(("var", source[i + 1 : j], line))
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i
            while j < n and (source[j].isalnum() or source[j] == "_"):
                j += 1
            word = source[i:j]
            if word in ("true", "false", "null"):
                tokens.append(("lit", {"true": True, "false": False, "null": None}[word], line))
            else:
                tokens.append(("ident", word, line))
            i = j
            continue
        two = source[i : i + 2]
        if two in _TWO_CHAR:
            tokens.append(("op", two, line))
            i += 2
            continue
        if ch in _PUNCT:
            if ch == "=":
                tokens.append(("op", "=", line))
            elif ch == "&":
                raise NoteUIError(f"Use '&&' for and (line {line})")
            elif ch == "|":
                raise NoteUIError(f"Use '||' for or (line {line})")
            else:
                tokens.append(("punct", ch, line))
            i += 1
            continue
        raise NoteUIError(f"Unexpected character {ch!r} (line {line})")
    tokens.append(("eof", None, line))
    return tokens


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


class _Parser:
    def __init__(self, tokens: list[tuple[str, Any, int]]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple[str, Any, int]:
        return self.tokens[self.pos]

    def next(self) -> tuple[str, Any, int]:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def expect(self, value: str) -> tuple[str, Any, int]:
        tok = self.next()
        if tok[1] != value:
            raise NoteUIError(f"Expected {value!r}, got {tok[1]!r} (line {tok[2]})")
        return tok

    def at(self, value: str) -> bool:
        kind, val, _ = self.peek()
        return val == value and kind in ("punct", "op")

    def parse_program(self) -> list[tuple]:
        stmts = []
        while self.peek()[0] != "eof":
            stmts.append(self.parse_stmt())
        return stmts

    def parse_stmt(self) -> tuple:
        # name = expr  |  $name = expr  |  expr
        if (
            self.peek()[0] in ("ident", "var")
            and self.pos + 1 < len(self.tokens)
            and self.tokens[self.pos + 1][1] == "="
            and self.tokens[self.pos + 1][0] == "op"
        ):
            name = self.next()[1]
            self.next()  # '='
            return ("bind", name, self.parse_expr())
        return ("expr", self.parse_expr())

    def parse_expr(self) -> tuple:
        return self.parse_ternary()

    def parse_ternary(self) -> tuple:
        cond = self.parse_or()
        if self.at("?"):
            self.next()
            yes = self.parse_expr()
            self.expect(":")
            no = self.parse_expr()
            return ("tern", cond, yes, no)
        return cond

    def parse_or(self) -> tuple:
        left = self.parse_and()
        while self.at("||"):
            self.next()
            left = ("bin", "||", left, self.parse_and())
        return left

    def parse_and(self) -> tuple:
        left = self.parse_cmp()
        while self.at("&&"):
            self.next()
            left = ("bin", "&&", left, self.parse_cmp())
        return left

    def parse_cmp(self) -> tuple:
        left = self.parse_add()
        while self.peek()[0] == "op" and self.peek()[1] in ("==", "!=", "<", ">", "<=", ">="):
            op = self.next()[1]
            left = ("bin", op, left, self.parse_add())
        return left

    def parse_add(self) -> tuple:
        left = self.parse_mul()
        while self.at("+") or self.at("-"):
            op = self.next()[1]
            left = ("bin", op, left, self.parse_mul())
        return left

    def parse_mul(self) -> tuple:
        left = self.parse_unary()
        while self.peek()[1] in ("*", "/", "%") and self.peek()[0] in ("op", "punct"):
            op = self.next()[1]
            left = ("bin", op, left, self.parse_unary())
        return left

    def parse_unary(self) -> tuple:
        if self.at("!"):
            self.next()
            return ("un", "!", self.parse_unary())
        if self.at("-"):
            self.next()
            return ("un", "-", self.parse_unary())
        return self.parse_postfix()

    def parse_postfix(self) -> tuple:
        node = self.parse_primary()
        while True:
            if self.at("."):
                self.next()
                kind, name, line = self.next()
                if kind != "ident":
                    raise NoteUIError(f"Expected a field name after '.' (line {line})")
                node = ("member", node, name)
                continue
            if self.at("["):
                self.next()
                index = self.parse_expr()
                self.expect("]")
                node = ("index", node, index)
                continue
            break
        return node

    def parse_primary(self) -> tuple:
        kind, val, line = self.next()
        if kind == "num":
            return ("lit", val)
        if kind == "str":
            return ("lit", val)
        if kind == "lit":
            return ("lit", val)
        if kind == "var":
            return ("var", val)
        if kind == "fn":
            self.expect("(")
            args = self.parse_args()
            self.expect(")")
            return ("fn", val, args)
        if kind == "ident":
            if val in ("true", "false", "null"):
                return ("lit", {"true": True, "false": False, "null": None}[val])
            if self.at("("):
                self.next()
                args = self.parse_args()
                self.expect(")")
                return ("call", val, args)
            # Bare identifier: bound variable reference.
            return ("var", val)
        if kind == "punct" and val == "(":
            node = self.parse_expr()
            self.expect(")")
            return node
        if kind == "punct" and val == "[":
            items = []
            while not self.at("]"):
                items.append(self.parse_expr())
                if self.at(","):
                    self.next()
                    continue
                break
            self.expect("]")
            return ("arr", items)
        if kind == "punct" and val == "{":
            pairs = []
            while not self.at("}"):
                kkind, kval, kline = self.next()
                if kkind not in ("ident", "str"):
                    raise NoteUIError(f"Object keys must be names or strings (line {kline})")
                self.expect(":")
                pairs.append((kval, self.parse_expr()))
                if self.at(","):
                    self.next()
                    continue
                break
            self.expect("}")
            return ("obj", pairs)
        raise NoteUIError(f"Unexpected token {val!r} (line {line})")

    def parse_args(self) -> list[tuple]:
        args = []
        while not self.at(")"):
            args.append(self.parse_expr())
            if self.at(","):
                self.next()
                continue
            break
        return args


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------


def _blk(type_: str, props: dict | None = None, content: Any = None, children: list | None = None) -> dict:
    block: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "type": type_,
        "props": props or {},
        "children": children or [],
    }
    if content is not None:
        block["content"] = content
    return block


def _is_blocks(value: Any) -> bool:
    return (
        isinstance(value, list)
        and all(isinstance(item, dict) and isinstance(item.get("type"), str) for item in value)
    )


def _as_blocks(value: Any, what: str = "value") -> list[dict]:
    if _is_blocks(value):
        return list(value)
    if isinstance(value, list):
        flat: list[dict] = []
        for item in value:
            flat.extend(_as_blocks(item, what))
        return flat
    raise NoteUIError(f"{what} must be a component or list of components")


def _join_text(args: list[Any]) -> str:
    parts = []
    for arg in args:
        if _is_blocks(arg) or (isinstance(arg, list) and arg and _is_blocks(arg[0])):
            raise NoteUIError("Text content cannot contain components; pass them as children instead")
        if isinstance(arg, bool):
            parts.append("true" if arg else "false")
        elif arg is None:
            continue
        else:
            parts.append(str(arg))
    return "".join(parts)


def _content(text: str) -> list[dict[str, Any]]:
    return parse_inline_md(text)


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

_CHILDREN_OK = {
    "heading", "toggleHeading", "quote", "callout",
    "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem",
    "noteColumn",
}

_CALLOUT_TONES = {"tip", "info", "warning"}


def _split_children(args: list[Any]) -> tuple[list[Any], list[dict] | None]:
    if args and (_is_blocks(args[-1]) or (isinstance(args[-1], list) and args[-1] and _is_blocks(args[-1][0]))):
        return args[:-1], _as_blocks(args[-1], "children")
    return args, None


def _require_no_children(children: list[dict] | None, name: str) -> None:
    if children:
        raise NoteUIError(f"{name} does not take child components")


def _c_page(args, children):
    blocks = _as_blocks(args[0] if args else [], "Page") if args else []
    return blocks


def _c_heading(args, children, toggle=False):
    args, tail = _split_children(args)
    children = children or tail
    level = int(args[0]) if args else (2 if toggle else 1)
    level = max(1, min(6, level))
    text = _join_text(args[1:])
    kind = "toggleHeading" if toggle else "heading"
    props = {"level": level}
    if toggle:
        props["collapsed"] = False
    return [_blk(kind, props=props, content=_content(text), children=children or [])]


def _c_text(args, children):
    _require_no_children(children, "Text")
    return [_blk("paragraph", content=_content(_join_text(args)))]


def _c_quote(args, children):
    args, tail = _split_children(args)
    children = children or tail
    return [_blk("quote", content=_content(_join_text(args)), children=children or [])]


def _c_callout(args, children):
    args, tail = _split_children(args)
    children = children or tail
    tone = "tip"
    if args and isinstance(args[0], str) and args[0].lower() in _CALLOUT_TONES:
        tone = args[0].lower()
        args = args[1:]
    return [_blk("callout", props={"tone": tone}, content=_content(_join_text(args)), children=children or [])]


def _c_item(kind):
    def build(args, children):
        args, tail = _split_children(args)
        children = children or tail
        props: dict[str, Any] = {}
        rest = list(args)
        if kind == "checkListItem" and rest and isinstance(rest[-1], bool):
            props["checked"] = rest.pop()
        return [_blk(kind, props=props, content=_content(_join_text(rest)), children=children or [])]
    return build


def _c_code(args, children):
    _require_no_children(children, "CodeBlock")
    language = str(args[0]) if args else ""
    code = _join_text(args[1:])
    return [_blk("codeBlock", props={"language": language}, content=_content(code))]


def _c_divider(args, children):
    _require_no_children(children, "Divider")
    return [_blk("divider")]


def _c_math(args, children):
    _require_no_children(children, "Math")
    return [_blk("mathBlock", content=_join_text(args))]


def _c_media(kind):
    def build(args, children):
        _require_no_children(children, kind)
        url = str(args[0]) if args else ""
        props: dict[str, Any] = {"url": url}
        if kind == "file":
            props["name"] = str(args[1]) if len(args) > 1 else ""
        elif len(args) > 1:
            props["caption"] = str(args[1])
        return [_blk(kind, props=props)]
    return build


def _c_table(args, children):
    _require_no_children(children, "Table")
    rows = args[0] if args else []
    if not isinstance(rows, list):
        raise NoteUIError("Table expects an array of rows, each an array of cells")
    out_rows = []
    for row in rows:
        if not isinstance(row, list):
            raise NoteUIError("Each table row must be an array of cells")
        cells = [[{"type": "text", "text": str(cell), "styles": {}}] if not isinstance(cell, list) else cell for cell in row]
        # Re-parse plain strings through the inline parser for **bold** etc.
        cells = [c if isinstance(c, list) else _content(str(c)) for c in row]
        out_rows.append({"cells": cells})
    return [_blk("table", content={"rows": out_rows})]


def _c_columns(args, children):
    cols = _as_blocks(args[0] if args else [], "Columns")
    if not 2 <= len(cols) <= 5 or any(c.get("type") != "noteColumn" for c in cols):
        raise NoteUIError("Columns needs 2 to 5 Column(...) children")
    return [_blk("noteColumns", children=cols)]


def _c_column(args, children):
    blocks = _as_blocks(args[0] if args else [], "Column")
    return [_blk("noteColumn", children=blocks)]


def _c_leaf(kind, props_from):
    def build(args, children):
        _require_no_children(children, kind)
        return [_blk(kind, props=props_from(args))]
    return build


def _learning_block(kind: str, data: Any = None, markdown: str = "") -> dict:
    props = {"kind": kind, "prompt": "", "markdown": markdown, "data": "{}", "sourceUrl": ""}
    if isinstance(data, dict):
        body = json.dumps(data, ensure_ascii=False)
        props["data"] = body
        if not markdown:
            props["markdown"] = body
    elif isinstance(data, str):
        try:
            parsed = json.loads(data)
            if isinstance(parsed, dict):
                props["data"] = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
                if not markdown:
                    props["markdown"] = data
        except (TypeError, ValueError):
            if not markdown:
                props["markdown"] = data
    return _blk("learning", props=props)


def _c_learning(kind):
    def build(args, children):
        _require_no_children(children, kind)
        data = args[0] if args else None
        markdown = str(args[1]) if len(args) > 1 else ""
        return [_learning_block(kind, data, markdown)]
    return build


def _c_mermaid(args, children):
    _require_no_children(children, "Mermaid")
    code = _join_text(args)
    fence = "```mermaid\n" + code + "\n```"
    return [_learning_block("mermaid", markdown=fence)]


def _c_clip(args, children):
    _require_no_children(children, "Clip")
    props = {
        "title": str(args[0]) if args else "",
        "markdown": str(args[1]) if len(args) > 1 else "",
        "sourceUrl": str(args[2]) if len(args) > 2 else "",
        "sourceId": "",
        "favoriteType": "",
        "summary": "",
        "metadata": "{}",
        "expanded": False,
    }
    return [_blk("clip", props=props)]


def _c_block(args, children):
    _require_no_children(children, "Block")
    raw = args[0] if args else None
    if not isinstance(raw, dict) or not isinstance(raw.get("type"), str):
        raise NoteUIError("Block(...) expects an object with a 'type' field")
    block = _ensure_ids(json.loads(json.dumps(raw)))
    return [block]


def _ensure_ids(node: Any) -> Any:
    if isinstance(node, list):
        return [_ensure_ids(item) for item in node]
    if isinstance(node, dict):
        out = {k: _ensure_ids(v) for k, v in node.items()}
        if isinstance(out.get("type"), str) and ("id" not in out or not isinstance(out.get("id"), str)):
            out["id"] = uuid.uuid4().hex[:12]
        return out
    return node


def _c_learning_any(args, children):
    _require_no_children(children, "Learning")
    kind = str(args[0]) if args else ""
    data = args[1] if len(args) > 1 else None
    markdown = str(args[2]) if len(args) > 2 else ""
    return [_learning_block(kind, data, markdown)]


_COMPONENTS: dict[str, Callable[[list[Any], list[dict] | None], list[dict]]] = {
    "Page": _c_page,
    "Heading": lambda a, c: _c_heading(a, c, toggle=False),
    "ToggleHeading": lambda a, c: _c_heading(a, c, toggle=True),
    "Text": _c_text,
    "Paragraph": _c_text,
    "Quote": _c_quote,
    "Callout": _c_callout,
    "Bullet": _c_item("bulletListItem"),
    "Numbered": _c_item("numberedListItem"),
    "CheckItem": _c_item("checkListItem"),
    "ToggleItem": _c_item("toggleListItem"),
    "CodeBlock": _c_code,
    "Divider": _c_divider,
    "Math": _c_math,
    "Image": _c_media("image"),
    "Video": _c_media("video"),
    "Audio": _c_media("audio"),
    "File": _c_media("file"),
    "Table": _c_table,
    "Columns": _c_columns,
    "Column": _c_column,
    "TableOfContents": _c_leaf("tableOfContents", lambda a: {}),
    "WebCard": _c_leaf(
        "webCard",
        lambda a: {
            "url": str(a[0]) if a else "",
            "title": str(a[1]) if len(a) > 1 else "",
            "description": str(a[2]) if len(a) > 2 else "",
        },
    ),
    "HtmlEmbed": _c_leaf("htmlEmbed", lambda a: {"source": _join_text(a)}),
    "TaskView": _c_leaf("taskView", lambda a: {"view": str(a[0]) if a else "table"}),
    "Clip": _c_clip,
    "Block": _c_block,
    "Mermaid": _c_mermaid,
    "Quiz": _c_learning("quiz"),
    "Flashcards": _c_learning("flashcards"),
    "Timeline": _c_learning("timeline"),
    "ConceptMap": _c_learning("concept_map"),
    "GeoGebra": _c_learning("geogebra"),
    "Research": _c_learning("research"),
    "Task": _c_learning("task"),
    "Learning": _c_learning_any,
}


# ---------------------------------------------------------------------------
# @functions (compile-time, openui-style)
# ---------------------------------------------------------------------------


def _pluck(rows: Any, field: str) -> list[Any]:
    if not isinstance(rows, list):
        return []
    if not field:
        return rows
    return [r.get(field) for r in rows if isinstance(r, dict) and field in r]


def _num_list(value: Any, field: str = "") -> list[float]:
    items = _pluck(value, field) if field else (value if isinstance(value, list) else [])
    out = []
    for item in items:
        try:
            out.append(float(item))
        except (TypeError, ValueError):
            continue
    return out


def _agg(name: str, values: list[float], field: str = "") -> float:
    nums = _num_list(values, field)
    if not nums:
        return 0
    if name == "sum":
        return sum(nums)
    if name == "avg":
        return sum(nums) / len(nums)
    if name == "min":
        return min(nums)
    if name == "max":
        return max(nums)
    return len(nums)


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _fmt_number(v: float, decimals: int | None) -> str:
    if decimals is None:
        s = f"{v:,.2f}".rstrip("0").rstrip(".")
        return s if s not in ("-0", "") else "0"
    return f"{v:,.{decimals}f}"


def _fn_format(args):
    value = args[0] if args else ""
    kind = str(args[1]) if len(args) > 1 else "number"
    decimals = args[2] if len(args) > 2 else None
    currency = str(args[3]) if len(args) > 3 else "USD"
    try:
        n = float(value)
    except (TypeError, ValueError):
        return str(value)
    if kind == "currency":
        sym = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹"}.get(currency.upper(), currency + " ")
        d = 2 if decimals is None else int(decimals)
        return f"{sym}{n:,.{d}f}"
    if kind == "percent":
        d = 0 if decimals is None else int(decimals)
        return f"{n:.{d}f}%"
    if kind == "compact":
        for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
            if abs(n) >= div:
                return f"{n / div:.1f}{suf}"
        return f"{n:g}"
    return _fmt_number(n, int(decimals) if decimals is not None else None)


def _fn_duration(args):
    seconds = float(args[0]) if args else 0
    style = str(args[1]) if len(args) > 1 else "short"
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if style == "clock":
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
    parts = []
    if h:
        parts.append(f"{h}h")
    if m:
        parts.append(f"{m:02d}m" if h else f"{m}m")
    if s or not parts:
        parts.append(f"{s:02d}s" if (h or m) else f"{s}s")
    return " ".join(parts)


def _fn_format_date(args):
    value = args[0] if args else ""
    style = str(args[1]) if len(args) > 1 else "date"
    d = _parse_date(value) or date.today()
    fmt = {
        "date": "%b %-d, %Y",
        "short": "%b %-d",
        "long": "%A, %B %-d, %Y",
        "weekday": "%A",
        "month": "%B %Y",
        "time": "%H:%M",
        "datetime": "%b %-d, %Y %H:%M",
        "iso": "%Y-%m-%d",
    }.get(style, "%b %-d, %Y")
    try:
        return d.strftime(fmt)
    except ValueError:
        return d.strftime(fmt.replace("%-d", "%d"))


_FUNCTIONS: dict[str, Callable[[list[Any]], Any]] = {
    # Lists
    "Count": lambda a: len(a) if isinstance(a, (list, str, dict)) else 0,
    "First": lambda a: a[0] if isinstance(a, list) and a else None,
    "Last": lambda a: a[-1] if isinstance(a, list) and a else None,
    "Sum": lambda a: _agg("sum", a[0], str(a[1]) if len(a) > 1 else ""),
    "Avg": lambda a: _agg("avg", a[0], str(a[1]) if len(a) > 1 else ""),
    "Min": lambda a: _agg("min", a[0], str(a[1]) if len(a) > 1 else ""),
    "Max": lambda a: _agg("max", a[0], str(a[1]) if len(a) > 1 else ""),
    "Includes": lambda a: (a[1] in a[0]) if len(a) > 1 and isinstance(a[0], (list, str)) else False,
    "Find": lambda a: next((r for r in a[0] if isinstance(r, dict) and r.get(str(a[1])) == a[2]), None) if len(a) > 2 and isinstance(a[0], list) else None,
    "IndexOf": lambda a: a[0].index(a[1]) if isinstance(a[0], list) and a[1] in a[0] else -1,
    "Take": lambda a: (a[0][: int(a[1])] if int(a[1]) >= 0 else a[0][int(a[1]):]) if isinstance(a[0], list) and len(a) > 1 else [],
    "Slice": lambda a: (a[0][int(a[1]) : int(a[2]) if len(a) > 2 else None]) if isinstance(a[0], list) and len(a) > 1 else [],
    "Unique": lambda a: list(dict.fromkeys(a[0])) if isinstance(a[0], list) else [],
    "Reverse": lambda a: list(reversed(a[0])) if isinstance(a[0], list) else [],
    "Range": lambda a: list(range(int(a[0]), int(a[1]), int(a[2]) if len(a) > 2 and a[2] else 1)),
    "Flatten": lambda a: [x for sub in a[0] for x in (sub if isinstance(sub, list) else [sub])] if isinstance(a[0], list) else [],
    "Concat": lambda a: list(a[0] or []) + list(a[1] or []) if isinstance(a[0], list) and isinstance(a[1], list) else [],
    "Append": lambda a: list(a[0] or []) + [a[1]] if isinstance(a[0], list) else [a[1]],
    "Prepend": lambda a: [a[1]] + list(a[0] or []) if isinstance(a[0], list) else [a[1]],
    "RemoveAt": lambda a: (a[0][: int(a[1])] + a[0][int(a[1]) + 1 :]) if isinstance(a[0], list) and len(a) > 1 else [],
    "Chunk": lambda a: [a[0][i : i + int(a[1])] for i in range(0, len(a[0]), max(1, int(a[1])))] if isinstance(a[0], list) and len(a) > 1 else [],
    "Pick": lambda a: a[0][__import__("random").randrange(len(a[0]))] if isinstance(a[0], list) and a[0] else None,
    "Shuffle": lambda a: __import__("random").sample(list(a[0]), len(a[0])) if isinstance(a[0], list) else [],
    # Numbers
    "Pow": lambda a: a[0] ** a[1] if len(a) > 1 else 0,
    "Sqrt": lambda a: a[0] ** 0.5 if a and a[0] >= 0 else None,
    "Random": lambda a: (__import__("random").randint(int(a[0]), int(a[1])) if len(a) > 2 and a[2] else __import__("random").uniform(a[0] if a else 0, a[1] if len(a) > 1 else 1)),
    "Clamp": lambda a: min(max(a[0], a[1]), a[2]) if len(a) > 2 else a[0] if a else 0,
    "Percent": lambda a: (a[0] / a[1] * 100) if len(a) > 1 and a[1] else 0,
    "Lerp": lambda a: a[0] + (a[1] - a[0]) * a[2] if len(a) > 2 else a[0] if a else 0,
    "Round": lambda a: round(a[0], int(a[1]) if len(a) > 1 else 0),
    "Abs": lambda a: abs(a[0]) if a else 0,
    "Floor": lambda a: __import__("math").floor(a[0]) if a else 0,
    "Ceil": lambda a: __import__("math").ceil(a[0]) if a else 0,
    # Text
    "Format": _fn_format,
    "Join": lambda a: str(a[2] if len(a) > 2 else ", ").join(str(x) for x in (_pluck(a[0], str(a[1])) if len(a) > 1 and a[1] else a[0] if isinstance(a[0], list) else [a[0]]) if x is not None),
    "Plural": lambda a: f"{a[0]} {a[1] if abs(a[0]) == 1 else (a[2] if len(a) > 2 and a[2] else str(a[1]) + 's')}",
    "Pad": lambda a: str(a[0]).rjust(int(a[1]), str(a[2]) if len(a) > 2 else "0"),
    "Upper": lambda a: str(a[0]).upper(),
    "Lower": lambda a: str(a[0]).lower(),
    "Trim": lambda a: str(a[0]).strip(),
    "Capitalize": lambda a: str(a[0]).title(),
    "Split": lambda a: [p.strip() for p in str(a[0]).split(str(a[1]) if len(a) > 1 else ",") if p.strip()],
    "Replace": lambda a: str(a[0]).replace(str(a[1]), str(a[2]) if len(a) > 2 else ""),
    "Duration": _fn_duration,
    "Default": lambda a: (a[1] if a and a[0] in (None, "") or (isinstance(a[0], float) and a[0] != a[0]) else a[0]) if a else None,
    # Dates
    "Now": lambda a: datetime.now().isoformat(timespec="seconds"),
    "Today": lambda a: date.today().isoformat(),
    "FormatDate": _fn_format_date,
    "AddDays": lambda a: ((_parse_date(a[0]) or date.today()) + timedelta(days=int(a[1]))).isoformat() if len(a) > 1 else "",
    "AddMonths": lambda a: _add_months(_parse_date(a[0]) or date.today(), int(a[1])).isoformat() if len(a) > 1 else "",
    "DaysBetween": lambda a: ((b := _parse_date(a[1])) - (f := _parse_date(a[0]))).days if len(a) > 1 and b and f else 0,
    "MonthsBetween": lambda a: _months_between(_parse_date(a[0]), _parse_date(a[1])) if len(a) > 1 else 0,
    "StartOf": lambda a: _start_of(_parse_date(a[0]) or date.today(), str(a[1]) if len(a) > 1 else "month").isoformat(),
    # Rows / data
    "GroupBy": lambda a: _fn_group_by(a),
    "Top": lambda a: sorted([r for r in a[0] if isinstance(r, dict)], key=lambda r: r.get(str(a[1]), 0), reverse=not (len(a) > 3 and a[3] == "asc"))[: int(a[2])] if len(a) > 2 and isinstance(a[0], list) else [],
    "Filter": lambda a: _fn_filter(a),
    "Between": lambda a: [r for r in a[0] if isinstance(r, dict) and (a[2] is None or r.get(str(a[1]), 0) >= a[2]) and (a[3] is None or r.get(str(a[1]), 0) <= a[3])] if len(a) > 3 and isinstance(a[0], list) else [],
    "Bucket": lambda a: _fn_bucket(a),
    "Cumulative": lambda a: _fn_cumulative(a),
    "MovingAvg": lambda a: _fn_moving_avg(a),
    "Change": lambda a: ((a[0] - a[1]) / a[1] * 100) if len(a) > 1 and a[1] else None,
    "Stats": lambda a: _fn_stats(a),
}


def _add_months(d: date, months: int) -> date:
    month = d.month - 1 + months
    year = d.year + month // 12
    month = month % 12 + 1
    day = min(d.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date(year, month, day)


def _months_between(a: date | None, b: date | None) -> int:
    if not a or not b:
        return 0
    months = (b.year - a.year) * 12 + (b.month - a.month)
    if b.day < a.day:
        months -= 1
    return months


def _start_of(d: date, unit: str) -> date:
    if unit == "week":
        return d - timedelta(days=d.weekday())
    if unit == "year":
        return date(d.year, 1, 1)
    return date(d.year, d.month, 1)


def _fn_group_by(args):
    rows, key = args[0], str(args[1]) if len(args) > 1 else ""
    field = str(args[2]) if len(args) > 2 else ""
    agg = str(args[3]) if len(args) > 3 else "sum"
    groups: dict[Any, list] = {}
    order: list[Any] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        k = row.get(key)
        if k not in groups:
            groups[k] = []
            order.append(k)
        groups[k].append(row)
    out = []
    for k in order:
        members = groups[k]
        if field:
            value = _agg(agg, members, field)
        else:
            value = len(members) if agg == "count" else _agg(agg, members, "")
        out.append({"key": k, "value": value})
    return out


def _fn_filter(args):
    rows, field = args[0], str(args[1]) if len(args) > 1 else ""
    op = str(args[2]) if len(args) > 2 else "=="
    want = args[3] if len(args) > 3 else None
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        val = row.get(field)
        ok = {
            "==": val == want,
            "!=": val != want,
            ">": isinstance(val, (int, float)) and val > want,
            "<": isinstance(val, (int, float)) and val < want,
            ">=": isinstance(val, (int, float)) and val >= want,
            "<=": isinstance(val, (int, float)) and val <= want,
            "contains": want in val if isinstance(val, (str, list)) else False,
        }.get(op, False)
        if ok:
            out.append(row)
    return out


def _fn_bucket(args):
    rows = args[0] if args else []
    date_field = str(args[1]) if len(args) > 1 else ""
    unit = str(args[2]) if len(args) > 2 else "day"
    field = str(args[3]) if len(args) > 3 else ""
    agg = str(args[4]) if len(args) > 4 else "sum"
    buckets: dict[str, list] = {}
    order: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        d = _parse_date(row.get(date_field))
        if not d:
            continue
        if unit == "week":
            key = (d - timedelta(days=d.weekday())).isoformat()
        elif unit == "month":
            key = d.strftime("%Y-%m")
        else:
            key = d.isoformat()
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append(row)
    return [{"key": k, "value": _agg(agg, buckets[k], field) if field else len(buckets[k])} for k in sorted(order)]


def _fn_cumulative(args):
    rows = args[0] if args else []
    field = str(args[1]) if len(args) > 1 else ""
    if isinstance(rows, list) and rows and not isinstance(rows[0], dict):
        total, out = 0, []
        for v in rows:
            try:
                total += float(v)
            except (TypeError, ValueError):
                pass
            out.append(total)
        return out
    total = 0
    out = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict):
            row = dict(row)
            try:
                total += float(row.get(field, 0) or 0)
            except (TypeError, ValueError):
                pass
            row[field] = total
            out.append(row)
    return out


def _fn_moving_avg(args):
    rows = args[0] if args else []
    field = str(args[1]) if len(args) > 1 else ""
    window = max(1, int(args[2])) if len(args) > 2 else 3
    values = _num_list(rows, field)
    avgs = []
    for i in range(len(values)):
        window_vals = values[max(0, i - window + 1) : i + 1]
        avgs.append(sum(window_vals) / len(window_vals))
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        out = []
        for row, avg in zip(rows, avgs):
            row = dict(row)
            row[field] = avg
            out.append(row)
        return out
    return avgs


def _fn_stats(args):
    nums = _num_list(args[0] if args else [])
    if not nums:
        return {"count": 0, "min": 0, "max": 0, "avg": 0, "sum": 0}
    return {
        "count": len(nums),
        "min": min(nums),
        "max": max(nums),
        "avg": sum(nums) / len(nums),
        "sum": sum(nums),
    }


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


def _eval(node: tuple, env: dict[str, Any]) -> Any:
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "var":
        name = node[1]
        if name not in env:
            raise NoteUIError(f"Undefined variable ${name}")
        return env[name]
    if kind == "arr":
        items = [_eval(item, env) for item in node[1]]
        # An array of component results is a children list, not data.
        if items and all(_is_blocks(item) for item in items):
            flat: list[dict] = []
            for item in items:
                flat.extend(item)
            return flat
        return items
    if kind == "obj":
        return {key: _eval(val, env) for key, val in node[1]}
    if kind == "fn":
        name, arg_nodes = node[1], node[2]
        if name == "Each":
            if len(arg_nodes) != 3 or arg_nodes[1][0] != "lit" or not isinstance(arg_nodes[1][1], str):
                raise NoteUIError('@Each(list, "var", template) needs a list, a variable name and a template')
            source = _eval(arg_nodes[0], env)
            var_name = arg_nodes[1][1]
            if not isinstance(source, list):
                return []
            results = []
            for item in source:
                scoped = dict(env)
                scoped[var_name] = item
                results.append(_eval(arg_nodes[2], scoped))
            if results and all(_is_blocks(r) for r in results):
                flat = []
                for r in results:
                    flat.extend(r)
                return flat
            return results
        fn = _FUNCTIONS.get(name)
        if fn is None:
            raise NoteUIError(f"Unknown function @{name}")
        args = [_eval(a, env) for a in arg_nodes]
        try:
            return fn(args)
        except NoteUIError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise NoteUIError(f"@{name} failed: {exc}") from exc
    if kind == "call":
        name, arg_nodes = node[1], node[2]
        builder = _COMPONENTS.get(name)
        if builder is None:
            raise NoteUIError(f"Unknown component {name}()")
        args = [_eval(a, env) for a in arg_nodes]
        # Builders split a trailing children array off the evaluated args.
        return builder(args, None)
    if kind == "bin":
        op = node[1]
        if op == "&&":
            return bool(_eval(node[2], env)) and bool(_eval(node[3], env))
        if op == "||":
            return bool(_eval(node[2], env)) or bool(_eval(node[3], env))
        left, right = _eval(node[2], env), _eval(node[3], env)
        if op == "+":
            if isinstance(left, str) or isinstance(right, str):
                return _str(left) + _str(right)
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            return left / right if right else None
        if op == "%":
            return left % right if right else None
        if op == "==":
            return left == right
        if op == "!=":
            return left != right
        if op == "<":
            return left < right
        if op == ">":
            return left > right
        if op == "<=":
            return left <= right
        if op == ">=":
            return left >= right
    if kind == "un":
        value = _eval(node[2], env)
        return (not value) if node[1] == "!" else -value
    if kind == "tern":
        return _eval(node[2], env) if _eval(node[1], env) else _eval(node[3], env)
    if kind == "member":
        obj = _eval(node[1], env)
        field = node[2]
        if isinstance(obj, dict):
            return obj.get(field)
        if isinstance(obj, list):
            return [r.get(field) for r in obj if isinstance(r, dict)]
        return None
    if kind == "index":
        obj = _eval(node[1], env)
        idx = _eval(node[2], env)
        try:
            return obj[int(idx)]
        except (TypeError, ValueError, IndexError, KeyError):
            return None
    raise NoteUIError(f"Cannot evaluate {kind}")


def _str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compile_noteui(source: str) -> list[dict[str, Any]]:
    """Compile a ```noteui fence body into validated BlockNote blocks."""
    if not source.strip():
        return []
    program = _Parser(_tokenize(source)).parse_program()
    env: dict[str, Any] = {}
    emitted: list[dict] = []
    for stmt in program:
        if stmt[0] == "bind":
            env[stmt[1]] = _eval(stmt[2], env)
        else:
            value = _eval(stmt[1], env)
            if _is_blocks(value):
                emitted.extend(value)
            elif isinstance(value, list) and value and _is_blocks(value[0]):
                emitted.extend(_as_blocks(value))
            else:
                raise NoteUIError("Top-level expressions must produce components, e.g. Page([...]) or Text(...)")
    if "root" in env:
        root = env["root"]
        if not _is_blocks(root):
            raise NoteUIError("root must be a component or list of components")
        return _as_blocks(root)
    return emitted


# ---------------------------------------------------------------------------
# Serialization: blocks -> DSL (round-trip through ```noteui fences)
# ---------------------------------------------------------------------------


def _dsl_str(text: Any) -> str:
    return json.dumps(str(text), ensure_ascii=False)


def _dsl_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _dsl_children(children: list[dict]) -> str:
    return "[" + ", ".join(block_to_dsl(c) for c in children) + "]"


def _opt_children(children: list[dict], prefix: str) -> str:
    return prefix + (", " + _dsl_children(children) if children else "")


def block_to_dsl(block: dict[str, Any]) -> str:
    """One block as a DSL expression, or raise NoteUIError if unsupported."""
    kind = block.get("type")
    props = block.get("props") or {}
    content = block.get("content")
    children = block.get("children") or []

    def text() -> str:
        from .blocks import inline_markdown

        return inline_markdown(content)

    if kind == "heading":
        return _opt_children(children, f"Heading({int(props.get('level', 1))}, {_dsl_str(text())}") + ")"
    if kind == "toggleHeading":
        return _opt_children(children, f"ToggleHeading({int(props.get('level', 2))}, {_dsl_str(text())}") + ")"
    if kind == "paragraph":
        return f"Text({_dsl_str(text())})"
    if kind == "bulletListItem":
        return _opt_children(children, f"Bullet({_dsl_str(text())}") + ")"
    if kind == "numberedListItem":
        return _opt_children(children, f"Numbered({_dsl_str(text())}") + ")"
    if kind == "checkListItem":
        checked = ", true" if props.get("checked") else ""
        return _opt_children(children, f"CheckItem({_dsl_str(text())}{checked}") + ")"
    if kind == "toggleListItem":
        return _opt_children(children, f"ToggleItem({_dsl_str(text())}") + ")"
    if kind == "quote":
        return _opt_children(children, f"Quote({_dsl_str(text())}") + ")"
    if kind == "callout":
        tone = str(props.get("tone") or "tip")
        return _opt_children(children, f"Callout({_dsl_str(tone)}, {_dsl_str(text())}") + ")"
    if kind == "codeBlock":
        return f"CodeBlock({_dsl_str(props.get('language', ''))}, {_dsl_str(text())})"
    if kind == "divider":
        return "Divider()"
    if kind in ("mathBlock", "math"):
        formula = props.get("formula") or text()
        return f"Math({_dsl_str(formula)})"
    if kind == "image":
        return f"Image({_dsl_str(props.get('url', ''))}, {_dsl_str(props.get('caption', ''))})"
    if kind == "video":
        return f"Video({_dsl_str(props.get('url', ''))}, {_dsl_str(props.get('caption', ''))})"
    if kind == "audio":
        return f"Audio({_dsl_str(props.get('url', ''))}, {_dsl_str(props.get('caption', ''))})"
    if kind == "file":
        return f"File({_dsl_str(props.get('url', ''))}, {_dsl_str(props.get('name', ''))})"
    if kind == "table":
        rows = (content or {}).get("rows", []) if isinstance(content, dict) else []
        body = []
        for row in rows:
            cells = []
            for cell in row.get("cells", []):
                from .blocks import inline_markdown as _im

                cells.append(_dsl_str(_im(cell.get("content") if isinstance(cell, dict) else cell)))
            body.append("[" + ", ".join(cells) + "]")
        return "Table([" + ", ".join(body) + "])"
    if kind == "noteColumns":
        return "Columns(" + _dsl_children(children) + ")"
    if kind == "noteColumn":
        return "Column(" + _dsl_children(children) + ")"
    if kind == "tableOfContents":
        return "TableOfContents()"
    if kind == "webCard":
        return (
            f"WebCard({_dsl_str(props.get('url', ''))}, {_dsl_str(props.get('title', ''))}, "
            f"{_dsl_str(props.get('description', ''))})"
        )
    if kind == "htmlEmbed":
        return f"HtmlEmbed({_dsl_str(props.get('source', ''))})"
    if kind == "taskView":
        return f"TaskView({_dsl_str(props.get('view', 'table'))})"
    if kind == "clip":
        return (
            f"Clip({_dsl_str(props.get('title', ''))}, {_dsl_str(props.get('markdown', ''))}, "
            f"{_dsl_str(props.get('sourceUrl', ''))})"
        )
    if kind == "learning":
        lkind = str(props.get("kind") or "")
        try:
            data = json.loads(props.get("data", "{}"))
        except (TypeError, ValueError):
            data = {}
        markdown = str(props.get("markdown") or "")
        named = {
            "quiz": "Quiz", "flashcards": "Flashcards", "timeline": "Timeline",
            "concept_map": "ConceptMap", "geogebra": "GeoGebra", "research": "Research",
            "task": "Task",
        }
        if lkind in named and isinstance(data, dict) and data:
            return f"{named[lkind]}({_dsl_value(data)})"
        if lkind == "mermaid" and markdown:
            code = re.sub(r"^```mermaid\s*|\s*```$", "", markdown.strip(), flags=re.S)
            return f"Mermaid({_dsl_str(code.strip())})"
        return f"Learning({_dsl_str(lkind)}, {_dsl_value(data) if isinstance(data, dict) else '{}'}, {_dsl_str(markdown)})"
    # Escape hatch: any other valid block serializes as raw BlockNote JSON.
    raw = {k: v for k, v in block.items() if k != "id"}
    return f"Block({_dsl_value(raw)})"


def blocks_to_dsl(blocks: list[dict[str, Any]]) -> str:
    """Serialize blocks to a ```noteui program (Page([...]))."""
    return "Page([\n  " + ",\n  ".join(block_to_dsl(b) for b in blocks) + "\n])"
