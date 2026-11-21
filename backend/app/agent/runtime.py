"""Turn runtime: builds vtx Agents and maps the SDK event stream onto the
DeepTutor web turn protocol (``web/contracts/generated/turn-protocol.ts``).

Event mapping (vtx SDK → wire):

======================================  ======================================
vtx event                                wire StreamEvent
======================================  ======================================
``_AgentStartEvent``                     ``stage_start`` (once per turn)
``_TextDelta``                           ``content``
``_ToolCallEnd`` (arguments known)       ``tool_call``
``_ToolResult``                          ``tool_result``
run finished                             ``result`` then ``done``
exception / guardrail trip               ``error`` then ``done`` (failed)
cancellation set                         ``done`` (cancelled)
======================================  ======================================

Known SDK gaps we design around:

  ``thinking`` wire event is therefore unused until vtx exposes them.
* Approvals pause a run via ``RunState`` but cannot be resumed through
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from vtx.agent.tools.base import BaseTool
from vtx.core.events import AskUserEvent
from vtx.core.permissions import AskUserAnswer, AskUserResponse
from vtx.protocol.types import ToolResult

from .. import provider_config
from ..config import Settings
from . import _vtx_compat  # noqa: F401 - schema shim, side effect only
from ..services.inline_thinking import InlineThinkingSplitter
from ..store.session_store import AUTO_PARENT_MESSAGE, SessionStore
from .turn_context import set_note_context, set_turn_context

log = logging.getLogger("deeptutor.runtime")

PROTOCOL_VERSION = "2.0"

def _tool_result_text(out: Any) -> str:
    """Readable text from a vtx ``ToolResultMessage``.

    The default ``str(result)`` / ``json.dumps`` path yields a repr like
    ``role='tool_result' ... content=[TextContent(...)]`` which buries the
    actual tool output — including failures — from the user-facing trace.
    """
    value = getattr(out, "output", None)
    if value is None:
        content = getattr(out, "content", None)
        if isinstance(content, (list, tuple)):
            parts: list[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict):
                    parts.append(str(part.get("text") or part.get("content") or ""))
                else:
                    txt = getattr(part, "text", None)
                    if txt is not None:
                        parts.append(str(txt))
            value = "\n".join(p for p in parts if p.strip())
        elif content is not None:
            value = content
    if value is None:
        value = out if isinstance(out, str) else json.dumps(
            out, ensure_ascii=False, default=str
        )
    return str(value)


def _tool_result_is_error(out: Any, text: str) -> bool:
    """Tools return plain strings, so failure text must be detected too."""
    if getattr(out, "is_error", False):
        return True
    head = text.strip().lower()
    return head.startswith((
        "render failed", "video sub-agent failed", "error:", "failed:",
        "traceback", "unavailable:",
    ))


@contextlib.contextmanager
def _suppress_vtx_selection_writes():
    """vtx's initialize() persists last_selected/recent_models into its own
    config file. DeepTutor owns selection now, so make those writes no-ops
    for the duration of initialization."""
    import vtx.agent.runtime as _vr

    saved: dict[str, Any] = {}
    for name in ("set_last_selected", "add_recent_model"):
        saved[name] = getattr(_vr, name)
        setattr(_vr, name, lambda *a, **k: None)
    try:
        yield
    finally:
        for name, fn in saved.items():
            setattr(_vr, name, fn)


# underscore-prefixed and not exported, so we match on type name — the same
# dispatch the SDK docs recommend.
def _event_name(event: Any) -> str:
    return type(event).__name__


@dataclass
class TurnHandle:
    turn_id: str
    session_id: str
    status: str = "running"
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    events: list[dict[str, Any]] = field(default_factory=list)
    seq: int = 0
    # Stable id used by the frontend to group one model call's trace rows.
    call_id: str = ""
    # Set once post-``done`` work (title generation) has finished or was never
    # needed. Event pumps wait on this before closing so frames the runtime
    # settles after the turn can still reach the open client.
    settled: asyncio.Event = field(default_factory=asyncio.Event)
    # Live session dict the turn is writing to. Events are recorded into it
    # as they are emitted so a client that misses live frames (short turn,
    # late pump subscription, reconnect) can replay them from the store.
    session_ref: dict[str, Any] | None = None
    # Title request fired at turn start, in parallel with the reply. The
    # result is published as ``session_meta`` only if the turn completes.
    title_task: asyncio.Task[str | None] | None = None

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq



class _SdkToolAdapter(BaseTool):
    """Adapt a vtx SDK ``@tool`` FunctionTool to the ``BaseTool`` interface
    ConversationRuntime expects."""

    def __init__(self, fn: Any) -> None:
        self._fn = fn
        self.name = getattr(fn, "name", "tool")
        self.description = getattr(fn, "description", "") or ""
        self.tool_icon = getattr(fn, "tool_icon", "🛠️")
        params = getattr(fn, "params", None)
        self.params = params if isinstance(params, type) else dict
        self.mutating = bool(getattr(fn, "mutating", True))

    def format_call(self, params: Any) -> str:
        return self.name

    def format_preview(self, params: Any) -> str | None:
        return None

    async def execute(self, params: Any, cancel_event: Any = None) -> ToolResult:
        try:
            res = await self._fn.execute(params)
            # Class-based tools already return a ToolResult — pass it through
            # so success=False and ui fields survive instead of being wrapped
            # into a successful string result.
            if isinstance(res, ToolResult):
                return res
            text = getattr(res, "result", None)
            if text is None:
                text = str(res)
            return ToolResult(success=True, result=str(text))
        except Exception as exc:  # noqa: BLE001
            return ToolResult(success=False, result=f"{self.name} error: {exc}")



class AgentRuntime:
    """Owns sessions, turns, and the vtx agent loop for the REST/SSE endpoint."""

    def __init__(self, settings: Settings, store: SessionStore) -> None:
        self._settings = settings
        self._store = store
        # vtx rebuilds its provider model list on every session init and each
        # entry re-scans the whole models.dev table for limits: measured 5.8s of
        # the first turn's latency, 1.9s on later sessions. The caches below are
        # behaviour-preserving (see their module docstrings).
        from .vtx_catalog_cache import (
            install_context_limit_cache,
            install_model_fetch_cache,
        )

        install_context_limit_cache()
        install_model_fetch_cache()
        self._turns: dict[str, TurnHandle] = {}
        self._vtx_runtimes: dict[str, Any] = {}
        self._session_locks: dict[str, asyncio.Lock] = {}
        # turn_id -> (future to resolve, tool_call_id, question prompts by id)
        self._ask_user_waiters: dict[str, tuple[Any, str, dict[str, str]]] = {}
        # Keeps post-turn work (title generation) from being garbage collected
        # before it runs. Nothing awaits these; failures are logged there.
        self._background_tasks: set[asyncio.Task[Any]] = set()

    # -- turn registry ----------------------------------------------------

    def active_turn_for_session(self, session_id: str) -> TurnHandle | None:
        for turn in self._turns.values():
            if turn.session_id == session_id and turn.status == "running":
                return turn
        return None

    def get_turn(self, turn_id: str) -> TurnHandle | None:
        return self._turns.get(turn_id)

    async def resolve_ask_user(
        self,
        turn_id: str,
        text: str,
        answers: list[dict[str, Any]],
    ) -> bool:
        """Feed a learner's answer into a paused ask_user tool call.

        Resolves the SDK's future so the same turn resumes with the answer
        substituted into the tool result. Emits the resolution event the UI
        uses to seal the question card. Returns False when no question is
        currently waiting on this turn (e.g. after a backend restart).
        """
        waiter = self._ask_user_waiters.pop(turn_id, None)
        if waiter is None:
            return False
        future, tool_call_id, prompts = waiter
        resolved: list[dict[str, Any]] = []
        sdk_answers: list[AskUserAnswer] = []
        for a in answers:
            if not isinstance(a, dict):
                continue
            qid = str(a.get("questionId") or a.get("id") or "").strip()
            value = str(a.get("text") or "").strip()
            question = prompts.get(qid, qid)
            resolved.append({"questionId": qid, "text": value})
            if value:
                sdk_answers.append(
                    AskUserAnswer(question=question, kind="custom", answer=value)
                )
        if text.strip() and not sdk_answers:
            # Legacy flat reply: attribute it to the first pending question.
            first = next(iter(prompts.values()), "")
            sdk_answers.append(
                AskUserAnswer(question=first, kind="custom", answer=text.strip())
            )
        response = AskUserResponse(
            custom_text=text.strip() or None,
            answers=tuple(sdk_answers),
        )
        if future is not None and not future.done():
            future.set_result(response)
        handle = self._turns.get(turn_id)
        if handle is not None:
            await self._emit(handle, self._stream_event(
                handle, "progress", source="ask_user", stage="responding",
                metadata={
                    "ask_user_resolved": True,
                    "ask_user_tool_call_id": tool_call_id,
                    "answers": resolved,
                    "reply_preview": text.strip(),
                }))
        return True

    def _lock_for(self, session_id: str) -> asyncio.Lock:
        return self._session_locks.setdefault(session_id, asyncio.Lock())

    # -- agent construction -------------------------------------------------

    @staticmethod
    def _stream_event(
        turn: TurnHandle,
        etype: str,
        *,
        content: str = "",
        source: str = "",
        stage: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "type": etype,
            "protocol_version": PROTOCOL_VERSION,
            "seq": turn.next_seq(),
            "session_id": turn.session_id,
            "turn_id": turn.turn_id,
            "timestamp": time.time(),
            "source": source,
            "stage": stage,
            "content": content,
            "metadata": metadata or {},
        }

    @staticmethod
    def _context_budget(runtime: Any, session: dict[str, Any], usage: Any) -> dict[str, Any]:
        """Build the context-budget payload for the composer's context bar."""
        def tokens(value: Any) -> int:
            if isinstance(value, list):
                value = "".join(
                    str(b.get("text") or "") if isinstance(b, dict) else str(b)
                    for b in value
                )
            return max(0, len(str(value or "")) // 4)

        segments: list[dict[str, Any]] = []
        segments.append({
            "key": "messages",
            "tokens": sum(tokens(m.get("content")) for m in session.get("messages") or []),
        })
        prompt = str(getattr(getattr(runtime, "agent", None), "_system_prompt", "") or "")
        segments.append({"key": "system_prompt", "tokens": tokens(prompt)})
        segments.append({
            "key": "system_tools",
            "tokens": 120 * len(getattr(runtime, "tools", None) or []),
        })
        estimated_used = sum(seg["tokens"] for seg in segments)

        window = 0
        try:
            from ..config import get_settings

            selection = provider_config.get_selection(get_settings())
            profile_id = (selection or {}).get("profile_id") or ""
            model_id = (selection or {}).get("model_id") or ""
            window = provider_config.context_window_for(profile_id, model_id)
        except Exception:  # noqa: BLE001
            pass
        window_estimated = window <= 0
        if window_estimated:
            window = 200_000

        # Cached prompt tokens are billed separately from ``input_tokens``.
        # On a cached turn the provider can report only a few hundred input
        # tokens while the window actually holds tens of thousands of cached
        # ones. Counting just input_tokens is what made the bar read
        # "374 / 200k (0%)" beside segments summing to ~12k. All three fields
        # are prompt-side tokens and all occupy the context window.
        prompt_tokens = 0
        if usage is not None:
            for field in ("input_tokens", "cache_read_tokens", "cache_write_tokens"):
                prompt_tokens += int(getattr(usage, field, 0) or 0)
        used = prompt_tokens if prompt_tokens > 0 else estimated_used

        # The breakdown is a character-based estimate, so on its own it never
        # adds up to the provider's measured total. Scale the segments to
        # ``used`` (keeping their relative shares) so the stacked bar, the
        # segment rows and free space all describe the same budget. The final
        # segment absorbs the rounding so the sum matches exactly.
        if 0 < estimated_used and used != estimated_used:
            remaining = used
            for index, segment in enumerate(segments):
                if index == len(segments) - 1:
                    value = remaining
                else:
                    value = min(remaining, round(segment["tokens"] * used / estimated_used))
                value = max(0, value)
                segment["tokens"] = value
                remaining -= value

        return {
            "window": window,
            "window_estimated": window_estimated,
            "used_tokens": used,
            "free_tokens": max(0, window - used),
            "model": f"{getattr(runtime, 'model_provider', '')}/{getattr(runtime, 'model', '')}".strip("/"),
            "counter": "provider_usage" if prompt_tokens > 0 else "heuristic",
            "segments": segments,
        }

    async def _emit(self, turn: TurnHandle, event: dict[str, Any]) -> None:
        turn.events.append(event)
        # Mirror into the session record so turn_events_after() can replay the
        # suffix once the in-memory handle is dropped on completion. The dict
        # is persisted once the turn finalizes (not on every token).
        if turn.session_ref is not None:
            self._store.record_turn_event(turn.session_ref, turn.turn_id, event)
        dead: list[asyncio.Queue] = []
        for queue in turn.subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            turn.subscribers.discard(queue)

    # -- turn execution ------------------------------------------------------

    async def start_turn(
        self,
        command: dict[str, Any],
    ) -> tuple[TurnHandle | None, dict[str, Any] | None, str | None]:
        """Validate and launch a turn. Returns (handle, session_event, error).

        The returned ``session_event`` must be emitted first so the client
        learns the (possibly new) session_id before stream events arrive.
        """
        content = str(command.get("content") or "")
        attachments = command.get("attachments") or []
        if not content.strip() and not attachments:
            return None, None, "Turn content must not be empty"

        session_id = (command.get("session_id") or "").strip() or None
        session = self._store.get(session_id) if session_id else None
        if session is None:
            session = self._store.create(
                preferences={"workspace_id": command.get("workspace_id")}
            )

        capability = (command.get("capability") or "chat").strip() or "chat"
        turn_id = _new_id("turn")
        handle = TurnHandle(
            turn_id=turn_id,
            session_id=session["id"],
            session_ref=session,
            call_id=f"call_{uuid.uuid4().hex[:12]}",
        )
        self._turns[turn_id] = handle

        # Persist the user row up front so a crash never loses the prompt.
        user_message = self._store.append_user_message(
            session,
            content,
            attachments=attachments,
            metadata={"capability": capability, "turn_id": turn_id},
            parent_message_id=command.get(
                "parent_message_id", AUTO_PARENT_MESSAGE
            ),
        )
        session["status"] = "running"
        session["last_input"] = content
        self._store.save(session)

        session_event = self._stream_event(
            handle,
            "session",
            metadata={"session_id": session["id"], "turn_id": turn_id},
        )

        # Fire the title request now, in parallel with the turn: it only
        # needs the user's first message, so by the time ``done`` lands the
        # HTTP call has usually already finished and publishing costs nothing.
        # ``title_auto`` stays set until the turn completes — a failed or
        # cancelled first turn must not consume the one-shot title attempt.
        if session.get("title_auto"):
            handle.title_task = self._start_title_request(content)

        # Tools that need to know who is asking (cron) read these; the turn
        # task copies this context, so each turn sees only its own values.
        set_turn_context(
            session["id"],
            str(command.get("workspace_id") or session.get("preferences", {}).get("workspace_id") or ""),
        )
        # A notebook thread is an ordinary chat session bound to a Co-Writer
        # page. Keep the binding on the session so later turns inherit it even
        # when the client does not resend it.
        note_doc = str(
            command.get("note_document_id")
            or session.get("preferences", {}).get("note_document_id")
            or ""
        ).strip()
        note_generation = command.get("note_generation") or {}
        if note_doc:
            session.setdefault("preferences", {})["note_document_id"] = note_doc
            self._store.save(session)
        set_note_context(
            note_doc,
            str(note_generation.get("block_id") or "") if isinstance(note_generation, dict) else "",
            str(note_generation.get("kind") or "") if isinstance(note_generation, dict) else "",
        )
        task = asyncio.create_task(
            self._run(handle, session, command, user_message)
        )
        task.add_done_callback(lambda _t: self._turns.pop(turn_id, None))
        return handle, session_event, None

    async def _run_vtx(
        self,
        handle: TurnHandle,
        session: dict[str, Any],
        command: dict[str, Any],
        user_message: dict[str, Any],
    ) -> bool:
        """Drive a turn through vtx's ConversationRuntime (coding_agent path).

        Streams ThinkingDeltaEvent live — unlike the SDK Runner which buffers
        reasoning. Returns True if the turn completed through this path.
        """
        try:
            from vtx.agent.runtime import ConversationRuntime
            from vtx.core.config import config as vtx_config
            from vtx.core.events import (
                AgentEndEvent, ErrorEvent, TextDeltaEvent, ThinkingDeltaEvent,
                ToolApprovalEvent, ToolEndEvent, ToolResultEvent, ToolStartEvent,
            )
            from vtx.core.permissions import ApprovalResponse
        except Exception:  # noqa: BLE001
            return False

        capability = (command.get("capability") or "chat").strip() or "chat"
        content = str(command.get("content") or "")
        attachments = command.get("attachments") or []
        prompt = content
        if attachments:
            notes = [f"[Attachment: {a.get('filename') or a.get('id') or 'attachment'}]"
                     + (f"\n{a['extracted_text']}" if a.get("extracted_text") else "")
                     for a in attachments]
            prompt = "\n\n".join(([content] if content else []) + notes)

        # Per-session runtime cache — ConversationRuntime owns the vtx session.
        cache_key = session["id"]
        runtime = self._vtx_runtimes.get(cache_key)
        if runtime is None:
            try:
                # Mirror the vtx coding agent's _ensure_agent: agent registry,
                # plugin extensions, then ConversationRuntime + prepare_for_run.
                import os as _os
                from vtx.agent.agents import AgentRegistry, load_all_agents
                from vtx.plugins.extensions import load_for_runtime

                cwd = str(self._settings.workspace_dir)
                # Model/provider/base_url/key all come from DeepTutor's own
                # catalog — nothing is read from ~/.vtx for selection.
                resolved = provider_config.resolve_runtime_model(self._settings, command)
                provider = resolved["provider"]
                model = resolved["model"] or str(session.get("model") or "")
                if not model:
                    raise RuntimeError("no model configured — pick one in Settings → LLM")
                base_url = resolved["base_url"]
                api_key = resolved["api_key"]
                thinking_level = command.get("thinking_level") or resolved["thinking_level"]

                agent_registry = AgentRegistry()
                loaded_agents, agent_errors = load_all_agents(cwd=cwd)
                agent_registry.agents = loaded_agents
                agent_registry.errors = agent_errors
                desired = (_os.environ.get("VTX_AGENT")
                           or (vtx_config.agents.default or None))
                if desired:
                    agent_registry.set_active(desired)

                loaded_extensions = load_for_runtime(cwd=cwd)
                ext_tools = list(loaded_extensions.list_extension_tools())
                if agent_registry.active is not None:
                    ext_tools.extend(agent_registry.active.local_tools.values())
                    ext_tools.extend(
                        loaded_extensions.local_tools_for(
                            agent_registry.active.definition.name))
                from .tools import builtin_tools as _bt
                fns = _bt(self._settings, command.get("tools"))
                tools = [_SdkToolAdapter(t) for t in fns] + ext_tools

                runtime = ConversationRuntime(
                    cwd=cwd, model=model, model_provider=provider,
                    api_key=api_key, base_url=base_url,
                    thinking_level=thinking_level,
                    tools=tools,
                    extensions=loaded_extensions.bus,
                    agent_registry=agent_registry,
                    active_agent=agent_registry.active,
                    agent_extensions=list(loaded_extensions.extensions),
                )
                runtime.set_loaded_extensions(loaded_extensions)
                # Bind this DeepTutor record while vtx builds its Session, so
                # the session's entries are loaded from / saved to our JSON
                # document instead of ~/.vtx/sessions/*.jsonl.
                from .dt_session import bind as bind_dt_session, unbind as unbind_dt_session

                dt_token = bind_dt_session(self._store, session)
                try:
                    with _suppress_vtx_selection_writes():
                        init = await asyncio.to_thread(runtime.initialize)
                finally:
                    unbind_dt_session(dt_token)
                if getattr(init, "provider_error", None):
                    raise RuntimeError(str(init.provider_error))
                agent = await asyncio.to_thread(runtime.prepare_for_run)
                if agent is None:
                    raise RuntimeError("agent initialization failed")

                # MCP + hooks, mirroring coding_agent: failures warn, never
                # fail the run.
                try:
                    await runtime.connect_mcp()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    from pathlib import Path
                    from vtx.agent.hooks.bridge import HookBridge
                    hb = HookBridge(
                        bus=loaded_extensions.bus,
                        project_path=Path(cwd) / ".vtx" / "hooks.yml",
                        global_path=Path.home() / ".vtx" / "hooks.yml",
                    )
                    await hb.load()
                except Exception:  # noqa: BLE001
                    pass
                self._vtx_runtimes[cache_key] = (runtime, agent)
            except Exception as exc:  # noqa: BLE001
                await self._emit(handle, self._stream_event(
                    handle, "error", content=f"agent init failed: {exc}",
                    source=capability, stage="responding"))
                await self._emit(handle, self._stream_event(
                    handle, "done", source=capability, stage="responding",
                    metadata={"status": "error",
                              "user_message_id": user_message.get("id"),
                              "assistant_message_id": None}))
                self._finalize_turn(handle, session, "error")
                return True
        else:
            runtime, agent = self._vtx_runtimes[cache_key]
            # The cached vtx session still points at the dict from the turn
            # that created it. Re-point persistence at this turn's record so
            # new history is not written into the stale object and then lost
            # when the turn-end save writes the fresh one.
            vtx_session = getattr(runtime, "session", None) or getattr(agent, "session", None)
            if vtx_session is not None:
                from .dt_session import rebind as rebind_dt_session

                rebind_dt_session(vtx_session, self._store, session)
        await self._emit(handle, self._stream_event(
            handle, "stage_start", source=capability, stage="responding"))

        status = "completed"
        assistant_parts: list[str] = []
        usage: Any = None
        # Some OpenAI-compatible gateways forget to move a model's scratchpad
        # into `reasoning`/`reasoning_content` and leave it inline in the text
        # stream. vtx only knows the ` thinking` spelling, so split the other
        # common tag families here before they are published as the answer.
        inline_thinking = InlineThinkingSplitter()

        async def publish_text_piece(kind: str, piece: str) -> None:
            if not piece:
                return
            if kind == "think":
                await self._emit(handle, self._stream_event(
                    handle, "thinking", content=piece,
                    source=capability, stage="responding",
                    metadata={
                        "call_id": handle.call_id,
                        "call_kind": "llm_reasoning",
                        "trace_kind": "llm_reasoning",
                        "call_role": "assistant",
                    }))
                return
            assistant_parts.append(piece)
            await self._emit(handle, self._stream_event(
                handle, "content", content=piece,
                source=capability, stage="responding"))

        try:
            async for event in agent.run(
                prompt,
                cancel_event=handle.cancel,
            ):
                if isinstance(event, AskUserEvent):
                    # The SDK intercepts ask_user and hands us the questionnaire
                    # plus a future for the learner's answer. Publish a card to
                    # the client now and let submit_user_reply resolve the future.
                    prompts: dict[str, str] = {}
                    questions = []
                    for i, q in enumerate(event.questions or []):
                        qid = f"q{i + 1}"
                        prompts[qid] = q.question
                        questions.append({
                            "id": qid,
                            "prompt": q.question,
                            "header": q.header or None,
                            "multi_select": bool(q.multi_select),
                            "options": [
                                {"label": o.label, "description": o.description or None}
                                for o in (q.options or [])
                            ],
                            "allow_free_text": True,
                            "placeholder": None,
                        })
                    await self._emit(handle, self._stream_event(
                        handle, "tool_result", source=capability,
                        stage="responding",
                        metadata={
                            "tool_call_id": event.tool_call_id,
                            "tool_name": "ask_user",
                            "tool_metadata": {"ask_user": {"questions": questions}},
                        }))
                    self._ask_user_waiters[handle.turn_id] = (
                        event.future, event.tool_call_id, prompts)
                    continue
                if isinstance(event, ThinkingDeltaEvent):
                    if event.delta:
                        # The frontend groups trace rows by metadata.call_id.
                        # Without it, reasoning deltas are dropped by
                        # groupTraceEvents() and never render at all. A single
                        # id per turn groups one model call's reasoning into
                        # one expandable row, and llm_reasoning keeps the
                        # activity header open while it is streaming.
                        await self._emit(handle, self._stream_event(
                            handle, "thinking", content=event.delta,
                            source=capability, stage="responding",
                            metadata={
                                "call_id": handle.call_id,
                                "call_kind": "llm_reasoning",
                                "trace_kind": "llm_reasoning",
                                "call_role": "assistant",
                            }))
                elif isinstance(event, TextDeltaEvent):
                    if event.delta:
                        for kind, piece in inline_thinking.feed(event.delta):
                            await publish_text_piece(kind, piece)
                elif isinstance(event, ToolStartEvent):
                    await self._emit(handle, self._stream_event(
                        handle, "progress",
                        content=f"Calling {event.tool_name}",
                        source=capability, stage="responding",
                        metadata={"tool_name": event.tool_name,
                                  "tool_call_id": event.tool_call_id}))
                elif isinstance(event, ToolEndEvent):
                    await self._emit(handle, self._stream_event(
                        handle, "tool_call", content=event.tool_name,
                        source=capability, stage="responding",
                        metadata={"tool": event.tool_name,
                                  "tool_name": event.tool_name,
                                  "tool_call_id": event.tool_call_id,
                                  "args": getattr(event, "arguments", None)}))
                elif isinstance(event, ToolApprovalEvent):
                    # DeepTutor has no permission UI — auto-approve tool calls.
                    if event.future is not None and not event.future.done():
                        event.future.set_result(ApprovalResponse.APPROVE)
                elif isinstance(event, ToolResultEvent):
                    out = event.result
                    text = _tool_result_text(out)
                    tool_meta: dict[str, Any] = {}
                    # The video tool publishes a self-contained Remotion player
                    # page into the /files tree and marks its result with a
                    # machine-readable prefix. Emit a `video_lesson` result so
                    # the chat mounts its sandboxed VideoLessonViewer.
                    # Marker format: VIDEO_LESSON_RESULT:<json>
                    if (
                        event.tool_name == "video"
                        and text.startswith("VIDEO_LESSON_RESULT:")
                        and not getattr(out, "is_error", False)
                    ):
                        try:
                            lesson = json.loads(text.split(":", 1)[1])
                        except (ValueError, IndexError):
                            lesson = {}
                        rel = str(lesson.get("rel") or "").strip()
                        if rel and ".." not in rel and not rel.startswith("/"):
                            title = str(lesson.get("title") or "").strip()
                            summary = str(lesson.get("summary") or "").strip()
                            await self._emit(handle, self._stream_event(
                                handle, "result", source="video_lesson",
                                stage="responding",
                                metadata={
                                    "response": summary,
                                    "title": title,
                                    "artifacts": [{
                                        "type": "html",
                                        "url": f"/files/{rel}",
                                        "filename": rel.rsplit("/", 1)[-1],
                                        "content_type": "text/html",
                                        "label": title or None,
                                    }],
                                    "code": {
                                        "language": "tsx",
                                        "content": str(lesson.get("code") or ""),
                                    },
                                    "render": {
                                        "duration_seconds": lesson.get("duration_seconds"),
                                        "attempts": list(range(
                                            max(1, int(lesson.get("attempts") or 1)))),
                                    },
                                }))
                            text = summary or "Video lesson ready."

                    # Legacy marker for pre-Remotion MP4/HyperFrames lessons.
                    # Marker format: VIDEO_ARTIFACT:<rel>|<title>|<readable>
                    if (
                        event.tool_name == "video"
                        and text.startswith("VIDEO_ARTIFACT:")
                        and not getattr(out, "is_error", False)
                    ):
                        marker, _, rest = text.partition("|")
                        rel = marker.split(":", 1)[1].strip()
                        title, sep, readable = rest.partition("|")
                        if not sep:
                            # Legacy marker without a title segment.
                            title, readable = "", title
                        if rel and ".." not in rel and not rel.startswith("/"):
                            tool_meta["artifacts"] = [{
                                "filename": rel.rsplit("/", 1)[-1],
                                "url": f"/files/{rel}",
                                "mime_type": (
                                    "video/mp4" if rel.endswith(".mp4")
                                    else "application/x-hyperframes"
                                ),
                                "title": title.strip() or None,
                                "generated": True,
                            }]
                            text = readable.strip() or "Video ready."
                    await self._emit(handle, self._stream_event(
                        handle, "tool_result", content=text,
                        source=capability, stage="responding",
                        metadata={"tool_call_id": event.tool_call_id,
                                  "tool_name": event.tool_name,
                                  "is_error": _tool_result_is_error(out, text),
                                  "tool_metadata": tool_meta}))
                elif isinstance(event, ErrorEvent):
                    status = "error"
                    # Surface the provider/agent failure to the UI. Without an
                    # explicit frame the turn just ends with status=error and
                    # the user sees an empty reply with no explanation.
                    await self._emit(handle, self._stream_event(
                        handle, "error",
                        content=str(getattr(event, "error", "") or "Agent failed."),
                        source=capability, stage="responding",
                        metadata={"turn_terminal": True}))
                elif isinstance(event, AgentEndEvent):
                    usage = getattr(event, "total_usage", None)
            for kind, piece in inline_thinking.flush():
                await publish_text_piece(kind, piece)
        except asyncio.CancelledError:
            status = "cancelled"
        except Exception as exc:  # noqa: BLE001
            status = "error"
            await self._emit(handle, self._stream_event(
                handle, "error", content=str(exc), source=capability,
                stage="responding"))
        # Emit the context-window readout the composer's context bar consumes.
        # The UI reads metadata.metadata.context_budget from a `result` event;
        # without it the bar never renders, even though vtx measures usage.
        await self._emit(handle, self._stream_event(
            handle, "result", source=capability, stage="responding",
            metadata={"metadata": {"context_budget": self._context_budget(
                runtime, session, usage)}}))
        assistant_text = "".join(assistant_parts).strip()
        assistant_message: dict[str, Any] | None = None
        if assistant_text:
            try:
                assistant_message = self._store.append_assistant_message(
                    session, assistant_text,
                    events=[],  # events live on the turn log, not the message row
                    turn_id=handle.turn_id,
                    capability=capability,
                    metadata={"status": status},
                    parent_message_id=user_message.get("id"),
                )
            except Exception:  # noqa: BLE001
                pass
        session["status"] = "completed" if status == "completed" else status
        session["last_output"] = assistant_text[:500]
        try:
            self._store.save(session)
        except Exception:  # noqa: BLE001
            pass
        handle.status = status

        await self._emit(handle, self._stream_event(
            handle, "stage_end", source=capability, stage="responding",
            metadata={"status": status}))
        # The client reconciles its optimistic rows and clears failed-
        # submission records from these ids. Without them every completed
        # turn was treated as an unsent draft despite being persisted.
        done_meta: dict[str, Any] = {
            "status": status,
            "user_message_id": user_message.get("id"),
            "assistant_message_id": (
                assistant_message.get("id") if assistant_message else None
            ),
        }
        await self._emit(handle, self._stream_event(
            handle, "done", source=capability, stage="responding",
            metadata=done_meta))
        # Persist the recorded turn (incl. done) before the done callback drops
        # the in-memory handle — replay must find these frames in the store.
        self._finalize_turn(handle, session, status)
        # Publish the title only now, so its frame can never precede ``done``
        # (the request itself already ran in parallel since turn start).
        # Everything else marks the turn settled here: a pump waiting on it
        # must not sit idle for a turn that will never publish anything.
        if status == "completed" and session.get("title_auto"):
            self._spawn_title_update(handle, session, user_message, assistant_text)
        else:
            handle.settled.set()
        return True

    def _start_title_request(self, user_text: str) -> asyncio.Task[str | None]:
        """Kick off title generation without blocking the turn.

        Called at turn start so the request overlaps the assistant reply;
        the title is published after ``done`` by ``_update_title``.
        """
        from ..services.title_gen import generate_title

        task = asyncio.create_task(
            generate_title(user_text, settings=self._settings)
        )
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    def _spawn_title_update(
        self,
        handle: TurnHandle,
        session: dict[str, Any],
        user_message: dict[str, Any],
        assistant_text: str,
    ) -> None:
        """Publish the conversation title once the first turn completes.

        The request itself was fired at turn start (``handle.title_task``),
        so this usually just awaits an already-finished call. It runs as its
        own task either way: ``done`` reaches the client immediately, the
        title arrives a moment later as a ``session_meta`` frame, and the
        pumps keep the socket open on ``handle.settled`` until the attempt
        finishes either way.
        """
        task = asyncio.create_task(
            self._update_title(handle, session, user_message, assistant_text)
        )
        # Claim the attempt synchronously: a second turn that starts before this
        # task is scheduled must not spawn a rival call (or reset the flag).
        session["title_auto"] = False
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def _update_title(
        self,
        handle: TurnHandle,
        session: dict[str, Any],
        user_message: dict[str, Any],
        assistant_text: str,
    ) -> None:
        """Replace the placeholder title once the first turn completes, then
        push it to the client as a ``session_meta`` frame.

        The attempt is one-shot per session — a dead title endpoint must not
        add latency to every later turn. The event is emitted before the save
        so ``record_turn_event`` can persist it with the rest of the turn.
        """
        try:
            early = handle.title_task
            if early is not None:
                # Fired at turn start with the user's message only; by now it
                # has almost always already resolved.
                title = await early
            else:
                from ..services.title_gen import generate_title

                title = await generate_title(
                    str(user_message.get("content") or ""),
                    assistant_text,
                    settings=self._settings,
                )
            if not title:
                return
            session["title"] = title
            await self._emit(handle, self._stream_event(
                handle, "session_meta", metadata={"title": title}))
            self._store.save(session)
        except Exception:  # noqa: BLE001
            log.warning("chat title update failed", exc_info=True)
        finally:
            handle.settled.set()

    def _finalize_turn(
        self, handle: TurnHandle, session: dict[str, Any], status: str
    ) -> None:
        """Seal the recorded turn and flush it to disk."""
        turn = session.get("turns", {}).get(handle.turn_id)
        if turn is not None:
            turn["status"] = status
            turn["finished_at"] = time.time()
            turn["last_seq"] = handle.seq
        handle.status = status
        try:
            self._store.save(session)
        except Exception:  # noqa: BLE001
            pass

    async def _run(
        self,
        handle: TurnHandle,
        session: dict[str, Any],
        command: dict[str, Any],
        user_message: dict[str, Any],
    ) -> None:
        await self._run_vtx(handle, session, command, user_message)

    def turn_events_after(self, turn_id: str, after_seq: int) -> list[dict[str, Any]]:
        handle = self._turns.get(turn_id)
        if handle is not None:
            return [e for e in handle.events if (e.get("seq") or 0) > after_seq]
        # Fall back to the persisted log (turn finished or server restarted).
        return self._store.turn_events(turn_id, after_seq)

    def latest_turn_for_session(self, session_id: str) -> str | None:
        session = self._store.get(session_id)
        if not session:
            return None
        turns = session.get("turns", {})
        if not turns:
            return None
        return max(turns, key=lambda t: turns[t].get("created_at", 0))


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"
