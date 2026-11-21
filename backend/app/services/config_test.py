"""Live configuration diagnostics for the Settings "Test this model" action.

The settings editor sends a *draft* catalog to ``POST /api/settings/tests/...``.
This module resolves the addressed profile/model (including ``provider_ref``
connections), performs a small bounded completion against the provider, and
streams progress events back to the browser over SSE.

The draft is never persisted: a probe only reports what it observed, and the
user still has to apply their changes.
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx

from .. import provider_config
from .llm_text import clean_thinking_tags


_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
_PROBE_SYSTEM = "This is a connection test. Respond briefly."
_PROBE_PROMPT = "Reply with OK."


def _redact(value: str) -> str:
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}...{value[-4:]}"


def _headers(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items() if v is not None}


def _as_int(value: Any) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


@dataclass
class TestRun:
    id: str
    service: str
    status: str = "running"
    events: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    cancelled: bool = False

    def emit(self, kind: str, message: str, **extra: Any) -> None:
        payload = {
            "type": kind,
            "message": message,
            "timestamp": time.time(),
            **extra,
        }
        with self.lock:
            self.events.append(payload)

    def snapshot(self, start: int) -> list[dict[str, Any]]:
        with self.lock:
            return self.events[start:]

    def is_terminal(self) -> bool:
        return self.status in ("completed", "failed")


class ConfigTestRunner:
    """In-memory registry of diagnostic runs (one per ``start`` call)."""

    _instance: "ConfigTestRunner | None" = None

    def __init__(self) -> None:
        self._runs: dict[str, TestRun] = {}
        self._lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "ConfigTestRunner":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def start(self, service: str, catalog: dict[str, Any]) -> TestRun:
        run = TestRun(id=f"{service}-{uuid4().hex[:10]}", service=service)
        with self._lock:
            self._runs[run.id] = run
        threading.Thread(
            target=self._run_sync, args=(run, catalog), daemon=True
        ).start()
        return run

    def get(self, run_id: str) -> TestRun | None:
        with self._lock:
            return self._runs.get(run_id)

    def cancel(self, run_id: str) -> bool:
        run = self.get(run_id)
        if run is None:
            return False
        run.cancelled = True
        return True

    def _run_sync(self, run: TestRun, catalog: dict[str, Any]) -> None:
        try:
            resolved = resolve_draft_config(catalog, run.service)
            run.emit("info", "Preparing configuration snapshot.")
            run.emit(
                "config",
                "Using active profile.",
                profile={
                    "name": resolved.get("profile_name", ""),
                    "base_url": resolved.get("base_url", ""),
                    "binding": resolved.get("binding", ""),
                    "api_key": _redact(resolved.get("api_key") or ""),
                },
                model=resolved.get("wire_model", ""),
            )
            run.emit("info", f"Resolved model `{resolved['wire_model']}`.")
            run.emit("info", f"Request target: {resolved['base_url']}")

            if run.service in ("llm", "task"):
                asyncio.run(self._test_text(run, resolved))
            else:
                raise ValueError(
                    f"Model tests are not available for service '{run.service}' yet."
                )
            if not run.cancelled and run.status == "running":
                run.status = "completed"
                run.emit("completed", f"{run.service.upper()} test completed successfully.")
        except Exception as exc:  # surfaced to the UI as a `failed` SSE event
            run.status = "failed"
            run.emit("failed", str(exc) or exc.__class__.__name__)

    async def _test_text(self, run: TestRun, resolved: dict[str, Any]) -> None:
        max_tokens = 32 if run.service == "task" else 64
        run.emit("info", "Sending a short completion probe.")
        reply = await complete_with_config(
            resolved,
            system=_PROBE_SYSTEM,
            prompt=_PROBE_PROMPT,
            max_tokens=max_tokens,
            cancelled=lambda: run.cancelled,
        )
        snippet = (reply or "").strip()
        run.emit("response", "Received model response.", snippet=snippet[:400])
        if not snippet:
            raise ValueError("Model returned an empty response.")
        if run.service != "llm" or run.cancelled:
            return

        run.emit("info", "Checking the model's context window.")
        detection = context_window_for(resolved)
        run.emit(
            "context_window",
            (
                f"Context capacity unknown; conservative budget {detection['context_window']} tokens."
                if detection["source"] == "default"
                else f"Detected context window {detection['context_window']} tokens ({detection['source']})."
            ),
            context_window=detection["context_window"],
            source=detection["source"],
            detail=detection["detail"],
            detected_at=detection["detected_at"],
        )
        run.emit(
            "info",
            "Context window detection is read-only here; nothing was written to your settings.",
        )


def get_config_test_runner() -> ConfigTestRunner:
    return ConfigTestRunner.get_instance()


# -- draft catalog resolution ------------------------------------------------


def resolve_draft_config(catalog: dict[str, Any], service: str) -> dict[str, Any]:
    """Resolve the profile/model the settings editor is currently configuring.

    Unlike ``provider_config.resolve_runtime_model`` (which reads the saved
    selection), this works from the supplied draft so unsaved edits are tested.
    """
    services = catalog.get("services") or {}
    bucket = services.get(service) or {}
    saved_selection = catalog.get("llm_selection") or {}

    profile_id = str(bucket.get("active_profile_id") or "")
    model_id = str(bucket.get("active_model_id") or "")
    if service == "llm":
        profile_id = profile_id or str(saved_selection.get("profile_id") or "")
        model_id = model_id or str(saved_selection.get("model_id") or "")

    profile = (
        provider_config._find_profile(catalog, profile_id) if profile_id else None
    )
    model_entry: dict[str, Any] = {}
    if profile:
        for item in profile.get("models") or []:
            if str(item.get("id")) == model_id:
                model_entry = item
                break

    conn = None
    if profile:
        conn = provider_config._find_connection(catalog, profile.get("connection_id"))
    conn = conn or provider_config._find_connection(
        catalog, (model_entry.get("provider_ref") or {}).get("connection_id")
    )
    ref = model_entry.get("provider_ref") or (profile or {}).get("provider_ref") or {}

    binding = str(
        (profile or {}).get("binding")
        or (profile or {}).get("provider")
        or (conn or {}).get("provider")
        or ref.get("binding")
        or "openai"
    ).strip()
    preset = provider_config.builtin_preset(binding) or {}

    base_url = str(
        (profile or {}).get("base_url")
        or (conn or {}).get("base_url")
        or ref.get("default_base_url")
        or preset.get("base_url")
        or ""
    ).strip()
    api_key = str(
        (profile or {}).get("api_key") or (conn or {}).get("api_key") or ""
    ).strip()
    if not api_key:
        api_key = provider_config.preset_api_key(binding).strip()
    api_format = (
        (profile or {}).get("api_format")
        or (conn or {}).get("api_format")
        or preset.get("api_format")
    )
    api_version = str(
        (profile or {}).get("api_version") or (conn or {}).get("api_version") or ""
    ).strip()

    extra_headers: dict[str, str] = {}
    extra_headers.update(_headers(preset.get("headers")))
    extra_headers.update(_headers((conn or {}).get("extra_headers")))
    extra_headers.update(_headers((profile or {}).get("extra_headers")))

    wire_model = str(
        model_entry.get("model")
        or model_entry.get("name")
        or model_id
    ).strip()
    if not wire_model:
        raise ValueError("No model is selected for this test.")

    return {
        "provider": provider_config._vtx_provider_slug(binding, api_format),
        "binding": binding,
        "wire_model": wire_model,
        "base_url": base_url,
        "api_key": api_key,
        "api_format": api_format,
        "api_version": api_version,
        "extra_headers": extra_headers,
        "reasoning_effort": str(
            model_entry.get("reasoning_effort")
            or (profile or {}).get("reasoning_effort")
            or ""
        ).strip() or None,
        "context_window": _as_int(
            model_entry.get("context_window_tokens")
            or model_entry.get("context_window")
        ),
        "profile_name": str((profile or {}).get("name") or ""),
    }


# -- provider call -----------------------------------------------------------


def _request_parts(config: dict[str, Any], *, system: str, prompt: str,
                   max_tokens: int) -> tuple[str, dict[str, str], dict[str, Any]]:
    base = (config.get("base_url") or "").strip().rstrip("/")
    if not base:
        raise ValueError("This model has no base URL configured.")
    if not base.lower().startswith(("http://", "https://")):
        raise ValueError(f"Unsupported base URL: {base}")

    headers: dict[str, str] = {"Content-Type": "application/json"}
    key = config.get("api_key") or ""
    provider = config.get("provider") or ""
    headers.update(config.get("extra_headers") or {})

    if provider == "anthropic":
        url = f"{base}/messages"
        if key:
            headers["x-api-key"] = key
        headers.setdefault("anthropic-version", "2023-06-01")
        body: dict[str, Any] = {
            "model": config["wire_model"],
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            body["system"] = system
        return url, headers, body

    if key:
        headers["Authorization"] = f"Bearer {key}"
    if provider == "openai-responses":
        url = f"{base}/responses"
        body = {
            "model": config["wire_model"],
            "input": [
                *([{"role": "system", "content": system}] if system else []),
                {"role": "user", "content": prompt},
            ],
            "max_output_tokens": max_tokens,
        }
        return url, headers, body

    url = f"{base}/chat/completions"
    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    body = {
        "model": config["wire_model"],
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,
    }
    if config.get("reasoning_effort"):
        body["reasoning_effort"] = config["reasoning_effort"]
    return url, headers, body


def _response_text(data: Any, provider: str) -> str:
    if not isinstance(data, dict):
        return ""
    if provider == "anthropic":
        parts = data.get("content") or []
        return "".join(
            str(part.get("text", ""))
            for part in parts
            if isinstance(part, dict) and part.get("type") == "text"
        )
    if provider == "openai-responses":
        text = data.get("output_text")
        if isinstance(text, str) and text:
            return text
        parts: list[str] = []
        for item in data.get("output") or []:
            for content in (item.get("content") or []) if isinstance(item, dict) else []:
                if isinstance(content, dict) and isinstance(content.get("text"), str):
                    parts.append(content["text"])
        return "".join(parts)
    choices = data.get("choices") or []
    if choices and isinstance(choices[0], dict):
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                str(part.get("text", ""))
                for part in content
                if isinstance(part, dict)
            )
    return ""


async def complete_with_config(
    config: dict[str, Any],
    *,
    system: str,
    prompt: str,
    max_tokens: int = 64,
    cancelled: Any = None,
) -> str:
    """Send one bounded, non-streaming completion and return its text."""
    url, headers, body = _request_parts(
        config, system=system, prompt=prompt, max_tokens=max_tokens
    )
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        if cancelled and cancelled():
            raise ValueError("Test cancelled.")
        response = await client.post(url, headers=headers, json=body)
    if response.status_code >= 400:
        detail = response.text[:300].replace("\n", " ")
        raise ValueError(f"Provider returned HTTP {response.status_code}: {detail}")
    try:
        data = response.json()
    except Exception as exc:
        raise ValueError("Provider returned an invalid JSON response.") from exc
    return clean_thinking_tags(_response_text(data, config.get("provider") or ""))


def context_window_for(config: dict[str, Any]) -> dict[str, Any]:
    """Report a context window from draft metadata, vtx metadata, or a default."""
    window = _as_int(config.get("context_window"))
    detail = ""
    source = "catalog"
    if not window:
        try:
            from vtx.ai.context_length import context_length_manager

            limits = context_length_manager.get_limits(config["wire_model"])
            window = _as_int(getattr(limits, "context", 0))
        except Exception as exc:  # models.dev lookup is best-effort
            detail = f"metadata lookup failed: {exc}"
        if window:
            source = "metadata"
    if not window:
        # Match vtx's own last-resort UI default instead of an unrelated 8192.
        from vtx.core.config import config as vtx_config

        source = "default"
        window = int(vtx_config.agent.default_context_window)
        detail = detail or "No declared context window; using the vtx default."
    return {
        "context_window": window,
        "source": source,
        "detail": detail,
        "detected_at": time.time(),
    }


__all__ = [
    "ConfigTestRunner",
    "TestRun",
    "complete_with_config",
    "context_window_for",
    "get_config_test_runner",
    "resolve_draft_config",
]
