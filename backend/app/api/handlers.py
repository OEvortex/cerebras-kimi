"""FastAPI handler registry, mounted at ``/api/*`` by ``app.main``.

Implements the DeepTutor REST API the frontend uses to boot and hold a
conversation: auth, sessions, settings, knowledge bases, notebooks, mastery,
partners, documents, and the other feature stores.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from pydantic import BaseModel


from fastapi import APIRouter, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

from pathlib import Path

from ..agent.runtime import AgentRuntime
from .. import provider_config
from ..config import Settings
from ..services.workspace_registry import (
    SYSTEM_WORKSPACE_ID,
    WorkspaceError,
    WorkspaceRegistry,
    workspace_snapshot,
)
from ..store.session_store import SessionStore

router = APIRouter(prefix="/api")


def _store(request: Request) -> SessionStore:
    return request.app.state.store


def _runtime(request: Request) -> AgentRuntime:
    return request.app.state.runtime


def _settings(request: Request) -> Settings:
    return request.app.state.settings


# -- system / runtime ---------------------------------------------------------


@router.get("/system/runtime")
def system_runtime(request: Request) -> dict[str, Any]:
    settings = _settings(request)
    return {
        "worker_id": "local",
        "worker_count": 1,
        "coordination_mode": "memory",
        "redis_configured": False,
        "redis_status": "not_configured",
        "leader_id": None,
        "leader_healthy": None,
        "owner_turn_count": len(_runtime(request)._turns),
        "recovery_backlog": 0,
        "lease_ttl_seconds": 30,
        "renew_interval_seconds": 10,
        "recovery_interval_seconds": 5,
        "protocol_version": "2.0",
        "minimum_web_protocol_version": "2.0",
        "data_dir": str(settings.data_dir),
    }


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# -- sessions -----------------------------------------------------------------


def _summary(session: dict[str, Any]) -> dict[str, Any]:
    messages = session.get("messages", [])
    last = messages[-1] if messages else {}
    active = None
    turns = session.get("turns", {})
    running = [t for t in turns.values() if t.get("status") == "running"]
    if running:
        latest = max(running, key=lambda t: t.get("created_at", 0))
        # turn_id is the dict key; find it
        for tid, t in turns.items():
            if t is latest:
                active = tid
                break
    return {
        "id": session["id"],
        "session_id": session["id"],
        "content_workspace_id": (session.get("preferences") or {}).get("workspace_id"),
        "title": session.get("title") or "Untitled",
        "created_at": _epoch_seconds(session.get("created_at")),
        "updated_at": _epoch_seconds(session.get("updated_at")),
        "message_count": len(messages),
        "last_message": str(last.get("content", ""))[:200],
        "status": "running" if active else (session.get("status") or "idle"),
        "active_turn_id": active,
        "preferences": session.get("preferences") or {},
    }


def _epoch_seconds(value: Any) -> float:
    """Normalize session timestamps to epoch seconds — the wire contract.

    Stored sessions use numeric epochs; native vtx sessions carry ISO strings.
    The sidebar feeds these straight into ``new Date(seconds * 1000)``, so a
    string (or NaN/Infinity) there throws ``RangeError: Invalid time value``.
    """
    import math as _math
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        result = float(value)
        return result if _math.isfinite(result) else 0.0
    if isinstance(value, str):
        import datetime as _dt
        try:
            return _dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _session_updated_key(session: dict[str, Any]) -> float:
    """Sort key shared by stored (epoch number) and native (ISO) sessions."""
    return _epoch_seconds(session.get("updated_at"))


@router.get("/sessions")
def list_sessions(
    request: Request,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    # DeepTutor's record is the only session index. vtx-native JSONL files
    # are neither read nor written any more (see app.main's in-memory patch).
    stored = _store(request).all()
    stored.sort(key=_session_updated_key, reverse=True)
    return {"sessions": [_summary(s) for s in stored[offset : offset + limit]]}


@router.get("/sessions/search")
def search_sessions(
    request: Request,
    q: str = Query(""),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    hits, total = _store(request).search(q, limit=limit, offset=offset)
    results = []
    for session in hits:
        summary = _summary(session)
        summary["match_excerpt"] = session.get("_match_excerpt", "")
        results.append(summary)
    return {"sessions": results, "total": total, "limit": limit, "offset": offset}


@router.get("/sessions/capabilities")
def session_capabilities() -> dict[str, Any]:
    return {"submission_replacement": False}


@router.get("/sessions/{session_id}")
def get_session(request: Request, session_id: str) -> dict[str, Any]:
    session = _store(request).get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    summary = _summary(session)
    active_turns = []
    for tid, turn in session.get("turns", {}).items():
        active_turns.append(
            {
                "id": tid,
                "turn_id": tid,
                "session_id": session_id,
                "capability": "chat",
                "status": turn.get("status", "completed"),
                "error": "",
                "created_at": turn.get("created_at"),
                "updated_at": turn.get("finished_at"),
                "finished_at": turn.get("finished_at"),
                "last_seq": turn.get("last_seq", 0),
            }
        )
    return {
        **summary,
        "messages": session.get("messages", []),
        "active_turns": active_turns,
    }


class SessionPatch(BaseModel):
    title: str | None = None
    preferences: dict[str, Any] | None = None


@router.patch("/sessions/{session_id}")
@router.put("/sessions/{session_id}")
def update_session(
    request: Request, session_id: str, body: SessionPatch
) -> dict[str, Any]:
    store = _store(request)
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    if body.title is not None:
        session["title"] = body.title.strip() or session.get("title") or "Untitled"
        session["title_auto"] = False
    if body.preferences is not None:
        session["preferences"] = {**(session.get("preferences") or {}), **body.preferences}
    store.save(session)
    return _summary(session)


@router.delete("/sessions/{session_id}")
def delete_session(request: Request, session_id: str) -> dict[str, Any]:
    if not _store(request).delete(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return {"deleted": True}


@router.delete("/sessions/{session_id}/messages/{message_id}")
def delete_message(request: Request, session_id: str, message_id: int) -> dict[str, Any]:
    store = _store(request)
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    before = len(session.get("messages", []))
    session["messages"] = [
        m for m in session.get("messages", []) if m.get("id") != message_id
    ]
    if len(session["messages"]) == before:
        raise HTTPException(status_code=404, detail="message not found")
    store.save(session)
    return {"deleted": True}


@router.get("/sessions/{session_id}/messages/{message_id}/events")
def message_events(
    request: Request,
    session_id: str,
    message_id: int,
    after_seq: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
) -> dict[str, Any]:
    session = _store(request).get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    message = next(
        (m for m in session.get("messages", []) if m.get("id") == message_id), None
    )
    if message is None:
        raise HTTPException(status_code=404, detail="message not found")
    events = [
        e for e in message.get("events", []) if (e.get("seq") or 0) > after_seq
    ][:limit]
    return {
        "session_id": session_id,
        "message_id": message_id,
        "turn_id": (message.get("metadata") or {}).get("turn_id"),
        "events": events,
        "total": len(message.get("events", [])),
        "last_seq": max((e.get("seq") or 0 for e in message.get("events", [])), default=0),
        "next_seq": None,
        "complete": True,
    }


# -- capabilities ---------------------------------------------------------------


@router.get("/capabilities/registered")
def capabilities_registered() -> dict[str, Any]:
    return {
        "capabilities": [
            {
                "id": "chat",
                "kind": "capability",
                "available": True,
                "manifest": {
                    "name": "chat",
                    "description": "General tutoring conversation",
                    "version": "1.0.0",
                },
                "config_schema": {"type": "object", "properties": {}},
            }
        ]
    }


# -- settings -------------------------------------------------------------------


def _saved_selection(request: Request) -> dict[str, Any] | None:
    """Active selection from DeepTutor's own catalog (legacy file as fallback)."""
    return provider_config.get_selection(_settings(request))


