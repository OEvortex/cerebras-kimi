"""Context budget must use vtx's limits and all reported token fields."""

from __future__ import annotations

from types import SimpleNamespace

from app.agent import runtime as runtime_module


def test_context_budget_uses_vtx_limits_and_all_usage_fields(monkeypatch):
    monkeypatch.setattr(
        runtime_module.provider_config,
        "vtx_model_metadata",
        lambda model_id: {
            "context_window": 128_000,
            "max_tokens": 16_384,
            "supports_reasoning": False,
            "supports_vision": True,
            "supports_tools": True,
            "supports_audio": False,
            "supported_reasoning_efforts": [],
        },
    )
    monkeypatch.setattr(
        runtime_module.provider_config, "context_window_for", lambda profile, model: 0
    )
    monkeypatch.setattr(runtime_module.provider_config, "get_selection", lambda settings: {
        "profile_id": "p", "model_id": "test-model"
    })

    usage = SimpleNamespace(
        input_tokens=1_000,
        output_tokens=400,
        cache_read_tokens=2_000,
        cache_write_tokens=100,
    )
    runtime = SimpleNamespace(agent=SimpleNamespace(_system_prompt=""), tools=[], model="test-model", model_provider="p")

    budget = runtime_module.AgentRuntime._context_budget(runtime, {"messages": []}, usage)

    assert budget["window"] == 128_000
    assert budget["window_estimated"] is False
    assert budget["used_tokens"] == 3_500  # 1000 + 400 + 2000 + 100
    assert budget["counter"] == "provider_usage"
