"""Quiz judging helpers for embedded quiz blocks (books/reading/notes).

Inspired by reff/deeptutor/agents/question/pipeline.py. The emitter contract
matches web/lib/quiz-types.ts: one `content` event per question with
`metadata.call_kind == "quiz_question_emitted"` and a `qa_pair`, followed by a
`result` event carrying `summary.results[].qa_pair`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

log = logging.getLogger("deeptutor.quiz")

TYPES = ("choice", "concept", "fill_in_blank", "short_answer", "written", "coding")
DIFFICULTIES = ("easy", "medium", "hard")
CHOICE_KEYS = ("A", "B", "C", "D")
BLANK = "____"

_AGENTS: dict[tuple[Any, ...], Any] = {}


def derive_topic(content: str) -> str:
    """Strip a leading quiz request so the title reads 'photosynthesis', not the prompt."""
    text = content.strip().rstrip("?.!")
    patterns = (
        r"^(?:please\s+)?(?:generate|create|make|give me|quiz me on|quiz me about|"
        r"make a quiz on|generate a quiz on)\s+(?:a\s+)?(?:quiz\s+)?(?:on|about|for)?\s*",
        r"^quiz\s+(?:on|about)\s+",
    )
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE).strip()
    return text or content.strip()


def build_templates(config: dict[str, Any], topic: str, content: str) -> list[dict[str, Any]]:
    """Plan one template per question (ids q_1…q_N), inspired by the reference."""
    try:
        count = max(1, min(int(config.get("num_questions") or 3), 20))
    except (TypeError, ValueError):
        count = 3
    requested_types = [
        str(t).strip().lower().replace(" ", "_")
        for t in (config.get("question_types") or [])
        if str(t).strip()
    ]
    allowed = [t for t in requested_types if t in TYPES] or ["choice"]
    counts = config.get("per_type_counts") or {}
    difficulty = str(config.get("difficulty") or "").strip().lower()
    if difficulty not in DIFFICULTIES:
        difficulty = "medium"

    templates: list[dict[str, Any]] = []
    for i in range(count):
        qtype = allowed[i % len(allowed)]
        if isinstance(counts, dict) and counts:
            options = [t for t in allowed if int(counts.get(t) or 0) > 0]
            if options:
                qtype = options[min(i, len(options) - 1)]
        templates.append({
            "question_id": f"q_{i + 1}",
            "topic": topic or content or "general knowledge",
            "question_type": qtype,
            "difficulty": difficulty,
        })
    return templates


def _extract_json(text: str) -> Any:
    """Pull the first JSON object/array out of an LLM reply."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    for opener, closer in (("[", "]"), ("{", "}")):
        start = cleaned.find(opener)
        if start < 0:
            continue
        depth = 0
        in_string = False
        for i in range(start, len(cleaned)):
            ch = cleaned[i]
            if ch == '"' and (i == 0 or cleaned[i - 1] != "\\"):
                in_string = not in_string
            if in_string:
                continue
            if ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(cleaned[start : i + 1])
                    except Exception:  # noqa: BLE001
                        break
    return None


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


def normalize_qa(payload: dict[str, Any], template: dict[str, Any]) -> dict[str, Any]:
    """Coerce an LLM payload into the exact qa_pair shape the UI expects."""
    qtype = template["question_type"]
    question = str(payload.get("question") or "").strip() or f"[Generation failed] {template['topic']}"
    correct = str(payload.get("correct_answer") or "").strip() or "N/A"
    explanation = str(payload.get("explanation") or "").strip() or "N/A"
    options: dict[str, str] | None = None
    if qtype == "choice":
        raw = payload.get("options")
        if isinstance(raw, dict):
            options = {
                str(k).strip().upper(): str(v).strip()
                for k, v in raw.items()
                if str(k).strip().upper() in CHOICE_KEYS and str(v).strip()
            }
            options = options or None
        key = correct.strip().upper()[:1]
        if key in CHOICE_KEYS and options and key in options:
            correct = key
        elif options:
            match = next((k for k, v in options.items() if v == correct), None)
            correct = match or "A"
        else:
            options = {"A": correct, "B": "Incorrect option", "C": "Incorrect option", "D": "Incorrect option"}
            correct = "A"
    elif qtype == "concept":
        options = None
        value = correct.lower()
        correct = "true" if value in ("true", "yes", "1", "correct", "对", "正确") else "false"
    else:
        options = None
    if qtype == "fill_in_blank" and BLANK not in question:
        question = f"{question} {BLANK}"
    return {
        "question_id": template["question_id"],
        "question": question,
        "question_type": qtype,
        "options": options,
        "correct_answer": correct,
        "explanation": explanation,
        "difficulty": template["difficulty"],
        "concentration": template["topic"],
    }


