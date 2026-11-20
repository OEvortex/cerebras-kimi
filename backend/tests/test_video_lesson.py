"""Tests for the Remotion video-lesson pipeline (no Node toolchain needed)."""

from __future__ import annotations

import json

import pytest

from app.agent.video_lesson.capability import _slug_for
from app.agent.video_lesson.lesson_writer import load_instructions, parse_draft
from app.agent.video_lesson.narration import estimate, voice_module
from app.agent.video_lesson.runtime import (
    ASSETS_DIR,
    KIT_FILES,
    prepare_workdir,
    runtime_dir,
    write_page,
)


def _reply(tsx: str = "export const Lesson = () => null;") -> str:
    return (
        "```json\n"
        + json.dumps({
            "title": "Photosynthesis",
            "summary": "How plants make sugar from light.",
            "narration": [{"id": "s1", "text": "Plants use light to make sugar."}],
        })
        + "\n```\n```tsx\n" + tsx + "\n```"
    )


def test_slug_is_safe_and_unique() -> None:
    first = _slug_for("Hello, World!")
    second = _slug_for("Hello, World!")
    assert first.startswith("hello-world-")
    assert first != second
    assert "/" not in first


def test_parse_draft_reads_json_and_longest_tsx() -> None:
    short = "export const Lesson = () => null;"
    full = "export const LESSON = {fps: 30};\nexport const Lesson = () => <div />;"
    draft = parse_draft(_reply(short) + "\n```tsx\n" + full + "\n```")
    assert draft.title == "Photosynthesis"
    assert draft.summary == "How plants make sugar from light."
    assert draft.code == full
    assert [n.id for n in draft.narration] == ["s1"]


@pytest.mark.parametrize("reply", [
    "no code blocks at all",
    "```tsx\nexport const Lesson = () => null;\n```",
    "```json\n{\"title\": \"x\"}\n```\n```tsx\nexport const Lesson = () => null;\n```",
])
def test_parse_draft_rejects_incomplete_replies(reply: str) -> None:
    with pytest.raises(ValueError):
        parse_draft(reply)


def test_instructions_splice_the_kit_source() -> None:
    instructions = load_instructions()
    assert "{kit_source}" not in instructions
    assert "W = 1920" in instructions
    assert instructions.startswith("You are DeepTutor's video lesson author")


def test_runtime_dir_honours_override(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("DEEPTUTOR_REMOTION_RUNTIME", str(tmp_path))
    assert runtime_dir() == tmp_path.resolve()


def test_prepare_workdir_writes_kit_lesson_and_voice(tmp_path) -> None:
    lesson = prepare_workdir(tmp_path, "export const Lesson = () => null;", "export const VOICE = {};")
    assert lesson.name == "Lesson.tsx"
    for name in ("kit.tsx",):
        assert (tmp_path / name).read_bytes() == (ASSETS_DIR / name).read_bytes()
    assert (tmp_path / "voice.ts").read_text(encoding="utf-8") == "export const VOICE = {};"


def test_write_page_escapes_script_and_title(tmp_path) -> None:
    bundle = tmp_path / "player.js"
    bundle.write_text("const s = '</script><script>bad()</script>';", encoding="utf-8")
    page = write_page(bundle, tmp_path / "page.html", title="A < B & C")
    html = page.read_text(encoding="utf-8")
    assert '<html lang="en">' in html
    assert "A &lt; B &amp; C" in html
    assert "</script><script>bad()" not in html
    assert "<\\/script>" in html


def test_narration_estimate_and_voice_module() -> None:
    clip = estimate("First sentence. Second sentence.")
    assert clip.frames > 0
    assert len(clip.captions) == 2
    assert clip.captions[0][0] == 0
    source = voice_module({"s1": clip})
    assert source.startswith("export const VOICE = ")
    data = json.loads(source.split("=", 1)[1].strip().rstrip(";"))
    assert data["s1"]["text"] == clip.text
    assert len(data["s1"]["captions"]) == 2
