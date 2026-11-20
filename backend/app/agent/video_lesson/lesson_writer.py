"""Parse the video-lesson writer's reply and build its system prompt."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
import re

from .narration import NarrationLine
from .runtime import ASSETS_DIR

_JSON_BLOCK = re.compile(r"```json[ \t]*\n(.*?)\n```", re.S)
_TSX_BLOCK = re.compile(r"```(?:tsx|typescript|ts|jsx)[ \t]*\n(.*?)\n```", re.S)
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


@dataclass
class LessonDraft:
    title: str
    summary: str
    code: str
    raw: str
    narration: list[NarrationLine] = field(default_factory=list)


def parse_draft(reply: str) -> LessonDraft:
    """Extract the JSON metadata and the complete Lesson.tsx from a writer reply."""
    tsx_blocks = _TSX_BLOCK.findall(reply or "")
    if not tsx_blocks:
        raise ValueError("no ```tsx block with a complete Lesson.tsx")
    code = max(tsx_blocks, key=len).strip()

    json_blocks = _JSON_BLOCK.findall(reply or "")
    meta: dict = {}
    for raw in json_blocks:
        try:
            value = json.loads(raw)
        except ValueError:
            continue
        if isinstance(value, dict) and "narration" in value:
            meta = value
            break
    if not meta:
        raise ValueError("no ```json block with title, summary and narration")

    narration = []
    for item in meta.get("narration") or []:
        if not isinstance(item, dict):
            continue
        ident = str(item.get("id") or "").strip()
        text = str(item.get("text") or "").strip()
        if ident and text:
            narration.append(NarrationLine(ident, text))
    if not narration:
        raise ValueError("the json block has no narration entries with an id and text")

    return LessonDraft(
        title=str(meta.get("title") or "").strip(),
        summary=str(meta.get("summary") or "").strip(),
        code=code,
        raw=reply or "",
        narration=narration,
    )


def load_instructions() -> str:
    """The writer's system prompt, with the kit source spliced in.

    ``str.format`` cannot be used here: the kit is TypeScript full of braces.
    """
    template = (_PROMPTS_DIR / "lesson_writer.txt").read_text(encoding="utf-8")
    kit = (ASSETS_DIR / "kit.tsx").read_text(encoding="utf-8")
    return template.replace("{kit_source}", kit)


__all__ = ["LessonDraft", "NarrationLine", "load_instructions", "parse_draft"]
