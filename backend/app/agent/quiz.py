"""Quiz judging helpers for embedded quiz blocks (books/reading/notes).

The emitter contract matches web/lib/quiz-types.ts: the frontend posts the
learner's answer plus the question metadata, and ``judge_answer`` returns the
grader's feedback text.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

_AGENTS: dict[tuple[Any, ...], Any] = {}


async def _llm_text(prompt: str, cancel_event: Any = None) -> str:
    """One completion through DeepTutor's selected model, cached per process."""
    from vtx.agent.runtime import ConversationRuntime
    from vtx.core.events import TextDeltaEvent

    from .. import provider_config
    from ..config import get_settings

    resolved = provider_config.resolve_runtime_model(get_settings())
    provider = str(resolved["provider"] or "")
    model = str(resolved["model"] or "")
    if not model:
        raise RuntimeError("no model configured — pick one in Settings → LLM")
    key = (
        resolved["profile_id"], resolved["model_id"],
        provider, model, resolved["base_url"], resolved["api_key"],
    )
    pair = _AGENTS.get(key)
    if pair is None:
        runtime = ConversationRuntime(
            cwd=str(get_settings().workspace_dir),
            model=model,
            model_provider=provider,
            api_key=resolved["api_key"],
            base_url=resolved["base_url"],
            thinking_level=resolved["thinking_level"],
            tools=[],
        )
        from .runtime import _suppress_vtx_selection_writes

        with _suppress_vtx_selection_writes():
            await asyncio.to_thread(runtime.initialize)
        agent = await asyncio.to_thread(runtime.prepare_for_run)
        pair = (runtime, agent)
        _AGENTS[key] = pair
    _, agent = pair
    if agent is None:
        raise RuntimeError("Quiz agent is not available for this provider/model.")
    text = ""
    async for event in agent.run(prompt, cancel_event=cancel_event):
        if isinstance(event, TextDeltaEvent) and event.delta:
            text += event.delta
    return text


async def judge_answer(message: dict[str, Any], cancel_event: Any = None) -> str:
    """Grade a learner's answer with the configured model (AI Judge button)."""
    question = str(message.get("question") or "")
    question_type = str(message.get("question_type") or "")
    options = message.get("options") or {}
    correct = str(message.get("correct_answer") or "")
    explanation = str(message.get("explanation") or "")
    answer = str(message.get("user_answer") or "")
    prompt = (
        "You are grading a learner's quiz answer. Start with ✅ Correct, "
        "⚠️ Partially correct, or ❌ Incorrect, then give short itemized feedback.\n\n"
        f"Question type: {question_type}\nQuestion: {question}\n"
        + (f"Options: {json.dumps(options, ensure_ascii=False)}\n" if options else "")
        + f"Reference answer: {correct}\nReference explanation: {explanation}\n"
        f"Learner's answer: {answer}\n"
    )
    return (await _llm_text(prompt, cancel_event)).strip()
