"""Load the shared Co-writer system prompt.

This prompt is the single source of truth for the Co-writer agent, whether it
runs as the sub-agent dispatched by the main assistant's ``notebook`` tool or
as the companion working beside an open page in the notebook chat.
"""

from __future__ import annotations

from pathlib import Path

_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "co_writer.txt"


def load_co_writer_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8").strip()


# Backwards-compatible alias for code still using the old name.
load_writer_prompt = load_co_writer_prompt


__all__ = ["load_co_writer_prompt", "load_writer_prompt"]
