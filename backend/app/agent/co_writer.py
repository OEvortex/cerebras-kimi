"""Co-writer — the notebook pairing agent.

The Co-writer chat beside an open page and the sub-agent dispatched by the
main assistant's ``notebook`` tool are the *same* agent: they share one system
prompt (``notebook_agent/prompts/co_writer.txt``) and one tool list
(``notebook_agent.tools.COWRITER_TOOL_NAMES``). This module supplies the
notebook-turn context and exposes that shared prompt/tool list to the chat
runtime. Page edits are applied directly with ``nb_patch``.
"""

from __future__ import annotations

from typing import Any

from .notebook_agent.prompt import load_co_writer_prompt
from .notebook_agent.tools import COWRITER_TOOL_NAMES

# One prompt and one tool list for both faces of the Co-writer agent: the chat
# beside an open page and the sub-agent the main assistant's `notebook` tool
# dispatches.
CO_WRITER_SYSTEM_PROMPT = load_co_writer_prompt()
CO_WRITER_OWN_TOOL_NAMES = COWRITER_TOOL_NAMES
CO_WRITER_TOOL_NAMES = COWRITER_TOOL_NAMES


def is_co_writer_turn() -> bool:
    """True when the running turn is bound to a Co-Writer page."""
    from .turn_context import note_context

    return bool(note_context()[0])


def notebook_context_block(page_id: str, session_id: str, block_id: str, kind: str) -> str:
    """Page/thread anchor and generation instructions for a notebook turn."""
    parts: list[str] = []
    try:
        from ..services.documents.storage import get_co_writer_storage
        from ..services.documents.threads import list_threads

        storage = get_co_writer_storage()
        doc = storage.load_document(page_id)
        if doc is not None:
            parts.append(f'Open notebook page: "{doc.title}".')
            for thread in list_threads(storage, page_id):
                if thread.get("session_id") != session_id:
                    continue
                quote = str(thread.get("quote") or "").strip()
                if quote:
                    parts.append(f'The learner had selected: "{quote[:600]}".')
                if thread.get("block_id"):
                    parts.append(
                        '"Here", "this part" and "this sentence" mean that '
                        "passage. Place material next to it and leave the rest of the page alone."
                    )
                break
    except Exception:  # noqa: BLE001 - context must never block a turn
        pass
    if block_id:
        parts.append(
            f"This turn fills learning block {block_id} (kind {kind or 'chat'}) on the page. "
            "Read the page, then use `nb_patch` update with edits[] to replace that block only. In your visible "
            "reply, describe only the learning material."
        )
    return ("\n\n# This notebook thread\n\n" + "\n".join(parts)) if parts else ""


def co_writer_tools() -> list[Any]:
    """The shared Co-writer toolset, in exposure order.

    The same tools are allowed for the sub-agent dispatched by the main
    assistant's ``notebook`` tool (see ``notebook_agent.tools``).
    """
    from .notebook_agent.tools import shared_tools, writer_tools

    return writer_tools() + shared_tools()


__all__ = [
    "CO_WRITER_OWN_TOOL_NAMES",
    "CO_WRITER_SYSTEM_PROMPT",
    "CO_WRITER_TOOL_NAMES",
    "co_writer_tools",
    "is_co_writer_turn",
    "notebook_context_block",
]
