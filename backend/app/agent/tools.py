"""Built-in tools exposed to the tutor agent.

Tools are registered by name in :func:`builtin_tools`; each tool object carries
its own params model and mutation flag for the permission layer.
"""

from __future__ import annotations

from typing import Any

from ..config import Settings

# Side effect: keep params named "title" in the model-facing tool schema.
from . import _vtx_compat  # noqa: F401


def builtin_tools(settings: Settings, enabled: list[str] | None = None) -> list[Any]:
    """All builtin tools, filtered by the turn's ``tools`` allowlist.

    ``enabled=None`` means "everything"; an empty list also means everything
    (the frontend sends the user's tool selection — absent = unrestricted).
    Names follow DeepTutor's tool catalog (see ``reff/deeptutor/tools``).
    """
    from . import dt_tools
    from . import kb_tools as _kb
    from . import dito

    registry: dict[str, Any] = {
        # DeepTutor portable ports (dt_tools.py)
        "web": dt_tools.web,
        "paper_search": dt_tools.paper_search,
        "notes": dt_tools.notes,
        "question_bank": dt_tools.question_bank,
        "memory": dt_tools.memory,
        "knowledge_base_search": _kb.knowledge_base_search,
        # File-inspection/editing tools are intentionally NOT exposed: DeepTutor
        # is a tutor, not a coding agent. The learner-facing `workspace` tool
        # still handles artifacts the app itself creates (notes, media).
        "learning": dt_tools.learning,
        "workspace": dt_tools.workspace,
        # `ask_user` is intentionally not registered for now.
        "mastery": dt_tools.mastery,
        "video": dt_tools.video,
        # Background notebook builder: dispatches the Co-writer sub-agent
        # (shared prompt + nb_* tools) via vtx's task machinery.
        "notebook": dt_tools.notebook,
        # Scheduled reminders: the run lands in the turn's own session and
        # shows up on the calendar's Automations layer.
        "cron": dt_tools.cron,
        "review": dt_tools.review,
    }
    # DeepTutor semantics: only the user-toggleable tools are gated by the
    # frontend's `tools` list; every other built-in is locked-on and must
    # always reach the model's schema.
    toggleable = {"web", "web_search", "paper_search"}
    # The notebook companion gets its own playbook: read the page and propose
    # reviewable changes (including learning blocks/flashcards). These tools
    # are absent from ordinary chat turns.
    if dito.is_dito_turn():
        registry.update({dito_tool.name: dito_tool for dito_tool in dito.dito_tools()})
        # Dito's toolset is deliberately narrower than the main chat's: no
        # video, cron, mastery, workspace files or question bank.
        for name in list(registry):
            if name not in dito.DITO_TOOL_NAMES:
                registry.pop(name)
    # web_search is the frontend's toggle name for the merged `web` tool.
    enabled = [{"web_search": "web"}.get(n, n) for n in (enabled or [])]
    locked_on = set(registry) - toggleable
    if enabled:
        keep = locked_on | ({n for n in enabled if n in toggleable} & set(registry))
        return [registry[name] for name in registry if name in keep]
    return list(registry.values())
