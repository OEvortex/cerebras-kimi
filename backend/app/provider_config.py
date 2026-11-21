"""DeepTutor-owned provider / model configuration.

This module is the *only* source of truth for which providers and models the
Settings UI features and which model a turn actually runs. Nothing here reads
``~/.vtx`` — the vtx SDK is used purely as an execution engine. Callers pass
the resolved provider / model / base_url / api_key into vtx explicitly (see
``agent/runtime.py``), so vtx never needs to consult its own config for model
selection.

Persistence lives in the shared SQLite database (``data/deeptutor.sqlite3``)
under the ``settings/catalog`` and ``settings/selection`` keys. Older releases
kept them in ``settings-catalog.json`` / ``settings.json``; those files are
imported once by :mod:`app.store.database` and are no longer read or written.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

from .config import Settings

SERVICES: tuple[str, ...] = (
    "llm", "task", "embedding", "search", "tts", "stt", "imagegen", "videogen",
)

_HEADERS = {"User-Agent": "DeepTutor/0.1 (+https://deeptutor.info)"}
_RECENT_LIMIT = 20
_PROBE_TIMEOUT = 20.0


# ---------------------------------------------------------------------------
# Built-in presets — loaded from DeepTutor's own catalog file. No vtx import.
# ---------------------------------------------------------------------------

_CATALOG_FILE = Path(__file__).with_name("provider_catalog.json")


def _load_presets() -> dict[str, dict[str, Any]]:
    """Normalize provider_catalog.json into the preset shape used below."""
    try:
        raw = json.loads(_CATALOG_FILE.read_text(encoding="utf-8"))
        entries = raw.get("providers") or []
    except Exception:
        entries = []
    presets: dict[str, dict[str, Any]] = {}
    for entry in entries:
        slug = str(entry.get("slug") or "").strip().lower()
        if not slug:
            continue
        family = str(entry.get("family") or "openai_compat")
        env = entry.get("api_key_env") or ""
        presets[slug] = {
            "slug": slug,
            "label": str(entry.get("display_name") or slug),
            "description": str(entry.get("description") or ""),
            "base_url": str(entry.get("base_url") or ""),
            "api_format": "anthropic" if family == "anthropic" else "openai_chat",
            "family": family,
            "api_key_env": str(env) if env else "",
            "known_models": [str(m) for m in (entry.get("known_models") or [])],
            "supports_vision": bool(entry.get("supports_vision", False)),
            "supports_thinking": bool(entry.get("supports_thinking", False)),
            "api_key_optional": bool(entry.get("api_key_optional", False)),
            "is_local": bool(entry.get("is_local", False)),
            "headers": dict(entry.get("headers") or {}),
            "openmodelendpoint": bool(entry.get("openmodelendpoint", False)),
            "fetch_models": bool(entry.get("fetch_models", False)),
            "models_endpoint": str(entry.get("models_endpoint") or "/models"),
            "model_parser": dict(entry.get("model_parser") or {}),
            "services": tuple(entry.get("services") or ("llm",)),
        }
    return presets


_BUILTIN = _load_presets()

# Provider slugs whose wire protocol vtx must not infer from the model name.
_anthropic_slugs = {"anthropic", "aerolink"}
_responses_slugs = {"openai-responses", "codex", "openai-codex"}


def builtin_preset(slug: str | None) -> dict[str, Any] | None:
    if not slug:
        return None
    return _BUILTIN.get(slug.strip().lower())


def builtin_presets() -> dict[str, dict[str, Any]]:
    return _BUILTIN


def preset_api_key(slug: str | None) -> str:
    """API key for a built-in preset from its conventional env var."""
    return _env_key(builtin_preset(slug))


# ---------------------------------------------------------------------------
# Catalog IO — DeepTutor's own files
# ---------------------------------------------------------------------------

def _read_state(settings: Settings, key: str) -> dict[str, Any]:
    from .store import database

    data = database.get_state(settings, key, {})
    return data if isinstance(data, dict) else {}


def _write_state(settings: Settings, key: str, data: dict[str, Any]) -> None:
    from .store import database

    database.put_state(settings, key, data)


def default_catalog() -> dict[str, Any]:
    return {
        "version": 1,
        "connections": [],
        "recent_models": [],
        "llm_selection": None,
        "services": {
            name: {"active_profile_id": None, "profiles": []} for name in SERVICES
        },
    }


def load_catalog(settings: Settings) -> dict[str, Any]:
    data = _read_state(settings, "settings/catalog") or default_catalog()
    # Fill missing top-level keys so old catalogs keep working.
    defaults = default_catalog()
    for key, value in defaults.items():
        data.setdefault(key, value)
    services = data.setdefault("services", {})
    for name, svc in defaults["services"].items():
        bucket = services.setdefault(name, {})
        for key, value in svc.items():
            bucket.setdefault(key, value)
    return data


def save_catalog(settings: Settings, catalog: dict[str, Any]) -> None:
    _write_state(settings, "settings/catalog", catalog)


# ---------------------------------------------------------------------------
# Active LLM selection
# ---------------------------------------------------------------------------

def _clean_selection(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    profile_id = str(value.get("profile_id") or "").strip()
    model_id = str(value.get("model_id") or "").strip()
    if not profile_id or not model_id:
        return None
    sel: dict[str, Any] = {"profile_id": profile_id, "model_id": model_id}
    effort = value.get("reasoning_effort")
    if effort:
        sel["reasoning_effort"] = effort
    return sel


def get_selection(settings: Settings, override: Any = None) -> dict[str, Any] | None:
    """Resolve the active selection: explicit override → catalog → legacy file."""
    sel = _clean_selection(override)
    if sel:
        return sel
    catalog = load_catalog(settings)
    sel = _clean_selection(catalog.get("llm_selection"))
    if sel:
        return sel
    sel = _clean_selection(_read_state(settings, "settings/selection").get("llm_selection"))
    return sel


def set_selection(settings: Settings, selection: Any) -> dict[str, Any] | None:
    """Persist the active selection and update recency."""
    sel = _clean_selection(selection)
    if sel is None:
        return None
    catalog = load_catalog(settings)
    catalog["llm_selection"] = sel
    recent = [item for item in (catalog.get("recent_models") or [])
              if not (isinstance(item, dict)
                      and item.get("profile_id") == sel["profile_id"]
                      and item.get("model_id") == sel["model_id"])]
    recent.insert(0, dict(sel))
    catalog["recent_models"] = recent[:_RECENT_LIMIT]
    save_catalog(settings, catalog)

    # Keep the selection also under its own key: cheap to read when only the
    # active model is needed, and it survives a catalog reset.
    _write_state(settings, "settings/selection", {"llm_selection": sel})
    return sel


def recent_pairs(settings: Settings) -> set[tuple[str, str]]:
    catalog = load_catalog(settings)
    out: set[tuple[str, str]] = set()
    for item in catalog.get("recent_models") or []:
        if isinstance(item, dict) and item.get("profile_id") and item.get("model_id"):
            out.add((item["profile_id"], item["model_id"]))
    return out


def is_recent_option(
    recent: set[tuple[str, str]],
    profile_id: str,
    model_id: str,
    provider: str,
    wire_model: str,
) -> bool:
    """A recent entry may predate the catalog's generated ids."""
    if (profile_id, model_id) in recent:
        return True
    return any(
        entry_provider == provider
        and entry_model in (model_id, wire_model)
        for entry_provider, entry_model in recent
    )


