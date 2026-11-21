"""Prompts and operation history for Co-Writer AI edits.

Three entry points share one shape: take draft text, ask the configured model
for a replacement, return clean Markdown. Every operation is appended to the
shared ``kv`` state so the UI can show what the AI changed.
"""

from __future__ import annotations

import os
import time
from typing import Any

from ...config import get_settings
from ...store import database
from ..llm_text import clean_thinking_tags

MAX_HISTORY = 200
_HISTORY_KEY = "documents/history"

ACTION_VERBS = {
    "rewrite": "Rewrite",
    "shorten": "Shorten",
    "expand": "Expand",
    "polish": "Polish",
    "continue": "Continue",
}

MODE_INSTRUCTIONS = {
    "rewrite": "Rewrite this markdown snippet while preserving its meaning, structure, and tone.",
    "shorten": "Shorten this markdown snippet while preserving the key information.",
    "expand": "Expand this markdown snippet with helpful detail while keeping the original style.",
    "none": "Edit this markdown snippet according to the user's request.",
}

AUTO_MARK_SYSTEM = """\
You are a reading annotation assistant. The result is inserted into an editable Markdown draft, so every annotation must be readable as plain text.

Preserve the original wording, punctuation, paragraphs, and Markdown. Insert only these visible inline markers:
- 【term】 for a short key concept, name, or numerical value.
- 《statement》 for a short definition, finding, or conclusion.

Mark sparingly: at most one term per 100 characters and two statements per paragraph. Do not nest markers or wrap Markdown syntax such as `**` and backticks. Never output HTML, XML, CSS, or data attributes. If nothing needs annotation, return the original text unchanged. Output only the marked draft.
"""

EDIT_SYSTEM = "You are an expert editor and writing assistant."


def load_history() -> list[dict[str, Any]]:
    raw = database.get_state(get_settings(), _HISTORY_KEY, [])
    return raw if isinstance(raw, list) else []


def append_history(entry: dict[str, Any]) -> None:
    entries = load_history()
    entries.insert(0, entry)
    database.put_state(get_settings(), _HISTORY_KEY, entries[:MAX_HISTORY])


def new_operation_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S") + "_" + os.urandom(3).hex()


def strip_fence(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        lines = cleaned.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip()
    return cleaned


def clean_output(text: str) -> str:
    return strip_fence(clean_thinking_tags(text))


def edit_prompt(text: str, instruction: str, action: str) -> tuple[str, str]:
    verb = ACTION_VERBS.get(action, "Edit")
    prompt = (
        f"{verb} the following text based on the user's instruction.\n\n"
        f"User Instruction: {instruction or verb}\n\n"
        "Target Text to Edit:\n"
        f"{text}\n\n"
        "Output only the edited text, without quotes or explanations."
    )
    return EDIT_SYSTEM, prompt


def react_edit_prompt(
    *,
    selected_text: str,
    instruction: str,
    mode: str,
    context: str = "",
) -> tuple[str, str]:
    user_instruction = instruction.strip() or MODE_INSTRUCTIONS.get(
        mode, MODE_INSTRUCTIONS["none"]
    )
    context_block = (
        f"Reference material (use what is relevant, ignore the rest):\n{context}\n\n"
        if context
        else ""
    )
    prompt = (
        "You are editing a text selection from a Markdown editor.\n\n"
        f"Edit mode: {mode}\n"
        f"User request: {user_instruction}\n\n"
        f"{context_block}"
        "Selected text to edit:\n"
        "```markdown\n"
        f"{selected_text}\n"
        "```\n\n"
        "Requirements:\n"
        "1. Output only the edited Markdown snippet for direct replacement.\n"
        "2. Do not include explanations, headings, prefixes, suffixes, or code fences.\n"
        "3. Keep the Markdown valid.\n"
        "4. If reference material is given, weave the relevant facts in naturally "
        "without mentioning tools or sources.\n"
    )
    return EDIT_SYSTEM, prompt


def automark_prompt(text: str) -> tuple[str, str]:
    return AUTO_MARK_SYSTEM, f"Process the following text:\n{text}"


def record(
    *,
    operation_id: str,
    action: str,
    model: str,
    original: str,
    edited: str,
    instruction: str = "",
    mode: str = "",
    tools: list[str] | None = None,
    kb_name: str | None = None,
) -> None:
    append_history(
        {
            "id": operation_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "action": action,
            "mode": mode,
            "tools": tools or [],
            "kb_name": kb_name,
            "input": {"text": original[:4000], "instruction": instruction},
            "output": {"edited_text": edited[:4000]},
            "model": model,
        }
    )