def fallback_qa(template: dict[str, Any]) -> dict[str, Any]:
    topic = template["topic"]
    qtype = template["question_type"]
    if qtype == "choice":
        return normalize_qa({
            "question": f"Which statement best describes {topic}?",
            "options": {
                "A": f"{topic} is a defined concept with specific properties.",
                "B": f"{topic} has no defining properties.",
                "C": f"{topic} is only an opinion.",
                "D": f"{topic} cannot be studied.",
            },
            "correct_answer": "A",
            "explanation": f"Option A is the accurate general description of {topic}.",
        }, template)
    if qtype == "concept":
        return normalize_qa({
            "question": f"True or false: {topic} can be defined and studied.",
            "correct_answer": "true",
            "explanation": f"{topic} is a definable, studyable topic.",
        }, template)
    if qtype == "fill_in_blank":
        return normalize_qa({
            "question": f"The key idea behind {topic} is ____.",
            "correct_answer": f"the defining properties of {topic}",
            "explanation": f"This captures the core of {topic}.",
        }, template)
    return normalize_qa({
        "question": f"Explain {topic} in your own words.",
        "correct_answer": f"A clear explanation of {topic}",
        "explanation": f"The answer should cover the defining features of {topic}.",
    }, template)


async def generate_qa(template: dict[str, Any], cancel_event: Any = None) -> dict[str, Any]:
    qtype = template["question_type"]
    prompt = (
        "Generate ONE quiz question. Reply with ONLY a JSON object, no prose.\n"
        "Keys: question, options (only for choice; keys A-D), correct_answer, explanation.\n"
        f"Type: {qtype}\nTopic: {template['topic']}\nDifficulty: {template['difficulty']}\n"
        "Rules: choice -> 4 options A-D and correct_answer is one key; "
        "concept -> no options, correct_answer 'true' or 'false'; "
        "fill_in_blank -> exactly one ____ in the question; "
        "short_answer/written/coding -> no options, reference answer in correct_answer.\n"
    )
    try:
        text = await _llm_text(prompt, cancel_event)
        data = _extract_json(text)
        if isinstance(data, list) and data:
            data = data[0]
        if not isinstance(data, dict):
            raise ValueError("no JSON object in reply")
        return normalize_qa(data, template)
    except Exception as exc:  # noqa: BLE001
        log.warning("quiz generation failed (%s); using template fallback", exc)
        return fallback_qa(template)


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


def question_markdown(qa: dict[str, Any], index: int) -> str:
    lines = [f"### Question {index + 1}", qa["question"], ""]
    if qa.get("options"):
        lines += [f"{key}. {value}" for key, value in qa["options"].items()]
        lines.append("")
    lines += [f"**Answer:** {qa['correct_answer']}", f"**Explanation:** {qa['explanation']}"]
    return "\n".join(lines)


def build_result_payload(qa_pairs: list[dict[str, Any]], templates: list[dict[str, Any]],
                         preface: str) -> dict[str, Any]:
    return {
        "response": preface or "Here is your quiz.",
        "summary": {
            "success": True,
            "source": "topic",
            "requested": len(templates),
            "template_count": len(templates),
            "completed": len(qa_pairs),
            "failed": len(templates) - len(qa_pairs),
            "templates": templates,
            "results": [{"qa_pair": qa} for qa in qa_pairs],
            "analysis": "Generated from the learner's topic and selected question types.",
        },
        "mode": "custom",
    }
