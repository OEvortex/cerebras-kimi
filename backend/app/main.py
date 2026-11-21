"""FastAPI app — REST API + SSE transport (no WebSockets, no ACP).

REST handlers are mounted at /api/*. Turn commands and legacy feature-channel
messages are handled by the plain REST controller in ``app/api/realtime.py``,
which streams frames to the browser over ``GET /api/realtime/events``.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .agent.runtime import AgentRuntime
from .api.calendar import router as calendar_router
from .api.documents import router as documents_router
from .api.cron import router as cron_router
from .api.files import router as files_router
from .api.handlers import router
from .api.notebook_ui import router as notebook_ui_router
from .api.openui import router as openui_router
from .api.realtime import RealtimeHub, router as realtime_router
from .config import get_settings
from .store.kb_store import KnowledgeBaseStore
from .store.session_store import SessionStore


def _use_deeptutor_vtx_sessions() -> None:
    """Back vtx Sessions with DeepTutor's store instead of ~/.vtx JSONL files.

    ConversationRuntime.initialize() creates a Session via Session.create().
    Redirecting that factory to DeepTutorSession keeps the full vtx session
    protocol (append-only, resumable, checkpoints) while persisting entries in
    a WAL-mode SQLite database (``data/deeptutor.sqlite3``). No vtx session
    files are read or written.
    """
    from vtx.agent.session import Session

    from .agent.dt_session import DeepTutorSession

    original_create = Session.__dict__["create"]

    def create(cls, cwd, *args, **kwargs):  # type: ignore[no-untyped-def]
        created = original_create.__func__(DeepTutorSession, cwd, *args, **kwargs)
        # Belt and braces: never let a base method fall back to JSONL I/O.
        created._session_file = None
        created._load_from_record()
        return created

    # Deliberate monkeypatch: our factory is intentionally broader than the
    # SDK signature because it delegates to the original classmethod.
    Session.create = classmethod(create)  # ty: ignore[invalid-assignment]


_use_deeptutor_vtx_sessions()


def _use_deeptutor_prompt() -> None:
    """Make vtx's runtime resolve DeepTutor's tutor prompt, not its own."""
    from vtx.agent.runtime import ConversationRuntime

    from .agent.prompt import build_deeptutor_prompt

    # Deliberate monkeypatch: build_deeptutor_prompt takes the runtime as its
    # first positional argument, so it is bound as an unbound method.
    ConversationRuntime.resolve_system_prompt = build_deeptutor_prompt  # ty: ignore[invalid-assignment]

    # vtx rebuilds the agent's prompt directly (bypassing the resolver above)
    # whenever tools/MCP change. Patch that path too, or its coding-agent
    # default, ponytail mode, AGENTS.md and git context leak back in.
    def rebuild_deeptutor_prompt(runtime) -> None:  # type: ignore[no-untyped-def]
        if runtime.agent is not None:
            runtime.agent._system_prompt = build_deeptutor_prompt(runtime)

    ConversationRuntime._rebuild_system_prompt = rebuild_deeptutor_prompt  # ty: ignore[invalid-assignment]


_use_deeptutor_prompt()


def _speed_up_model_lookup() -> None:
    """Avoid vtx's O(n²) fuzzy context-window scan on every model lookup.

    ``ContextLengthManager.get_limits`` falls back to substring-matching every
    one of ~4,000 cached model ids against every fetched model. Called several
    times during ConversationRuntime.initialize(), that took ~100 seconds per
    turn. DeepTutor only needs exact context-window data, so keep that and
    return empty limits for unknown ids.
    """
    from vtx.ai.context_length import TokenLimits, context_length_manager

    def fast_get_limits(self, model: str):  # type: ignore[no-untyped-def]
        """Same resolution rules as vtx, with a cached normalized index.

        The original O(n²) cost came from matching *every fetched model* against
        *every limits key*, not from a single lookup. Restoring vtx's fuzzy
        fallback here keeps gateway-prefixed ids accurate without that cost.
        """
        self.ensure_loaded()
        limits = self._limits.get(model)
        if limits is not None:
            return limits

        normalized = getattr(self, "_dt_normalized_limits", None)
        if normalized is None:
            normalized = {
                key.lower().replace("-", ""): value
                for key, value in list(self._limits.items())
            }
            self._dt_normalized_limits = normalized

        probe = model.lower().replace("-", "")
        candidate = normalized.get(probe)
        if candidate is not None:
            return candidate
        for key, value in normalized.items():
            if probe in key or key in probe:
                # Prefer the longest match to avoid e.g. "gpt-4" matching
                # "gpt-4o" when an exact-ish key exists.
                if len(key) >= len(probe) or candidate is None:
                    candidate = value
        return candidate if candidate is not None else TokenLimits(context=0, output=0)

    type(context_length_manager).get_limits = fast_get_limits  # ty: ignore[invalid-assignment]

    # get_fetched_models() still substring-matches every cached model against
    # every context-window key (~2M comparisons per lookup). Exact keys are
    # enough here; unknown models simply fall back to provider defaults.
    import vtx.ai.model_fetcher as fetcher
    from vtx.ai.models import ApiType, Model

    def fast_get_fetched_models(provider):  # type: ignore[no-untyped-def]
        cached = fetcher._read_cache(provider.slug)
        if not cached:
            return []
        family_to_api = {
            "openai_compat": ApiType(ApiType.OPENAI_SDK),
            "anthropic": ApiType(ApiType.ANTHROPIC),
        }
        limit_keys = {key.lower() for key in context_length_manager._limits}
        models = []
        for entry in cached:
            limits = context_length_manager.get_limits(entry.id)
            matched = entry.id.lower() in limit_keys
            max_tokens = entry.max_output_tokens or provider.max_tokens
            supports_images = entry.supports_images or provider.supports_vision
            supports_thinking = entry.supports_thinking or provider.supports_thinking
            context_window = entry.context_length or None
            if matched:
                if not context_window:
                    context_window = limits.context
                if not max_tokens:
                    max_tokens = limits.output
                if not supports_thinking:
                    supports_thinking = limits.supports_reasoning
                if not supports_images:
                    supports_images = limits.supports_vision
                supports_tools = limits.supports_tools
                supports_audio = limits.supports_audio
                thinking_level_map = entry.thinking_level_map or limits.thinking_level_map
            else:
                supports_tools = provider.supports_tools
                supports_audio = False
                thinking_level_map = entry.thinking_level_map
            models.append(
                Model(
                    id=entry.id,
                    provider=provider.slug,
                    api=family_to_api.get(provider.family, ApiType(ApiType.OPENAI_SDK)),
                    base_url=provider.base_url or "",
                    max_tokens=max_tokens,
                    supports_images=supports_images,
                    supports_thinking=supports_thinking,
                    thinking_level_map=thinking_level_map,
                    context_window=context_window,
                    supports_tools=supports_tools,
                    supports_audio=supports_audio,
                    api_model_id=entry.api_model_id,
                    is_free=entry.is_free,
                )
            )
        return models

    fetcher.get_fetched_models = fast_get_fetched_models  # ty: ignore[invalid-assignment]


_speed_up_model_lookup()

settings = get_settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.workspace_dir.mkdir(parents=True, exist_ok=True)
settings.files_dir.mkdir(parents=True, exist_ok=True)

store = SessionStore(settings)
runtime = AgentRuntime(settings, store)
kb = KnowledgeBaseStore(settings)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.realtime.start()
    # Notebook writer progress/completion needs to reach the browser even when
    # the parent turn has already ended (the usual case for a background job).
    from .agent.notebook_agent import events as notebook_events

    notebook_events.set_broadcast(app.state.realtime.broadcast)
    notebook_events.set_runtime(runtime)
    # Notes saved by older versions lived outside the notebook store. Bring
    # them into Co-Writer on boot so they are visible without a tool call.
    from .services.documents.notes import sync_legacy_notes

    sync_legacy_notes()
    # Scheduled reminders run through the app's agent runtime; the cron
    # scheduler owns its own loop and stops with the server.
    from .services.cron.executor import set_runtime
    from .services.cron.module_service import start_cron, stop_cron

    set_runtime(runtime)
    await start_cron()
    try:
        yield
    finally:
        await stop_cron()
        await app.state.realtime.stop()


app = FastAPI(title="DeepTutor", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.state.settings = settings
app.state.store = store
app.state.runtime = runtime
app.state.kb = kb
app.state.realtime = RealtimeHub(store=store, runtime=runtime)
app.include_router(router)
app.include_router(calendar_router)
app.include_router(documents_router)
app.include_router(cron_router)
app.include_router(files_router)
app.include_router(openui_router)
app.include_router(notebook_ui_router)
app.include_router(realtime_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def main() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8001, reload=False)


if __name__ == "__main__":
    main()