@router.get("/settings/llm-options")
def llm_options(request: Request) -> dict[str, Any]:
    """Models and active selection from DeepTutor's own catalog — no vtx reads."""
    settings = _settings(request)
    options = provider_config.model_options(settings)
    saved = _saved_selection(request)
    active = None
    if saved:
        active = dict(saved)
    if active is None and options:
        active = {
            "profile_id": options[0]["profile_id"],
            "model_id": options[0]["model_id"],
            "reasoning_effort": None,
        }
        options[0]["is_active_default"] = True
    return {"active": active, "options": options}


class ProviderApply(BaseModel):
    profile_id: str | None = None
    model_id: str | None = None
    llm_selection: dict[str, Any] | None = None


@router.post("/settings/apply/provider")
def apply_provider(request: Request, body: ProviderApply) -> dict[str, Any]:
    """Store the active selection in DeepTutor's catalog (no vtx config writes)."""
    sel = body.llm_selection or (
        {"profile_id": body.profile_id, "model_id": body.model_id}
        if body.profile_id and body.model_id
        else None
    )
    saved = provider_config.set_selection(_settings(request), sel)
    return {"ok": True, "llm_selection": saved}


class ProviderProbe(BaseModel):
    binding: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    api_version: str | None = None
    api_format: str | None = None
    service: str | None = None
    profile_id: str | None = None
    connection_id: str | None = None
    extra_headers: Any = None
    proxy: str | None = None


def _probe_inputs(
    request: Request,
    *,
    binding: str | None,
    base_url: str | None,
    api_key: str | None,
    api_format: str | None,
    connection_id: str | None = None,
) -> tuple[str, str, str, str | None, dict[str, Any] | None, dict[str, Any] | None]:
    """Resolve probe inputs from the request body, then our catalog/presets."""
    settings = _settings(request)
    catalog = provider_config.load_catalog(settings)
    slug = (binding or "").strip()
    conn = None
    if connection_id:
        conn = next(
            (c for c in catalog.get("connections") or [] if c.get("id") == connection_id),
            None,
        )
    if conn is None and slug:
        conn = next(
            (c for c in catalog.get("connections") or [] if c.get("provider") == slug),
            None,
        )
    if conn:
        slug = slug or str(conn.get("provider") or "")
    preset = provider_config.builtin_preset(slug)
    base = (
        base_url or (conn or {}).get("base_url") or (preset or {}).get("base_url") or ""
    ).strip()
    key = (
        api_key or (conn or {}).get("api_key") or provider_config.preset_api_key(slug)
        or ""
    ).strip()
    fmt = api_format or (conn or {}).get("api_format") or (preset or {}).get("api_format")
    return slug, base, key, fmt, conn, preset


@router.post("/settings/test-provider")
def test_provider(request: Request, body: ProviderProbe) -> dict[str, Any]:
    """Probe a connection via a direct GET {base_url}/models (no vtx fetchers)."""
    service = (body.service or "llm").strip()
    if service not in ("llm", "task"):
        return {
            "status": "unavailable",
            "models": [],
            "capabilities": [],
            "http_status": None,
        }

    slug, base, key, fmt, conn, preset = _probe_inputs(
        request,
        binding=body.binding,
        base_url=body.base_url,
        api_key=body.api_key,
        api_format=body.api_format,
        connection_id=body.connection_id,
    )
    result = provider_config.probe_models(base, key, fmt, preset)
    models = result["models"]
    if result["status"] == "connected" and slug:
        provider_config.store_discovered_models(
            _settings(request),
            slug,
            models,
            connection_id=body.connection_id or (conn or {}).get("id"),
        )
    return {
        "status": result["status"],
        "models": models,
        "capabilities": (
            [{"category": "llm", "evidence": "metadata"}]
            if result["status"] == "connected" else []
        ),
        "checked_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "http_status": result["http_status"],
    }


@router.get("/settings/model-capabilities")
def model_capabilities() -> dict[str, Any]:
    return {"capabilities": {}}


class FetchModelsBody(BaseModel):
    binding: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    profile_id: str | None = None
    service: str | None = None
    api_format: str | None = None