# ---------------------------------------------------------------------------
# Runtime resolution — what actually gets sent to vtx
# ---------------------------------------------------------------------------

def _find_profile(catalog: dict[str, Any], profile_id: str) -> dict[str, Any] | None:
    for service in SERVICES:
        for profile in (catalog.get("services", {}).get(service, {}).get("profiles") or []):
            if profile.get("id") == profile_id:
                return profile
    return None


def _find_connection(catalog: dict[str, Any], connection_id: Any) -> dict[str, Any] | None:
    if not connection_id:
        return None
    for conn in catalog.get("connections") or []:
        if conn.get("id") == connection_id:
            return conn
    return None


def _connection_for_provider(catalog: dict[str, Any], provider: str) -> dict[str, Any] | None:
    for conn in catalog.get("connections") or []:
        if conn.get("provider") == provider:
            return conn
    return None


def _env_key(preset: dict[str, Any] | None) -> str:
    if not preset:
        return ""
    name = preset.get("api_key_env") or ""
    return os.environ.get(name, "").strip() if name else ""


def _vtx_provider_slug(provider: str, api_format: str | None) -> str:
    """Pick the provider label vtx uses to choose a wire protocol.

    Known slugs stay as-is; unknown custom endpoints are mapped from the
    declared API format so vtx does not guess the wrong SDK.
    """
    slug = (provider or "").strip() or "openai"
    fmt = (api_format or "auto").strip().lower()
    if fmt == "anthropic" and slug not in _anthropic_slugs:
        return "anthropic"
    if fmt == "openai_responses" and slug not in _responses_slugs:
        return "openai-responses"
    return slug


