"""Video lesson orchestration: write a Remotion scene, validate it, narrate it,
and publish a self-contained player page under /files.

The main agent only supplies the learner's request. A dedicated writer sub-agent
produces one JSON metadata block and one Lesson.tsx; this module compiles it with
the pinned Remotion toolchain, checks sample frames (and an optional browser
layout probe), and emits the page the chat's VideoLessonViewer plays.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import uuid
from typing import Any

from ...config import get_settings
from .lesson_writer import LessonDraft, load_instructions, parse_draft
from .narration import Clip, narrate, voice_module
from .runtime import build_lesson, ensure_runtime, prepare_workdir, write_page

MAX_ATTEMPTS = 4


def _slug_for(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "video").lower()).strip("-") or "video"
    return f"{s}-{uuid.uuid4().hex[:6]}"


def _files_root() -> Path:
    return get_settings().files_dir.resolve()


def _workspace_root() -> Path:
    root = Path(os.environ.get("DT_WORKSPACE_DIR", "./data/workspace")).resolve()
    return root / "videos"


def _publish(slug: str, page: Path, draft: LessonDraft, bundle: Path) -> str:
    """Copy the page to /files and keep an editable source copy in the workspace."""
    served = _files_root() / "videos" / slug
    served.mkdir(parents=True, exist_ok=True)
    shutil.copy2(page, served / "lesson.html")

    proj = _workspace_root() / slug
    src = proj / "src"
    src.mkdir(parents=True, exist_ok=True)
    shutil.copy2(page, src / "lesson.html")
    shutil.copy2(bundle, src / "player.js")
    (src / "Lesson.tsx").write_text(draft.code, encoding="utf-8")
    (src / "meta.json").write_text(
        json.dumps({"title": draft.title, "summary": draft.summary,
                    "narration": [{"id": n.id, "text": n.text} for n in draft.narration]},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if draft.title:
        (proj / "title.txt").write_text(draft.title, encoding="utf-8")
    return f"videos/{slug}/lesson.html"


async def _layout_feedback(page: Path, frames: list[dict]) -> str | None:
    """Advisory browser collision check; never fails the lesson on its own."""
    try:
        from .layout_check import check_layout, sample_frames

        total = max((int(f.get("frame") or 0) for f in frames), default=0) + 1
        issues = await asyncio.to_thread(check_layout, page, sample_frames(total))
    except Exception:  # noqa: BLE001 - the probe is optional
        return None
    if not issues:
        return None
    return "Layout problems in the 1920x1080 frame:\n" + "\n".join(str(i) for i in issues[:14])


async def create_lesson(query: str, title: str = "") -> dict[str, Any]:
    """Build a video lesson and return the metadata the frontend player needs.

    Raises ``RuntimeError`` with a user-facing ``Video ...`` prefix on failure.
    """
    from vtx.agent.dispatcher import get_context
    from vtx.agent.tools.task import SubagentSpec, resolve_subagent_runner

    ctx = get_context()
    if ctx is None:
        raise RuntimeError("Video sub-agent failed: dispatcher context not initialized.")

    instructions = load_instructions()
    spec = SubagentSpec(
        name="video-lesson-writer",
        description="Writes a Remotion lesson scene for the learner's question",
        instructions=instructions,
        instructions_mode="replace",
        tools_allow=["__none__"],
        tools_deny=[],
        max_turns=4,
    )
    label = (title or query or "Video lesson").strip()[:48]
    slug = _slug_for(title or query)
    work = _workspace_root() / slug
    source_dir = work / "source"
    artifacts_dir = work / "artifacts"
    source_dir.mkdir(parents=True, exist_ok=True)
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    # Start the npm install while the first LLM call is in flight.
    runtime_ready = asyncio.create_task(ensure_runtime())
    voice_cache: dict[str, Clip] = {}
    attempts = 0
    feedback = ""
    good: tuple[LessonDraft, Path, Path, list[dict]] | None = None
    base_prompt = (
        "Write a Remotion video lesson (one ```json block and one complete "
        "```tsx Lesson.tsx block) for this learner request:\n\n" + query.strip()
    )
    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            attempts = attempt
            prompt = base_prompt
            if feedback:
                prompt += "\n\nThe host's check failed:\n" + feedback[:6000]
                prompt += "\nFix exactly these issues and output both complete code blocks again."
            try:
                result = await resolve_subagent_runner()(
                    parent_ctx=ctx,
                    spec=spec,
                    prompt=prompt,
                    cancel_event=None,
                    model_override=None,
                    progress_callback=ctx.progress_callback,
                    tool_call_id=f"video_lesson_{uuid.uuid4().hex[:12]}",
                    label=label,
                )
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"Video sub-agent failed: {exc}") from exc
            if result.error and not result.final_text:
                raise RuntimeError(f"Video sub-agent failed: {result.error}")

            try:
                draft = parse_draft(result.final_text or "")
            except ValueError as exc:
                feedback = f"Writer output rejected: {exc}"
                continue
            if not draft.title:
                draft.title = title or label

            clips = await narrate(draft.narration, voice_cache)
            prepare_workdir(source_dir, draft.code, voice_module(clips))
            bundle = source_dir / "player.js"
            build = await build_lesson(source_dir / "Lesson.tsx", bundle)
            if not build.ok:
                detail = "; ".join(build.errors) or build.stage or "unknown compile error"
                feedback = f"Remotion {build.stage} failed: {detail[:3000]}"
                continue

            page = artifacts_dir / "lesson.html"
            write_page(bundle, page, title=draft.title)
            good = (draft, bundle, page, build.frames)

            layout = await _layout_feedback(page, build.frames)
            if layout and attempt < MAX_ATTEMPTS:
                feedback = layout
                continue
            if layout:  # last attempt: accept the compiling lesson with the warning
                draft.summary = (draft.summary + " " + layout[:400]).strip()
            break
    finally:
        runtime_ready.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await runtime_ready

    if good is None:
        raise RuntimeError(
            f"Video render failed: the writer could not produce a valid lesson "
            f"after {attempts} attempts. {feedback[:600]}"
        )

    draft, bundle, page, frames = good
    rel = _publish(slug, page, draft, bundle)
    total_frames = max((int(f.get("frame") or 0) for f in frames), default=0) + 1
    seconds = round(total_frames / 30)
    return {
        "rel": rel,
        "title": draft.title,
        "summary": draft.summary or f"Video lesson ready: {draft.title}",
        "code": draft.code,
        "duration_seconds": seconds,
        "attempts": attempts,
    }