@router.post("/settings/fetch-models")
def fetch_models(request: Request, body: FetchModelsBody) -> dict[str, Any]:
    """Discover models from a live GET {base_url}/models, store in our catalog."""
    slug, base, key, fmt, conn, preset = _probe_inputs(
        request,
        binding=body.binding,
        base_url=body.base_url,
        api_key=body.api_key,
        api_format=body.api_format,
    )
    result = provider_config.probe_models(base, key, fmt, preset)
    models = result["models"]
    refreshed = result["status"] == "connected"
    if refreshed and slug:
        provider_config.store_discovered_models(
            _settings(request),
            slug,
            models,
            connection_id=(conn or {}).get("id"),
        )
    return {"models": models, "refreshed": refreshed}


@router.get("/settings")
def settings_root(request: Request) -> dict[str, Any]:
    settings = _settings(request)
    providers = provider_config.provider_options(settings)
    return {
        "providers": {
            "llm": providers,
            "task": providers,
            "embedding": providers,
            "search": [],
            "tts": providers,
            "stt": providers,
            "imagegen": providers,
            "videogen": [],
        },
        "connection_targets": provider_config.connection_targets(settings),
        "task_kinds": [],
        "ui": {"theme": "dark", "language": "en", "response_language": "en"},
        "services": {},
        "catalog": _load_live_catalog(request),
    }



# -- knowledge bases ---------------------------------------------------------


@router.get("/knowledge-bases")
def kb_list(request: Request) -> dict[str, Any]:
    return {"knowledge_bases": request.app.state.kb.list()}


class KBCreate(BaseModel):
    name: str


@router.post("/knowledge-bases")
def kb_create(request: Request, body: KBCreate) -> dict[str, Any]:
    return request.app.state.kb.create(body.name)


@router.delete("/knowledge-bases/{name}")
def kb_delete(request: Request, name: str) -> dict[str, Any]:
    if not request.app.state.kb.delete(name):
        raise HTTPException(status_code=404, detail="knowledge base not found")
    return {"deleted": True}


@router.get("/knowledge-bases/{name}/files")
def kb_files_list(request: Request, name: str) -> dict[str, Any]:
    if not request.app.state.kb.exists(name):
        raise HTTPException(status_code=404, detail="knowledge base not found")
    return {"files": request.app.state.kb.list_documents(name)}


@router.post("/knowledge-bases/{name}/upload")
async def kb_upload(request: Request, name: str, file: UploadFile) -> dict[str, Any]:
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large")
    return request.app.state.kb.add_document(name, file.filename or "upload.bin", data)


# -- boot-time stubs -----------------------------------------------------------


def _settings_dir(request: Request) -> Path:
    d = request.app.state.settings.data_dir
    d.mkdir(parents=True, exist_ok=True)
    return d  # kept for callers that still resolve provider preset files


def _default_catalog() -> dict[str, Any]:
    return provider_config.default_catalog()


def _load_live_catalog(request: Request) -> dict[str, Any]:
    """Load the DeepTutor catalog, self-healing base_urls from our own presets."""
    data = provider_config.load_catalog(_settings(request))
    dirty = False
    for conn in data.get("connections", []) or []:
        if conn.get("base_url"):
            continue
        preset = provider_config.builtin_preset(str(conn.get("provider") or ""))
        if preset and preset.get("base_url"):
            conn["base_url"] = preset["base_url"]
            dirty = True
    if dirty:
        _save_live_catalog(request, data)
    return data


def _save_live_catalog(request: Request, catalog: dict[str, Any]) -> None:
    provider_config.save_catalog(_settings(request), catalog)


def _load_draft(request: Request) -> dict[str, Any] | None:
    from ..store import database

    data = database.get_state(_settings(request), "settings/draft")
    return data if isinstance(data, dict) and "catalog" in data else None


def _save_draft(request: Request, draft: dict[str, Any] | None) -> None:
    from ..store import database

    if draft is None:
        database.delete_state(_settings(request), "settings/draft")
    else:
        database.put_state(_settings(request), "settings/draft", draft)


@router.get("/settings/draft")
def settings_draft_get(request: Request) -> dict[str, Any]:
    return {"draft": _load_draft(request)}


