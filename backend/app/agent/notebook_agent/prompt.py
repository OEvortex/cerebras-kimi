"""Load the notebook writer's system prompt."""

from __future__ import annotations

from pathlib import Path

_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "writer.txt"


def load_writer_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8").strip()


__all__ = ["load_writer_prompt"]