def resolve_runtime_model(
    settings: Settings,
    command: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return everything needed to build a vtx runtime, from DeepTutor data.

    Keys: provider, model, base_url, api_key, thinking_level, profile_id,
    model_id, source. ``provider`` is a vtx-compatible label; ``model`` is the
    wire model id. Never reads ~/.vtx.
    """
    command = command or {}
    selection = get_selection(settings, command.get("llm_selection"))
    catalog = load_catalog(settings)

    profile_id = str(selection.get("profile_id") if selection else "") or ""
    model_id = str(selection.get("model_id") if selection else "") or ""
    # Legacy/raw commands can still carry model_provider + model directly.
    provider_hint = str(command.get("model_provider") or "").strip()
    model_hint = str(command.get("model") or "").strip()

    preset = builtin_preset(profile_id)
    thinking = str((selection or {}).get("reasoning_effort") or "").strip() or None

    if profile_id and (profile := _find_profile(catalog, profile_id)):
        model_entry: dict[str, Any] = {}
        for m in profile.get("models") or []:
            if str(m.get("id")) == model_id:
                model_entry = m
                break
        # Connections can be linked at the profile level or from the model's
        # provider_ref (the settings UI uses the latter for synced models).
        conn = _find_connection(catalog, profile.get("connection_id")) or _find_connection(
            catalog, (model_entry.get("provider_ref") or {}).get("connection_id")
        )
        provider_raw = str(
            profile.get("binding") or profile.get("provider")
            or (conn or {}).get("provider") or "openai"
        )
        base_url = str(profile.get("base_url") or (conn or {}).get("base_url") or "").strip()
        api_key = str(profile.get("api_key") or (conn or {}).get("api_key") or "").strip()
        api_format = profile.get("api_format") or (conn or {}).get("api_format")
        model = str(model_entry.get("model") or model_hint or model_id)
        thinking = thinking or str(model_entry.get("reasoning_effort") or "").strip() or None
        source = f"profile:{profile_id}"
    elif preset is not None:
        # A model chosen from the built-in preset list (e.g. env-key usage).
        conn = _connection_for_provider(catalog, profile_id)
        provider_raw = profile_id
        base_url = str((conn or {}).get("base_url") or preset.get("base_url") or "").strip()
        api_key = str((conn or {}).get("api_key") or _env_key(preset)).strip()
        api_format = preset.get("api_format")
        model = model_hint or model_id
        source = f"preset:{profile_id}"
    elif provider_hint:
        conn = _connection_for_provider(catalog, provider_hint)
        preset = builtin_preset(provider_hint)
        provider_raw = provider_hint
        base_url = str((conn or {}).get("base_url") or (preset or {}).get("base_url") or "").strip()
        api_key = str((conn or {}).get("api_key") or _env_key(preset)).strip()
        api_format = (preset or {}).get("api_format")
        model = model_hint or model_id or str(settings.default_model or "")
        source = "command"
    else:
        provider_raw = "openai"
        base_url, api_key, api_format = "", "", None
        model = model_hint or model_id or str(settings.default_model or "")
        source = "default"

    return {
        "provider": _vtx_provider_slug(provider_raw, api_format),
        "model": model,
        "base_url": base_url or None,
        "api_key": api_key or None,
        "thinking_level": thinking,
        "profile_id": profile_id,
        "model_id": model_id,
        "source": source,
    }


# ---------------------------------------------------------------------------
# UI-facing option builders
# ---------------------------------------------------------------------------

def _option(
    profile_id: str,
    model_id: str,
    *,
    profile_name: str,
    provider_label: str,
    model_name: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    supports_vision: bool = False,
    supports_thinking: bool = False,
    context_window: Any = None,
    reasoning_efforts: Any = None,
    declared_reasoning: bool = False,
    is_active_default: bool = False,
    is_recent: bool = False,
) -> dict[str, Any]:
    opt: dict[str, Any] = {
        "profile_id": profile_id,
        "model_id": model_id,
        "profile_name": profile_name,
        "model_name": model_name or model or model_id,
        "model": model or model_id,
        "provider": provider or profile_id,
        "provider_label": provider_label,
        "supports_vision": bool(supports_vision),
        "supports_thinking": bool(supports_thinking),
        "is_active_default": is_active_default,
    }
    if isinstance(context_window, (int, float)) and context_window:
        opt["context_window"] = int(context_window)
    elif isinstance(context_window, str) and context_window.strip().isdigit():
        opt["context_window"] = int(context_window.strip())
    if isinstance(reasoning_efforts, list) and reasoning_efforts:
        opt["supported_reasoning_efforts"] = [str(x) for x in reasoning_efforts]
    if declared_reasoning:
        opt["declared_reasoning"] = True
    if is_recent:
        opt["is_recent"] = True

    # vtx's models.dev metadata is authoritative for limits and effort levels.
    # Keep it under distinct keys so the UI can prefer it while a manually
    # entered catalog value remains an explicit override.
    vtx = vtx_model_metadata(str(model or model_id))
    if vtx:
        opt["vtx_context_window"] = vtx["context_window"]
        opt["vtx_max_tokens"] = vtx["max_tokens"]
        opt["vtx_supported_reasoning_efforts"] = vtx["supported_reasoning_efforts"]
        opt["vtx_capabilities"] = {
            "reasoning": vtx["supports_reasoning"],
            "vision": vtx["supports_vision"],
            "tools": vtx["supports_tools"],
            "audio": vtx["supports_audio"],
        }
        if not opt.get("context_window"):
            opt["context_window"] = vtx["context_window"]
        if not opt.get("supported_reasoning_efforts"):
            opt["supported_reasoning_efforts"] = vtx["supported_reasoning_efforts"]
    return opt


def model_options(settings: Settings) -> list[dict[str, Any]]:
    """Every model the Settings/composer UI should feature, from our catalog.

    Saved profiles win; built-in presets fill in when a profile has no saved
    models so a fresh install can still pick a model.
    """
    catalog = load_catalog(settings)
    selection = get_selection(settings)
    recent = recent_pairs(settings)
    active_key = ""
    if selection:
        active_key = f"{selection['profile_id']}:{selection['model_id']}"
    options: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for profile in catalog.get("services", {}).get("llm", {}).get("profiles") or []:
        pid = str(profile.get("id") or "")
        if not pid:
            continue
        conn = _find_connection(catalog, profile.get("connection_id"))
        if conn is None:
            for m in profile.get("models") or []:
                conn = _find_connection(
                    catalog, (m.get("provider_ref") or {}).get("connection_id")
                )
                if conn is not None:
                    break
        provider_slug = str(
            profile.get("binding") or profile.get("provider")
            or (conn or {}).get("provider") or ""
        )
        preset = builtin_preset(provider_slug)
        label = str(
            profile.get("display_name") or profile.get("name")
            or (preset or {}).get("label") or pid
        )
        for m in profile.get("models") or []:
            mid = str(m.get("id") or "")
            if not mid:
                continue
            key = (pid, mid)
            if key in seen:
                continue
            seen.add(key)
            caps = m.get("capabilities") or {}
            if not isinstance(caps, dict):
                caps = {}
            efforts = m.get("supported_reasoning_efforts") or m.get("codex_supported_reasoning_levels")
            wire_model = str(m.get("model") or m.get("name") or mid)
            options.append(_option(
                pid, mid,
                profile_name=label,
                provider_label=label,
                model_name=str(m.get("name") or wire_model),
                model=wire_model,
                provider=provider_slug or pid,
                supports_vision=bool(
                    caps.get("vision") or (preset or {}).get("supports_vision")
                ),
                supports_thinking=bool(
                    caps.get("reasoning") or (preset or {}).get("supports_thinking")
                ),
                context_window=m.get("context_window_tokens") or m.get("context_window"),
                reasoning_efforts=efforts,
                declared_reasoning=bool(caps.get("reasoning")),
                is_active_default=f"{pid}:{mid}" == active_key,
                is_recent=is_recent_option(recent, pid, mid, provider_slug, wire_model),
            ))

    # Preset fallback for slugs with no saved profile (env-key usage). Only
    # models the learner has actually picked are surfaced — an unconfigured
    # built-in preset must not fill the composer with OpenAI/Gemini/xAI rows.
    for slug, preset in _BUILTIN.items():
        conn = _connection_for_provider(catalog, slug)
        if conn and any(
            str(p.get("binding") or p.get("provider") or "").lower() == slug
            for p in catalog.get("services", {}).get("llm", {}).get("profiles") or []
        ):
            continue
        for mid in preset.get("known_models") or []:
            key = (slug, str(mid))
            if key in seen:
                continue
            is_recent = is_recent_option(recent, slug, str(mid), slug, str(mid))
            if not is_recent:
                continue
            seen.add(key)
            options.append(_option(
                slug, str(mid),
                profile_name=str(preset.get("label") or slug),
                provider_label=str(preset.get("label") or slug),
                supports_vision=bool(preset.get("supports_vision")),
                supports_thinking=bool(preset.get("supports_thinking")),
                is_active_default=f"{slug}:{mid}" == active_key,
                is_recent=True,
            ))
    return options


def provider_options(settings: Settings) -> list[dict[str, Any]]:
    """Provider rows for the Connections page — our presets + saved ones."""
    catalog = load_catalog(settings)
    options: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(slug: str, label: str, base_url: str, default_model: str | None,
            vision: bool = False, thinking: bool = False) -> None:
        if slug in seen:
            return
        seen.add(slug)
        options.append({
            "value": slug,
            "label": label,
            "base_url": base_url,
            "default_model": default_model,
            "auth_mode": "api_key",
            "api_key_env": (builtin_preset(slug) or {}).get("api_key_env"),
            "supports_vision": bool(vision),
            "supports_thinking": bool(thinking),
            "status": "supported",
        })

    for conn in catalog.get("connections") or []:
        slug = str(conn.get("provider") or "").strip()
        if not slug:
            continue
        preset = builtin_preset(slug) or {}
        add(slug,
            str(conn.get("name") or preset.get("label") or slug),
            str(conn.get("base_url") or ""),
            None,
            bool(preset.get("supports_vision")),
            bool(preset.get("supports_thinking")))

    for slug, preset in _BUILTIN.items():
        known = preset.get("known_models") or []
        add(slug, str(preset.get("label") or slug),
            str(preset.get("base_url") or ""),
            str(known[0]) if known else None,
            bool(preset.get("supports_vision")),
            bool(preset.get("supports_thinking")))
    return options


def connection_targets(settings: Settings) -> list[dict[str, Any]]:
    """Per-provider prefills for the Connections page."""
    catalog = load_catalog(settings)
    targets: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(slug: str, label: str, base_url: str, models: list[str],
            services: tuple[str, ...]) -> None:
        if slug in seen:
            return
        seen.add(slug)
        targets.append({
            "provider": slug,
            "label": label,
            "default_base_url": base_url,
            "services": {
                service: {
                    "provider": slug,
                    "base_url": base_url,
                    "default_model": models[0] if models else "",
                }
                for service in services
            },
        })

    for conn in catalog.get("connections") or []:
        slug = str(conn.get("provider") or "").strip()
        if not slug:
            continue
        preset = builtin_preset(slug) or {}
        add(slug,
            str(conn.get("name") or preset.get("label") or slug),
            str(conn.get("base_url") or ""),
            list(preset.get("known_models") or []),
            tuple(preset.get("services") or ("llm",)))

    for slug, preset in _BUILTIN.items():
        add(slug, str(preset.get("label") or slug),
            str(preset.get("base_url") or ""),
            list(preset.get("known_models") or []),
            tuple(preset.get("services") or ("llm",)))
    return targets


def vtx_model_metadata(model_id: str) -> dict[str, Any] | None:
    """Authoritative model limits/efforts from vtx's models.dev metadata.

    Returns ``None`` when vtx has no verified limits for this id. Local catalog
    values remain explicit user overrides; everything else comes from vtx.
    """
    if not model_id:
        return None
    try:
        from vtx.ai.context_length import context_length_manager
        from vtx.ai.thinking import get_supported_thinking_levels

        limits = context_length_manager.get_limits(model_id)
        if not limits or not getattr(limits, "context", 0):
            return None
        try:
            efforts = get_supported_thinking_levels(limits)  # ty:ignore[missing-argument, too-many-positional-arguments]
        except Exception:  # noqa: BLE001 - effort metadata is optional
            efforts = []
        return {
            "context_window": int(limits.context),
            "max_tokens": int(getattr(limits, "output", 0) or 0),
            "supports_reasoning": bool(getattr(limits, "supports_reasoning", False)),
            "supports_vision": bool(getattr(limits, "supports_vision", False)),
            "supports_tools": bool(getattr(limits, "supports_tools", False)),
            "supports_audio": bool(getattr(limits, "supports_audio", False)),
            "supported_reasoning_efforts": [
                "none" if level == "off" else level for level in efforts
            ],
        }
    except Exception:  # noqa: BLE001 - metadata lookup is best effort
        return None


def context_window_for(profile_id: str, model_id: str) -> int:
    """Context window for the composer's token bar, from our own catalog."""
    settings = get_settings()
    catalog = load_catalog(settings)
    profile = _find_profile(catalog, profile_id)
    if profile:
        for m in profile.get("models") or []:
            if str(m.get("id")) == model_id:
                value = m.get("context_window_tokens") or m.get("context_window")
                try:
                    return int(str(value).strip())
                except (TypeError, ValueError):
                    return 0
    return 0


# ---------------------------------------------------------------------------
# Live model discovery (no vtx fetchers, no ~/.vtx caches)
# ---------------------------------------------------------------------------

def _extract_models(payload: Any, parser: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Parse a provider's /models payload into normalized model rows.

    Supports the catalog's ``model_parser`` options: ``array_path``,
    ``flatten_field``, ``id_field``, ``name_field``, ``context_field`` and
    ``output_field``. Defaults match the OpenAI shape.
    """
    parser = parser or {}
    array_path = str(parser.get("array_path") or "data")
    flatten_field = parser.get("flatten_field")
    id_field = str(parser.get("id_field") or "id")
    name_field = str(parser.get("name_field") or "name")
    context_field = str(parser.get("context_field") or "context_length")
    output_field = str(parser.get("output_field") or "max_completion_tokens")

    items: Any = payload
    if isinstance(payload, dict):
        if flatten_field:
            items = payload.get(str(flatten_field))
            if items is None:
                root = payload.get("data") or payload.get("models") or {}
                items = root.get(str(flatten_field)) if isinstance(root, dict) else None
        else:
            items = (
                payload.get(array_path) or payload.get("models")
                or payload.get("data")
            )
    if not isinstance(items, list):
        return []

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, str):
            mid, name, raw = item.strip(), item.strip(), {}
        elif isinstance(item, dict):
            mid = str(
                item.get(id_field) or item.get("id") or item.get("model_id") or ""
            ).strip()
            name = str(item.get(name_field) or item.get("name") or mid)
            raw = item
        else:
            continue
        if not mid or mid in seen:
            continue
        seen.add(mid)
        row: dict[str, Any] = {"id": mid, "name": name}
        for key, field in (("context_window", context_field), ("max_tokens", output_field)):
            value = raw.get(field) if isinstance(raw, dict) else None
            if isinstance(value, (int, float)) and value > 0:
                row[key] = int(value)
        out.append(row)
    return out


def probe_models(
    base_url: str,
    api_key: str | None = None,
    api_format: str | None = None,
    preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """GET the provider's models endpoint directly (no vtx fetchers/caches)."""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return {"status": "unreachable", "models": [], "http_status": None}
    if not base.lower().startswith(("http://", "https://")):
        return {"status": "invalid_url", "models": [], "http_status": None}

    preset = preset or {}
    headers = dict(_HEADERS)
    for key, value in (preset.get("headers") or {}).items():
        headers[str(key)] = str(value)
    fmt = str(api_format or preset.get("api_format") or "").strip().lower()
    if api_key:
        if fmt == "anthropic":
            headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
        else:
            headers["Authorization"] = f"Bearer {api_key}"

    endpoint = str(preset.get("models_endpoint") or "")
    if not endpoint:
        endpoint = "/v1/models" if fmt == "anthropic" else "/models"
    url = f"{base}/{endpoint.lstrip('/')}"
    try:
        with httpx.Client(timeout=_PROBE_TIMEOUT, follow_redirects=True) as client:
            response = client.get(url, headers=headers)
    except httpx.HTTPError:
        return {"status": "unreachable", "models": [], "http_status": None}

    if response.status_code >= 400:
        return {
            "status": "unavailable",
            "models": [],
            "http_status": response.status_code,
        }
    try:
        models = _extract_models(response.json(), preset.get("model_parser"))
    except Exception:
        models = []
    return {
        "status": "connected" if models else "unavailable",
        # Return the provider's full catalog. A hard cap here (previously 200)
        # silently dropped valid models from gateways that publish large lists
        # (e.g. Kilo), so the settings UI reported a truncated count.
        "models": models,
        "http_status": response.status_code,
    }


def store_discovered_models(
    settings: Settings,
    provider: str,
    models: list[Any],
    *,
    connection_id: str | None = None,
) -> None:
    """Persist discovered models (ids or full rows) into the DeepTutor catalog."""
    if not provider or not models:
        return
    rows: list[dict[str, Any]] = []
    for model in models:
        if isinstance(model, dict) and model.get("id"):
            rows.append(dict(model))
        elif isinstance(model, str) and model.strip():
            rows.append({"id": model.strip(), "name": model.strip()})
    if not rows:
        return
    catalog = load_catalog(settings)
    changed = False
    for conn in catalog.get("connections") or []:
        match = (connection_id and conn.get("id") == connection_id) or (
            not connection_id and conn.get("provider") == provider
        )
        if not match:
            continue
        conn.setdefault("discovery", {})["models"] = rows
        conn["discovery"]["status"] = "connected"
        conn["discovery"]["checked_at"] = time.time()
        changed = True
    if changed:
        save_catalog(settings, catalog)


# Imported lazily at call sites that need a fresh Settings instance.
def get_settings() -> Settings:
    from .config import get_settings as _get_settings
    return _get_settings()
