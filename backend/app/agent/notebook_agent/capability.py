"""Dispatch the notebook writer sub-agent.

Mirrors ``video_lesson.capability``: the main agent only supplies the
learner's request; a dedicated writer sub-agent with its own prompt and a
small navigation toolset (``nb_read``/``nb_list``/``nb_search``/
``nb_update_page`` plus research tools) produces the whole notebook as ONE
Markdown-superset document — the "notebook document" format in
``document.py``. The host compiles that document into the page tree, so the
model needs no write tools: its output IS the notebook.

``background=True`` (the default) registers the run with vtx's
``BackgroundTaskManager`` so the parent turn returns immediately and the
compiled report is delivered automatically on a later turn.
"""

from __future__ import annotations

import uuid
from typing import Any

from vtx.agent.tools.task import SubagentSpec, resolve_subagent_runner

from .document import compile_notebook, format_report
from .prompt import load_writer_prompt
from .tools import WRITER_TOOL_NAMES, register_writer_tools

MAX_TURNS = 60
MAX_ATTEMPTS = 2


def _build_prompt(request: str, title: str, parent_page_id: str) -> str:
    parts = [
        "Build the learner's notebook now.\n",
        f"Title hint: {title.strip()}\n" if title.strip() else "",
        (
            f"Parent page: {parent_page_id.strip()} — pages without an "
            "explicit `parent:` are created under this page.\n"
            if parent_page_id.strip()
            else "Parent page: none — top-level pages go to the notebook root.\n"
        ),
        "Learner request:\n" + request.strip() + "\n",
        (
            "First check the notebook with nb_list/nb_search so the document "
            "extends existing pages instead of duplicating them. Your entire "
            "final message must be the notebook document — no preamble, no "
            "report."
        ),
    ]
    return "".join(p for p in parts if p)


async def _run_writer(
    parent_ctx: Any,
    spec: SubagentSpec,
    prompt: str,
    tool_call_id: str,
    label: str,
) -> Any:
    return await resolve_subagent_runner()(
        parent_ctx=parent_ctx,
        spec=spec,
        prompt=prompt,
        cancel_event=None,
        model_override=None,
        progress_callback=parent_ctx.progress_callback,
        tool_call_id=tool_call_id,
        label=label,
    )


async def _run_and_compile(
    parent_ctx: Any,
    spec: SubagentSpec,
    prompt: str,
    tool_call_id: str,
    label: str,
    *,
    parent_page_id: str,
    fallback_title: str,
) -> Any:
    """Run the writer, then compile its document into pages.

    On a compile failure the writer gets one retry with the error as
    feedback (same pattern as the video lesson's frame-check loop).
    """
    feedback = ""
    last_error = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        attempt_prompt = prompt
        if feedback:
            attempt_prompt += (
                "\n\nYour previous document could not be compiled:\n"
                + feedback[:4000]
                + "\nOutput the corrected notebook document again — the "
                "entire final message, nothing else."
            )
        result = await _run_writer(
            parent_ctx, spec, attempt_prompt,
            f"{tool_call_id}_a{attempt}", label,
        )
        if result.error and not result.final_text:
            raise RuntimeError(f"Notebook writer failed: {result.error}")
        try:
            report = compile_notebook(
                result.final_text or "",
                parent_page_id=parent_page_id,
                fallback_title=fallback_title,
            )
        except Exception as exc:  # noqa: BLE001 - feed back, then retry
            last_error = str(exc)
            feedback = f"Compilation failed: {exc}"
            continue
        result.final_text = format_report(report, fallback_title=fallback_title)
        return result
    raise RuntimeError(
        f"Notebook writer failed: the document could not be compiled after "
        f"{MAX_ATTEMPTS} attempts. {last_error[:400]}"
    )


async def launch_notebook_job(
    *,
    request: str,
    title: str = "",
    parent_page_id: str = "",
    background: bool = True,
    tool_call_id: str | None = None,
) -> str:
    """Dispatch the notebook writer; returns the tool-result text.

    Raises ``RuntimeError`` with a user-facing prefix on failure.
    """
    from vtx.agent.dispatcher import get_context

    register_writer_tools()
    ctx = get_context()
    if ctx is None:
        raise RuntimeError(
            "Notebook writer failed: dispatcher context not initialized."
        )

    spec = SubagentSpec(
        name="notebook-writer",
        description="Writes the learner's notebook as one document",
        instructions=load_writer_prompt(),
        instructions_mode="replace",
        tools_allow=list(WRITER_TOOL_NAMES),
        tools_deny=[],
        max_turns=MAX_TURNS,
    )
    label = (title or request or "Notebook").strip()[:48]
    prompt = _build_prompt(request, title, parent_page_id)
    tool_call_id = tool_call_id or f"notebook_{uuid.uuid4().hex[:12]}"

    async def _factory() -> Any:
        return await _run_and_compile(
            ctx, spec, prompt, tool_call_id, label,
            parent_page_id=parent_page_id, fallback_title=title,
        )

    if not background:
        result = await _factory()
        return result.final_text or "Notebook writer finished without a report."

    from vtx.agent.background import get_manager

    manager = ctx.background_manager or get_manager()
    if manager is None:
        raise RuntimeError(
            "Notebook writer failed: no background task manager is installed."
        )

    record = await manager.register(
        description=label,
        prompt=prompt,
        subagent_type=spec.name,
        model=ctx.model,
        parent_session_id=getattr(ctx, "session_id", None)
        or getattr(getattr(ctx, "session", None), "id", None),
        run_coro_factory=_factory,
    )
    return (
        "Notebook job launched in the background.\n"
        f"  task_id: {record.task_id}\n"
        f"  label: {label}\n"
        "The notebook-writer sub-agent is building the pages now (this can "
        "take several minutes). Its report will be delivered automatically "
        "when it finishes — tell the learner the notebook is being built and "
        "they will see the result soon; do not claim the pages already exist."
    )


__all__ = ["launch_notebook_job"]
