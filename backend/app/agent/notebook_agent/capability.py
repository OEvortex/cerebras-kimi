"""Dispatch the notebook writer sub-agent.

Mirrors ``video_lesson.capability``: the main agent only supplies the
learner's request; a dedicated writer sub-agent with its own prompt and a
toolset (``nb_read``/``nb_list``/``nb_search`` plus write tools
``nb_patch`` plus research tools) edits the notebook directly — the same operations a
user performs in the editor.

``background=True`` (the default) registers the run with vtx's
``BackgroundTaskManager`` so the parent turn returns immediately and the
compiled report is delivered automatically on a later turn.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from vtx.agent.tools.task import SubagentSpec, resolve_subagent_runner

from .prompt import load_writer_prompt
from .tools import WRITER_TOOL_NAMES, register_writer_tools

MAX_TURNS = 60


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
            "Work like a user editing the notebook: check existing pages with "
            "nb_list/nb_search first, then make ALL writes with nb_patch — "
            "create pages, apply exact-match edits, append, rewrite, delete, "
            "and move/reparent in atomic batches. Use nb_read (offset/limit) "
            "before editing a page you haven't seen. Your final message is a "
            "short report of what you created or changed — not the content."
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


async def _run_writer_only(
    parent_ctx: Any,
    spec: SubagentSpec,
    prompt: str,
    tool_call_id: str,
    label: str,
) -> Any:
    """Run the writer once; its tools do the editing, text is the report."""
    result = await _run_writer(
        parent_ctx, spec, prompt, tool_call_id, label,
    )
    if result.error and not result.final_text:
        raise RuntimeError(f"Notebook writer failed: {result.error}")
    return result


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

    # Populated after register() returns so the factory can mark the record
    # notified (vtx's between-turn drain must not inject the same report twice).
    record_holder: dict[str, Any] = {}

    async def _factory() -> Any:
        from . import events as notebook_events

        status = "completed"
        report = ""
        try:
            result = await _run_writer_only(
                ctx, spec, prompt, tool_call_id, label,
            )
            report = result.final_text or ""
            return result
        except Exception as exc:  # noqa: BLE001 - still notify on failure
            status = "error"
            report = f"Notebook writer failed: {exc}"
            raise
        finally:
            record = record_holder.get("record")
            if record is not None:
                record.notified = True

            session_id = (
                getattr(ctx, "session_id", None)
                or getattr(getattr(ctx, "session", None), "id", None)
                or ""
            )
            handle = notebook_events.current_turn(session_id)
            await notebook_events.notify_completion(
                session_id=session_id,
                turn_id=handle.turn_id if handle is not None else "",
                task_id=record.task_id if record else tool_call_id,
                label=label,
                report=report,
                status=status,
                error=report if status == "error" else "",
            )
            # Main agent: put the finished report in the session history now,
            # so it is part of context on the next turn even if the learner
            # never comes back to this notebook thread.
            session = getattr(ctx, "session", None)
            if session is not None and hasattr(session, "append_message"):
                try:
                    from vtx.core import UserMessage

                    session.append_message(UserMessage(content=(
                        f"<vtx:background-task-completion> Background task "
                        f"'{label}' (notebook-writer) finished with status "
                        f"{status}. Final answer:\n{report}"
                        "</vtx:background-task-completion>"
                    )))
                except Exception:  # noqa: BLE001 - notification is best effort
                    pass

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
    # register() starts the coroutine immediately; the writer awaits the LLM
    # for minutes before it needs the record, so this assignment lands first.
    record_holder["record"] = record
    marker = json.dumps({
        "task_id": record.task_id,
        "label": label,
        "request": request,
        "title": title,
        "parent_page_id": parent_page_id,
        "tool_call_id": tool_call_id,
    }, ensure_ascii=False)
    return (
        "Notebook job launched in the background.\n"
        f"  task_id: {record.task_id}\n"
        f"  label: {label}\n"
        "The notebook-writer sub-agent is building the pages now (this can "
        "take several minutes). Its report will be delivered automatically "
        "when it finishes — tell the learner the notebook is being built and "
        "they will see the result soon; do not claim the pages already exist.\n"
        f"NOTEBOOK_TASK:{marker}"
    )


__all__ = ["launch_notebook_job"]