@router.put("/settings/draft")
def settings_draft_put(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    stored = {"catalog": body.get("catalog"), "extensions": body.get("extensions") or {}}
    _save_draft(request, stored)
    return {"draft": stored}


@router.post("/settings/draft")
def settings_draft_post(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    return settings_draft_put(request, body)


@router.delete("/settings/draft")
def settings_draft_delete(request: Request) -> dict[str, Any]:
    _save_draft(request, None)
    return {"ok": True}


def _svc(catalog: dict[str, Any], name: str) -> dict[str, Any]:
    services = catalog.setdefault("services", {})
    return services.setdefault(name, {"active_profile_id": None, "profiles": []})


def _find_profile(catalog: dict[str, Any], service: str, profile_id: str):
    for p in _svc(catalog, service).get("profiles", []):
        if p.get("id") == profile_id:
            return p
    return None


def _apply_registry_edit(catalog: dict[str, Any], edit: dict[str, Any]) -> None:
    """Mirror of the frontend's stageRegistryAction + field updates."""
    kind = edit.get("kind")
    ref = edit.get("ref") or {}
    service = edit.get("service")

    if kind == "task_choice" and edit.get("task"):
        task = _svc(catalog, "task")
        t = edit["task"]
        task_kind = t.get("task_kind")
        choice = {k: v for k, v in t.items() if k != "task_kind"}
        if task_kind:
            overrides = dict(task.get("overrides") or {})
            if choice.get("mode") == "global":
                overrides.pop(task_kind, None)
            else:
                overrides[task_kind] = choice
            if overrides:
                task["overrides"] = overrides
            else:
                task.pop("overrides", None)
        else:
            task.update(choice)
        return

    if kind == "provider" and edit.get("delete") and ref:
        if ref.get("connection_id"):
            catalog["connections"] = [
                c for c in catalog.get("connections", []) if c.get("id") != ref["connection_id"]
            ]
        elif ref.get("service") and ref.get("profile_id"):
            bucket = _svc(catalog, ref["service"])
            bucket["profiles"] = [p for p in bucket.get("profiles", []) if p.get("id") != ref["profile_id"]]
        return

    if kind == "provider" and ref:
        # Field-level update on a connection or profile.
        fields = edit.get("fields") or {}
        if ref.get("connection_id"):
            for c in catalog.get("connections", []):
                if c.get("id") == ref["connection_id"]:
                    c.update(fields)
                    if edit.get("config"):
                        c.update(edit["config"])
                    return
        elif ref.get("service") and ref.get("profile_id"):
            profile = _find_profile(catalog, ref["service"], ref["profile_id"])
            if profile:
                profile.update(fields)
                if edit.get("config"):
                    profile.update(edit["config"])
        return

    if not service:
        return
    bucket = _svc(catalog, service)
    profile = _find_profile(catalog, service, edit.get("profile_id") or "")

    if kind == "default" and profile is not None:
        bucket["active_profile_id"] = profile["id"]
        bucket["active_model_id"] = edit.get("model_id")
        if service == "task":
            bucket["mode"] = "profiles"
        return

    if profile is None:
        return

    if kind == "model":
        model = edit.get("model")
        if edit.get("delete"):
            mid = edit.get("model_id") or (model or {}).get("id")
            profile["models"] = [m for m in profile.get("models", []) if m.get("id") != mid]
            if not profile.get("models") and profile.get("provider_ref"):
                bucket["profiles"] = [p for p in bucket["profiles"] if p is not profile]
        elif model:
            models = profile.setdefault("models", [])
            existing = next((i for i, m in enumerate(models) if m.get("id") == model.get("id")), None)
            if existing is None:
                models.append(model)
            else:
                models[existing] = {**models[existing], **model}
        return

    if edit.get("config"):
        profile.update(edit["config"])


@router.post("/settings/apply/registry")
def apply_registry(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    catalog = _load_live_catalog(request)
    _apply_registry_edit(catalog, body)
    _save_live_catalog(request, catalog)
    _save_draft(request, None)
    return {"catalog": catalog}


@router.post("/settings/apply/service")
def apply_service(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    catalog = _load_live_catalog(request)
    service = body.get("service")
    config = body.get("config")
    if service in catalog.get("services", {}):
        catalog["services"][service] = config
    _save_live_catalog(request, catalog)
    return {"catalog": catalog, "draft": _load_draft(request)}


@router.post("/settings/apply")
def apply_catalog(request: Request) -> dict[str, Any]:
    draft = _load_draft(request)
    catalog = draft.get("catalog") if draft else _load_live_catalog(request)
    if catalog:
        _save_live_catalog(request, catalog)
    _save_draft(request, None)
    return {"catalog": _load_live_catalog(request), "draft": None}


@router.get("/settings/display")
def settings_display_get() -> dict[str, Any]:
    return {}


@router.post("/settings/display")
def settings_display_post() -> dict[str, Any]:
    return {"ok": True}


@router.get("/modules")
def modules_list() -> dict[str, Any]:
    """Feature modules this deployment ships.

    The frontend gates the sidebar entry, the route and the calendar's
    reminder runtime on this inventory, so anything implemented natively
    here is reported as installed and enabled.
    """
    return {
        "modules": [
            {
                "id": "calendar",
                "installed": True,
                "enabled": True,
                "ready": True,
                "navigation": ["/calendar"],
                "issues": [],
            }
        ]
    }


@router.get("/settings/page-customization")
def page_customization() -> dict[str, Any]:
    return {
        "chat": {
            "hidden_modes": [],
            "controls": {
                "skills": True,
                "mcp": True,
                "partners": True,
                "preferences": True,
                "voice": True,
                "create": True,
            },
            "starters": {},
        },
        "learning": {"hidden_features": []},
    }


def _workspaces(request: Request) -> WorkspaceRegistry:
    return WorkspaceRegistry(_settings(request))


@router.get("/settings/workspace/registrations")
def workspace_registrations(request: Request) -> dict[str, Any]:
    return _workspaces(request).describe()


@router.post("/settings/workspace/registrations")
def workspace_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        workspace = _workspaces(request).create(
            body.get("name"),
            body.get("path"),
            resources=body.get("resources"),
            instructions=body.get("instructions"),
        )
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"workspace": workspace}


@router.patch("/settings/workspace/registrations/{workspace_id}")
def workspace_update(workspace_id: str, request: Request, body: dict[str, Any]) -> dict[str, Any]:
    changes = {
        key: body[key]
        for key in ("name", "archived", "resources", "instructions")
        if key in body
    }
    try:
        workspace = _workspaces(request).update(workspace_id, changes)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"workspace": workspace}


@router.post("/settings/workspace/registrations/migrate-root")
def workspace_migrate_root(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return _workspaces(request).migrate_root(body.get("path"))
    except WorkspaceError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/settings/workspace/registrations/{workspace_id}/migrate")
def workspace_migrate(workspace_id: str, request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return _workspaces(request).migrate(workspace_id, body.get("path"))
    except WorkspaceError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/settings/workspace/registrations/system-snapshot")
@router.post("/settings/workspace/registrations/system-snapshot")
def workspace_system_snapshot(request: Request) -> dict[str, Any]:
    try:
        registry = _workspaces(request)
        if not any(
            row["workspace_id"] == SYSTEM_WORKSPACE_ID
            for row in registry.describe()["workspaces"]
        ):
            raise WorkspaceError("The system workspace is unavailable.")
        return workspace_snapshot(_settings(request))
    except (WorkspaceError, OSError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/settings/workspace/resources")
def workspace_resources(request: Request, workspace_id: str = "") -> dict[str, Any]:
    knowledge_bases = [
        {
            "id": str(row.get("id") or row.get("name") or ""),
            "name": str(row.get("name") or row.get("id") or ""),
            "description": "",
            "source": "account",
            "available": str(row.get("status") or "ready") == "ready",
        }
        for row in request.app.state.kb.list()
    ]
    return {"skills": [], "mcp": [], "knowledge_bases": knowledge_bases}


@router.get("/settings/workspace/resource-usage")
def workspace_resource_usage(request: Request, kind: str, resource_id: str) -> dict[str, Any]:
    return {"workspaces": _workspaces(request).resource_usage(kind, resource_id)}


@router.get("/settings/workspace/folders")
def workspace_folders(request: Request, path: str = "") -> dict[str, Any]:
    try:
        return _workspaces(request).browse(path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/system/status")
def system_status() -> dict[str, Any]:
    return {"status": "ok"}


@router.get("/reading/workspaces/index")
def reading_workspaces_index() -> dict[str, Any]:
    return {"workspaces": []}


@router.get("/mastery-paths/topics/index")
def mastery_topics_index() -> dict[str, Any]:
    return {"topics": []}


@router.get("/tools")
def tools_settings() -> dict[str, Any]:
    # Only tools the agent actually registers: the merged `web` tool is the
    # frontend's `web_search` toggle, and `video` is not user-toggleable.
    return {"enabled_optional_tools": ["web_search", "paper_search"]}


@router.get("/subagents/settings")
def subagents_settings() -> dict[str, Any]:
    return {}


@router.put("/subagents/settings")
def subagents_settings_put() -> dict[str, Any]:
    return {}


def _suggestions_payload() -> dict[str, Any]:
    return {"suggestions": [], "stale": False, "status": "no-material"}


@router.get("/dashboard/suggestions")
def dashboard_suggestions() -> dict[str, Any]:
    return _suggestions_payload()


@router.post("/dashboard/suggestions/refresh")
def dashboard_suggestions_refresh() -> dict[str, Any]:
    return _suggestions_payload()


@router.get("/knowledge-bases/list")
def kb_list_alias(request: Request, resource_library: bool = False) -> list[dict[str, Any]]:
    return request.app.state.kb.list()


@router.get("/sessions/{session_id}/organization")
def session_organization(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "folders": [], "tags": []}


@router.get("/sessions/{session_id}/threads")
def session_threads(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "threads": []}


# ==========================================================================
# Extended surface — memory, notebooks, question bank, partners, skills,
# documents, mastery progress, session sub-actions, settings extras.
# All served through the same http.request RPC dispatch.
# ==========================================================================



def _collection(*parts: str) -> str:
    """Map the old ``ext/<dir>/<kind>`` path segments to one SQLite collection."""
    return "/".join(parts[:-1]) if len(parts) > 1 else (parts[0] if parts else "misc")


def _list_dir(request: Request, *parts: str) -> list[dict[str, Any]]:
    from ..store import database

    return database.list_items(_settings(request), _collection(*parts))


def _get_item(request: Request, *parts: str) -> dict[str, Any] | None:
    from ..store import database

    return database.get_item(_settings(request), _collection(*parts), str(parts[-1]))


def _put_item(request: Request, item: dict[str, Any], *parts: str) -> None:
    from ..store import database

    item.setdefault("id", uuid.uuid4().hex[:12])
    item.setdefault("created_at", time.time())
    item["updated_at"] = time.time()
    database.put_item(_settings(request), _collection(*parts), item)


def _del_item(request: Request, item_id: str, *parts: str) -> bool:
    from ..store import database

    return database.delete_item(_settings(request), _collection(*parts), str(item_id))


# -- memory -----------------------------------------------------------------

@router.get("/memory/doc/{level}/{doc_id}")
def memory_doc_get(request: Request, level: str, doc_id: str) -> dict[str, Any]:
    doc = _get_item(request, "memory", "docs", doc_id)
    return doc or {"id": doc_id, "level": level, "content": "", "lines": []}


@router.put("/memory/doc/{level}/{doc_id}")
def memory_doc_put(request: Request, level: str, doc_id: str, body: dict[str, Any]) -> dict[str, Any]:
    body["id"] = doc_id
    body["level"] = level
    _put_item(request, body, "memory", "docs", doc_id)
    return {"ok": True}


@router.post("/memory/doc/{level}/{doc_id}/lines")
def memory_doc_lines(request: Request, level: str, doc_id: str, body: dict[str, Any]) -> dict[str, Any]:
    doc = _get_item(request, "memory", "docs", doc_id) or {"id": doc_id, "level": level, "lines": []}
    lines = doc.setdefault("lines", [])
    lines.extend(body.get("lines") or [])
    _put_item(request, doc, "memory", "docs", doc_id)
    return {"ok": True, "count": len(lines)}


@router.post("/memory/doc/{level}/{doc_id}/update")
def memory_doc_update(request: Request, level: str, doc_id: str, body: dict[str, Any]) -> dict[str, Any]:
    doc = _get_item(request, "memory", "docs", doc_id) or {"id": doc_id, "level": level}
    doc.update(body)
    _put_item(request, doc, "memory", "docs", doc_id)
    return {"ok": True}


@router.get("/memory/resolve_entry/{entry_id}")
def memory_resolve(request: Request, entry_id: str) -> dict[str, Any]:
    return _get_item(request, "memory", "entries", entry_id) or {"id": entry_id}


@router.get("/memory/runs")
def memory_runs(request: Request) -> dict[str, Any]:
    return {"runs": _list_dir(request, "memory", "runs")}


@router.post("/memory/runs")
def memory_run_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    body["status"] = "completed"
    _put_item(request, body, "memory", "runs", "run")
    return body


@router.post("/memory/runs/{run_id}/cancel")
def memory_run_cancel(request: Request, run_id: str) -> dict[str, Any]:
    return {"ok": True, "run_id": run_id, "status": "cancelled"}


@router.get("/memory/runs/{run_id}/events")
def memory_run_events(request: Request, run_id: str) -> dict[str, Any]:
    return {"events": []}


@router.post("/memory/runs/{run_id}/undo")
def memory_run_undo(request: Request, run_id: str) -> dict[str, Any]:
    return {"ok": True}


@router.get("/memory/snapshot/{snap_id}")
def memory_snapshot(request: Request, snap_id: str) -> dict[str, Any]:
    return _get_item(request, "memory", "snapshots", snap_id) or {"id": snap_id, "changes": []}


@router.get("/memory/snapshot/{snap_id}/changes")
def memory_snapshot_changes(request: Request, snap_id: str) -> dict[str, Any]:
    return {"changes": []}


@router.post("/memory/snapshot/{snap_id}/refresh")
def memory_snapshot_refresh(request: Request, snap_id: str) -> dict[str, Any]:
    return {"ok": True}


# -- question notebook --------------------------------------------------------

@router.get("/question-notebook/categories")
def qn_categories(request: Request) -> dict[str, Any]:
    return {"categories": _list_dir(request, "question-notebook", "categories")}


@router.post("/question-notebook/categories")
def qn_category_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    _put_item(request, body, "question-notebook", "categories", "cat")
    return body


@router.get("/question-notebook/categories/{cat_id}")
def qn_category_get(request: Request, cat_id: str) -> dict[str, Any]:
    return _get_item(request, "question-notebook", "categories", cat_id) or {"id": cat_id}


@router.get("/question-notebook/entries")
def qn_entries(request: Request, limit: int = 50, offset: int = 0, search: str = "",
                sort: str = "recent", **_filters: Any) -> dict[str, Any]:
    items = _list_dir(request, "question-notebook", "entries")
    if search:
        q = search.lower()
        items = [e for e in items if q in str(e.get("question", "")).lower()
                 or q in str(e.get("correct_answer", "")).lower()]
    items.sort(key=lambda e: e.get("updated_at") or e.get("created_at") or 0,
               reverse=(sort != "oldest"))
    total = len(items)
    return {"items": items[offset:offset + limit], "total": total}


@router.post("/question-notebook/entries")
def qn_entry_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    _put_item(request, body, "question-notebook", "entries", "entry")
    return body


@router.get("/question-notebook/entries/{entry_id}")
def qn_entry_get(request: Request, entry_id: str) -> dict[str, Any]:
    return _get_item(request, "question-notebook", "entries", entry_id) or {"id": entry_id}


@router.delete("/question-notebook/entries/{entry_id}")
def qn_entry_delete(request: Request, entry_id: str) -> dict[str, Any]:
    return {"ok": _del_item(request, entry_id, "question-notebook", "entries", "entry")}


@router.get("/question-notebook/entries/lookup/by-question")
def qn_lookup(request: Request, question: str = "", question_id: str = "",
              origin_type: str = "", origin_ref: str = "", turn_id: str = "",
              missing_ok: bool = False, **_f: Any) -> Any:
    entries = _list_dir(request, "question-notebook", "entries")
    hit = None
    for e in entries:
        if question_id and str(e.get("question_id")) == question_id:
            hit = e
            break
        if origin_type and str(e.get("origin_type") or "") == origin_type \
                and str(e.get("origin_ref") or "") == origin_ref \
                and str(e.get("question_id") or "") == question_id:
            hit = e
            break
    if hit is None and question:
        q = question.lower()
        hit = next((e for e in entries
                    if q and q in str(e.get("question") or "").lower()), None)
    if hit is None:
        if missing_ok:
            from fastapi import HTTPException
            raise HTTPException(status_code=204, detail="not found")
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="not found")
    return hit


@router.post("/question-notebook/entries/upsert")
def qn_upsert(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    entries = _list_dir(request, "question-notebook", "entries")
    qid = body.get("question_id") or body.get("id")
    existing = next((e for e in entries if str(e.get("question_id")) == str(qid)
                     or str(e.get("id")) == str(qid)), None)
    if existing is not None:
        existing.update(body)
        _put_item(request, existing, "question-notebook", "entries", "entry")
        return existing
    return qn_entry_create(request, body)


@router.get("/question-notebook/entries/{entry_id}/categories")
def qn_entry_categories(request: Request, entry_id: str) -> dict[str, Any]:
    e = _get_item(request, "question-notebook", "entries", entry_id) or {}
    return {"categories": e.get("categories") or []}


@router.get("/question-notebook/materials")
def qn_materials(request: Request) -> dict[str, Any]:
    return {"materials": _list_dir(request, "question-notebook", "materials")}


@router.get("/question-notebook/stats")
def qn_stats(request: Request) -> dict[str, Any]:
    entries = _list_dir(request, "question-notebook", "entries")
    return {"total": len(entries), "by_category": {}}


@router.post("/question-notebook/entries/categories/bulk")
def qn_categories_bulk(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    ids = body.get("entry_ids") or body.get("ids") or []
    cat_ids = body.get("category_ids") or body.get("categories") or []
    for eid in ids:
        e = _get_item(request, "question-notebook", "entries", str(eid))
        if e is not None:
            e["categories"] = cat_ids
            _put_item(request, e, "question-notebook", "entries", "entry")
    return {"ok": True, "updated": len(ids)}


@router.delete("/question-notebook/entries/{entry_id}/categories/{cat_id}")
def qn_entry_remove_category(request: Request, entry_id: str, cat_id: str) -> dict[str, Any]:
    e = _get_item(request, "question-notebook", "entries", entry_id)
    if e is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="entry not found")
    e["categories"] = [c for c in (e.get("categories") or []) if str(c) != cat_id]
    _put_item(request, e, "question-notebook", "entries", "entry")
    return {"ok": True}


# -- notebooks -----------------------------------------------------------------

@router.get("/notebooks")
def notebooks_list(request: Request) -> dict[str, Any]:
    return {"notebooks": _list_dir(request, "notebooks")}


@router.post("/notebooks")
def notebook_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    _put_item(request, body, "notebooks", "nb")
    return body


@router.get("/notebooks/{nb_id}")
def notebook_get(request: Request, nb_id: str) -> dict[str, Any]:
    return _get_item(request, "notebooks", nb_id) or {"id": nb_id, "records": []}


@router.delete("/notebooks/{nb_id}")
def notebook_delete(request: Request, nb_id: str) -> dict[str, Any]:
    return {"ok": _del_item(request, nb_id, "notebooks", "nb")}


@router.get("/notebooks/records/{record_id}")
def nb_record_by_id(request: Request, record_id: str) -> dict[str, Any]:
    for nb in _list_dir(request, "notebooks"):
        for r in nb.get("records") or []:
            if str(r.get("id")) == record_id:
                return r
    from fastapi import HTTPException
    raise HTTPException(status_code=404, detail="record not found")


@router.get("/notebooks/{nb_id}/export")
def notebook_export(request: Request, nb_id: str) -> dict[str, Any]:
    nb = _get_item(request, "notebooks", nb_id) or {"id": nb_id}
    return {"markdown": f"# {nb.get('title','Notebook')}\n\n" + "\n".join(
        str(r.get("content","")) for r in nb.get("records", []))}


@router.get("/notebooks/{nb_id}/records")
def nb_records(request: Request, nb_id: str) -> dict[str, Any]:
    nb = _get_item(request, "notebooks", nb_id) or {}
    return {"records": nb.get("records") or []}


@router.post("/notebooks/{nb_id}/records")
def nb_record_create(request: Request, nb_id: str, body: dict[str, Any]) -> dict[str, Any]:
    nb = _get_item(request, "notebooks", nb_id) or {"id": nb_id, "records": []}
    rec = dict(body)
    rec.setdefault("id", uuid.uuid4().hex[:12])
    rec.setdefault("created_at", time.time())
    nb.setdefault("records", []).append(rec)
    _put_item(request, nb, "notebooks", nb_id)
    return rec


@router.get("/notebooks/{nb_id}/records/{rec_id}")
def nb_record_get(request: Request, nb_id: str, rec_id: str) -> dict[str, Any]:
    nb = _get_item(request, "notebooks", nb_id) or {}
    for r in nb.get("records") or []:
        if str(r.get("id")) == rec_id:
            return r
    return {"id": rec_id}


@router.delete("/notebooks/{nb_id}/records/{rec_id}")
def nb_record_delete(request: Request, nb_id: str, rec_id: str) -> dict[str, Any]:
    nb = _get_item(request, "notebooks", nb_id) or {"records": []}
    nb["records"] = [r for r in nb.get("records", []) if str(r.get("id")) != rec_id]
    _put_item(request, nb, "notebooks", nb_id)
    return {"ok": True}


@router.post("/notebooks/{nb_id}/records/{rec_id}/actions/{action}")
def nb_record_action(request: Request, nb_id: str, rec_id: str, action: str, body: dict[str, Any]) -> dict[str, Any]:
    nb = _get_item(request, "notebooks", nb_id) or {"records": []}
    for r in nb.get("records") or []:
        if str(r.get("id")) == rec_id:
            r.setdefault("actions", []).append({"action": action, "at": time.time(), **body})
            _put_item(request, nb, "notebooks", nb_id)
            return {"ok": True}
    return {"ok": False}


# -- mastery progress -----------------------------------------------------------

@router.get("/mastery-paths/progress/{topic_id}")
def mastery_progress_get(request: Request, topic_id: str) -> dict[str, Any]:
    return _get_item(request, "mastery", "progress", topic_id) or {"topic_id": topic_id, "modules": [], "status": "not_started"}


@router.post("/mastery-paths/progress/{topic_id}/init-modules")
def mastery_progress_init(request: Request, topic_id: str, body: dict[str, Any]) -> dict[str, Any]:
    prog = _get_item(request, "mastery", "progress", topic_id) or {"topic_id": topic_id}
    prog["modules"] = body.get("modules") or []
    prog["status"] = "in_progress"
    _put_item(request, prog, "mastery", "progress", topic_id)
    return prog


@router.put("/mastery-paths/progress/{topic_id}")
def mastery_progress_put(request: Request, topic_id: str, body: dict[str, Any]) -> dict[str, Any]:
    body["topic_id"] = topic_id
    _put_item(request, body, "mastery", "progress", topic_id)
    return {"ok": True}


# -- partners -------------------------------------------------------------------

@router.get("/partners")
def partners_list(request: Request) -> list[dict[str, Any]]:
    return _list_dir(request, "partners")


@router.post("/partners")
def partner_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    _put_item(request, body, "partners", "p")
    return body


@router.get("/partners/{pid}")
def partner_get(request: Request, pid: str) -> dict[str, Any]:
    return _get_item(request, "partners", pid) or {"id": pid}


@router.delete("/partners/{pid}")
def partner_delete(request: Request, pid: str) -> dict[str, Any]:
    return {"ok": _del_item(request, pid, "partners", "p")}


@router.post("/partners/consultation-session")
def partner_consult(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    sess = {"id": uuid.uuid4().hex[:12], "status": "active", "created_at": time.time(), **body}
    _put_item(request, sess, "partners", "sessions", "s")
    return sess


@router.post("/partners/drafts/{draft_id}")
def partner_draft_save(request: Request, draft_id: str, body: dict[str, Any]) -> dict[str, Any]:
    body["id"] = draft_id
    _put_item(request, body, "partners", "drafts", draft_id)
    return {"ok": True}


@router.get("/partners/drafts/{draft_id}")
def partner_draft_get(request: Request, draft_id: str) -> dict[str, Any]:
    return _get_item(request, "partners", "drafts", draft_id) or {"id": draft_id}


@router.get("/partner-groups/discussion-modes")
def partner_group_modes(request: Request) -> dict[str, Any]:
    return {"modes": _list_dir(request, "partner-groups", "modes") or [
        {"id": "free", "name": "Free discussion"},
        {"id": "structured", "name": "Structured"},
        {"id": "debate", "name": "Debate"},
    ]}


@router.get("/partner-groups")
def partner_groups(request: Request) -> list[dict[str, Any]]:
    return _list_dir(request, "partner-groups")


@router.post("/partner-groups")
def partner_group_create(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    _put_item(request, body, "partner-groups", "g")
    return body


@router.get("/partner-groups/{gid}")
def partner_group_get(request: Request, gid: str) -> dict[str, Any]:
    return _get_item(request, "partner-groups", gid) or {"id": gid}


@router.delete("/partner-groups/{gid}")
def partner_group_delete(request: Request, gid: str) -> dict[str, Any]:
    return {"ok": _del_item(request, gid, "partner-groups", "g")}


# -- skills ---------------------------------------------------------------------

@router.get("/skills/hub/catalog")
def skills_catalog(request: Request) -> dict[str, Any]:
    return {"skills": _list_dir(request, "skills")}


@router.get("/skills/hub/detail")
def skills_detail(request: Request) -> dict[str, Any]:
    return {"skills": _list_dir(request, "skills")}


@router.get("/skills/{skill_id}")
def skill_get(request: Request, skill_id: str) -> dict[str, Any]:
    return _get_item(request, "skills", skill_id) or {"id": skill_id}


@router.delete("/skills/{skill_id}")
def skill_delete(request: Request, skill_id: str) -> dict[str, Any]:
    return {"ok": _del_item(request, skill_id, "skills", "s")}


@router.get("/skills/tags/{tag}")
def skills_by_tag(request: Request, tag: str) -> dict[str, Any]:
    return {"skills": [s for s in _list_dir(request, "skills") if tag in (s.get("tags") or [])]}


# -- documents / imports / personas / misc ---------------------------------------

@router.get("/personas")
def personas_list(request: Request) -> dict[str, Any]:
    return {"personas": _list_dir(request, "personas")}


@router.post("/creations/drafts/{draft_id}/approve")
def creation_draft_approve(request: Request, draft_id: str, body: dict[str, Any]) -> dict[str, Any]:
    d = _get_item(request, "creations", "drafts", draft_id) or {"id": draft_id}
    d["status"] = "approved"
    _put_item(request, d, "creations", "drafts", draft_id)
    return d

# Note pages (``/documents``) live in ``app/api/documents.py``.

@router.post("/imports/chat-history")
def import_chat_history(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "imported": 0}


@router.get("/creations/drafts/{draft_id}")
def creation_draft_get(request: Request, draft_id: str) -> dict[str, Any]:
    return _get_item(request, "creations", "drafts", draft_id) or {"id": draft_id}


@router.post("/creations/drafts/{draft_id}")
def creation_draft_save(request: Request, draft_id: str, body: dict[str, Any]) -> dict[str, Any]:
    body["id"] = draft_id
    _put_item(request, body, "creations", "drafts", draft_id)
    return {"ok": True}


@router.get("/personas/{pid}")
def persona_get(request: Request, pid: str) -> dict[str, Any]:
    return _get_item(request, "personas", pid) or {"id": pid}


@router.post("/personas/{pid}")
def persona_save(request: Request, pid: str, body: dict[str, Any]) -> dict[str, Any]:
    body["id"] = pid
    _put_item(request, body, "personas", pid)
    return {"ok": True}


@router.get("/subagents/backends/{backend_id}")
def subagent_backend_get(request: Request, backend_id: str) -> dict[str, Any]:
    return {"id": backend_id, "status": "configured"}


@router.get("/subagents/connections/{conn_id}")
def subagent_conn_get(request: Request, conn_id: str) -> dict[str, Any]:
    return {"id": conn_id, "status": "active"}


@router.get("/video-learning/materials/{mat_id}")
def video_material_get(request: Request, mat_id: str) -> dict[str, Any]:
    return _get_item(request, "video-learning", "materials", mat_id) or {"id": mat_id}


@router.get("/dashboard/learning-library/{lib_id}")
def learning_library_get(request: Request, lib_id: str) -> dict[str, Any]:
    return _get_item(request, "dashboard", "library", lib_id) or {"id": lib_id, "items": []}


# -- session sub-actions ---------------------------------------------------------

@router.post("/sessions/{session_id}/migrate-watching")
def session_migrate_watching(request: Request, session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "migrated": True}


@router.post("/sessions/{session_id}/ask-hint")
def session_ask_hint(request: Request, session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"hint": "", "session_id": session_id}


@router.get("/sessions/{session_id}/branch-selection")
def session_branch_selection(request: Request, session_id: str) -> dict[str, Any]:
    return {"branches": []}


@router.post("/sessions/{session_id}/branch-selection")
def session_branch_select(request: Request, session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True}


@router.get("/sessions/{session_id}/quiz-results")
def session_quiz_results(request: Request, session_id: str) -> dict[str, Any]:
    return {"results": []}


@router.post("/sessions/submission-replacement")
def submission_replacement(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "receipt": {"id": uuid.uuid4().hex[:12]}}


# -- settings extras (presets / services preview / tests) --------------------------

@router.get("/settings/presets/{preset_id}/draft")
def settings_preset_draft(request: Request, preset_id: str) -> dict[str, Any]:
    return {"preset_id": preset_id, "draft": {}}


@router.post("/settings/presets/{preset_id}/draft")
def settings_preset_draft_save(request: Request, preset_id: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True}


@router.post("/settings/services/{service}/preview")
def settings_service_preview(request: Request, service: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"service": service, "preview": {}}


@router.post("/settings/tests/{service}/start")
async def settings_test_start(
    request: Request, service: str, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Start a bounded diagnostic probe of the model being configured.

    The browser sends the whole draft catalog so the test uses unsaved edits.
    A run id is returned immediately; progress arrives on the SSE events route.
    """
    from ..services.config_test import get_config_test_runner

    catalog = (body or {}).get("catalog")
    if not isinstance(catalog, dict):
        catalog = provider_config.load_catalog(_settings(request))
    run = get_config_test_runner().start(service, catalog)
    return {"run_id": run.id}


@router.get("/settings/tests/{service}/{run_id}/events")
async def settings_test_events(
    request: Request, service: str, run_id: str
) -> StreamingResponse:
    """Stream probe events until the run finishes, then close the stream."""
    from ..services.config_test import get_config_test_runner

    run = get_config_test_runner().get(run_id)
    if run is None or run.service != service:
        raise HTTPException(status_code=404, detail="Test run not found.")

    async def event_stream():
        sent = 0
        try:
            while True:
                if await request.is_disconnected():
                    return
                events = run.snapshot(sent)
                if events:
                    for event in events:
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    sent += len(events)
                    if run.is_terminal():
                        return
                else:
                    yield "event: heartbeat\ndata: {}\n\n"
                await asyncio.sleep(0.2)
        finally:
            if not run.is_terminal():
                run.cancelled = True

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/settings/tests/{service}/{run_id}/cancel")
def settings_test_cancel(service: str, run_id: str) -> dict[str, Any]:
    from ..services.config_test import get_config_test_runner

    cancelled = get_config_test_runner().cancel(run_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail="Test run not found.")
    return {"message": "Cancelled"}


# Catch-all for settings sub-pages/extensions the UI probes (GET/PUT/POST).
# Registered last so specific settings routes (tests, presets, preview, ...)
# always win — an earlier catch-all silently swallowed them and returned {}.
@router.api_route(
    "/settings/{path:path}",
    methods=["GET", "PUT", "POST", "DELETE", "PATCH"],
)
def settings_catchall(path: str) -> dict[str, Any]:
    return {}
