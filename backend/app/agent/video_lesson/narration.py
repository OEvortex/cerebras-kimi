"""Voice-over for video lessons: time each scene's captions, and speak them when
a local TTS engine is available.

``edge-tts`` (the free read-aloud voices behind Microsoft Edge) is optional. When
it is missing or the service fails, a scene keeps its captions, timed from an
estimated speaking rate, and plays silently. The Remotion kit consumes the
result as a generated ``voice.ts`` module.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import importlib.util
import json
import logging
import math
import re

logger = logging.getLogger(__name__)

FPS = 30
VOICE = "en-US-AvaNeural"
SPEAK_TIMEOUT_S = 60
_CHARS_PER_SECOND = 15.0  # English speech runs about 2.5 words per second
_MP3_BYTES_PER_SECOND = 48_000 / 8  # edge-tts streams 24 kHz, 48 kbit/s mono mp3
_TICKS_PER_SECOND = 10_000_000  # edge-tts boundary offsets are in 100 ns units
_PARALLEL = 4
_SENTENCE_END = re.compile(r"(?<=[.;!?])\s+|(?<=[!?])")


@dataclass
class NarrationLine:
    id: str
    text: str


@dataclass
class Clip:
    text: str
    frames: int
    captions: list[tuple[int, str]]
    audio: bytes | None = None


def estimate(text: str) -> Clip:
    """Silent clip: captions spaced by an average speaking rate."""
    rate = _CHARS_PER_SECOND
    at, captions = 0.0, []
    for sentence in (s.strip() for s in _SENTENCE_END.split(text)):
        if sentence:
            captions.append((round(at * FPS), sentence))
            at += len(sentence) / rate
    return Clip(text, max(1, math.ceil(at * FPS)), captions or [(0, text)])


async def speak(text: str, voice: str) -> Clip:
    # Optional dependency, loaded lazily so lessons still work without it.
    edge_tts = importlib.import_module("edge_tts")

    audio = bytearray()
    captions: list[tuple[int, str]] = []
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
        elif chunk["type"] == "SentenceBoundary":
            captions.append((round(chunk["offset"] / _TICKS_PER_SECOND * FPS), chunk["text"]))
    if not audio:
        raise RuntimeError("edge-tts returned no audio")
    frames = math.ceil(len(audio) / _MP3_BYTES_PER_SECOND * FPS)
    return Clip(text, frames, captions or [(0, text)], bytes(audio))


async def narrate(
    lines: list[NarrationLine], cache: dict[str, Clip] | None = None
) -> dict[str, Clip]:
    """Time every line; ``cache`` keeps clips across retries of the same lesson."""
    cache = {} if cache is None else cache
    voiced = importlib.util.find_spec("edge_tts") is not None
    gate = asyncio.Semaphore(_PARALLEL)

    async def one(text: str) -> Clip:
        if text not in cache:
            clip = None
            if voiced:
                async with gate:
                    try:
                        clip = await asyncio.wait_for(speak(text, VOICE), SPEAK_TIMEOUT_S)
                    except Exception as exc:  # best effort; captions remain
                        logger.warning("video lesson narration failed: %s", exc)
            cache[text] = clip or estimate(text)
        return cache[text]

    clips = await asyncio.gather(*(one(line.text) for line in lines))
    return {line.id: clip for line, clip in zip(lines, clips)}


def voice_module(clips: dict[str, Clip]) -> str:
    """The ``voice.ts`` the kit imports: text, length, captions and inline audio per scene."""
    data = {}
    for key, clip in clips.items():
        entry: dict = {
            "text": clip.text,
            "frames": clip.frames,
            "captions": [{"at": at, "text": text} for at, text in clip.captions],
        }
        if clip.audio:
            entry["src"] = "data:audio/mpeg;base64," + base64.b64encode(clip.audio).decode()
        data[key] = entry
    return "export const VOICE = " + json.dumps(data, ensure_ascii=False) + ";\n"


__all__ = [
    "Clip",
    "NarrationLine",
    "VOICE",
    "estimate",
    "narrate",
    "speak",
    "voice_module",
]
