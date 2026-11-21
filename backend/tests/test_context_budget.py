"""The context-budget payload must keep the bar, its breakdown and free space
in agreement — all three are read from the same object by the composer chip."""

from __future__ import annotations

from types import SimpleNamespace

from app.agent import runtime as runtime_module
from app.agent.runtime import AgentRuntime


def _runtime(monkeypatch, window: int = 200_000) -> SimpleNamespace:
    monkeypatch.setattr(
        runtime_module.provider_config,
        "context_window_for",
        lambda profile, model: window,
    )
    return SimpleNamespace(
        agent=SimpleNamespace(_system_prompt="p" * 26_740),  # 6,685 tokens
        tools=[object()] * 12,  # 1,440 tokens
        model_provider="kilo",
        model="reflection/beam-free",
    )


def _session() -> dict:
    return {"messages": [{"content": "x" * 14_884}]}  # 3,721 tokens


def _usage(**kwargs) -> SimpleNamespace:
    fields = {"input_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
    fields.update(kwargs)
    return SimpleNamespace(**fields)


def test_cached_prompt_tokens_count_towards_used(monkeypatch) -> None:
    # A cached turn bills 374 fresh input tokens but the window holds another
    # 29,824 cached ones. Reporting only input_tokens used to show "374 / 200k
    # (0%)" while the segment rows already summed to ~12k.
    budget = AgentRuntime._context_budget(
        _runtime(monkeypatch),
        _session(),
        _usage(input_tokens=374, cache_read_tokens=29_824),
    )

    assert budget["used_tokens"] == 30_198
    assert budget["free_tokens"] == 200_000 - 30_198
    assert budget["counter"] == "provider_usage"


def test_segments_are_scaled_to_the_measured_total(monkeypatch) -> None:
    budget = AgentRuntime._context_budget(
        _runtime(monkeypatch),
        _session(),
        _usage(input_tokens=374, cache_read_tokens=29_824),
    )

    # The bar and the rows are drawn from segments; their sum must equal the
    # number in the header, and the relative split must survive the scaling.
    assert sum(seg["tokens"] for seg in budget["segments"]) == budget["used_tokens"]
    messages, system_prompt, system_tools = [
        seg["tokens"] for seg in budget["segments"]
    ]
    assert system_prompt > messages > system_tools


def test_heuristic_fallback_stays_consistent(monkeypatch) -> None:
    budget = AgentRuntime._context_budget(_runtime(monkeypatch), _session(), None)

    assert budget["counter"] == "heuristic"
    assert budget["used_tokens"] == 3_721 + 6_685 + 1_440
    assert sum(seg["tokens"] for seg in budget["segments"]) == budget["used_tokens"]
