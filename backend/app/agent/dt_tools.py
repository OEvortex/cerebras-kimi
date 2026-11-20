"""Ports of DeepTutor's built-in tools (``reff/deeptutor/tools``) onto vtx ``@tool``.

The notebook companion (Dito) lives in ``dito.py``; its tools are re-exported
at the bottom of this module.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, cast

import httpx
from .toolkit import tool


_HEADERS = {"User-Agent": "DeepTutor/0.1 (+https://deeptutor.info)"}


@tool(mutating=True, tool_icon="📝")
def notes(action: str, title: str = "", content: str = "", tags: str = "",
          query: str = "") -> str:
    """The user's notebook — one tool for write, list, and search.

    Notes are Co-Writer notebook pages, so anything saved here is visible in
    the Notebook tab.

    Actions:
    - ``write``: save a notebook page (``title``, ``content``, optional
      comma-separated ``tags``).
    - ``list``: list all notes (id | title | tags).
    - ``search``: full-text search across notes (``query``).

    :param action: write|list|search.
    :param title: Note title (write).
    :param content: Markdown body (write).
    :param tags: Comma-separated tags (write).
    :param query: Search terms (search).
    """
    from ..services.documents import notes as note_store

    action = (action or "list").lower()

    if action == "write":
        if not title:
            return "notes write needs a title."
        note_id = note_store.write_note(title, content, tags)
        return f"Saved note '{title}' to your notebook as {note_id}"

    if action == "search":
        return note_store.search_notes(query)

    return note_store.list_notes()


# ---------------------------------------------------------------------------
# Notebook companion (Dito) — prompts and tools live in ``dito.py`` and are
# registered only while a Co-Writer page is bound. Re-exported here so the
# existing tool registry and tests can keep importing them from dt_tools.
# ---------------------------------------------------------------------------

from .dito import (  # noqa: E402,F401
    flashcards,
    note_create,
    note_list,
    note_open,
    note_read,
    note_search,
    note_suggest,
    session_search,
)


@tool(mutating=True, tool_icon="❓")
def question_bank(action: str, question: str = "", answer: str = "", topic: str = "") -> str:
    """Manage a personal Q&A bank (add | list | search).

    :param action: "add", "list", or "search".
    :param question: The question text.
    :param answer: The answer (for add).
    :param topic: Optional topic tag.
    """
    from ..config import get_settings
    from ..store import database

    settings = get_settings()
    bank = database.get_state(settings, "question_bank", []) or []
    action = (action or "").strip().lower()
    if action == "add":
        if not question.strip():
            return "question is required for add."
        bank.append({"q": question, "a": answer, "topic": topic,
                     "created": time.time()})
        database.put_state(settings, "question_bank", bank)
        return f"Saved question to bank ({len(bank)} total)."
    if action == "list":
        return "\n".join(f"- {e['q']}" + (f" [{e.get('topic','')}]" if e.get("topic") else "")
                         for e in bank[-50:]) or "Question bank is empty."
    if action == "search":
        q = question.strip().lower() or topic.strip().lower()
        hits = [e for e in bank if q in (e["q"] + " " + e.get("a", "")).lower()]
        return "\n\n".join(f"Q: {e['q']}\nA: {e.get('a','')}" for e in hits[:10]) or "No matches."
    return 'action must be "add", "list", or "search".'


# ---------------------------------------------------------------------------
# memory — tiny persistent memory (read_memory / write_memory)
# ---------------------------------------------------------------------------


@tool(mutating=True, tool_icon="🧠")
def memory(action: str, query: str = "", fact: str = "",
           category: str = "general") -> str:
    """Long-term memory about the learner — one tool for read + write.

    Actions:
    - ``read``: return stored memories (``query`` filters by substring).
    - ``write``: store a durable fact (``fact`` one sentence, ``category``
      optional e.g. preference|goal|background).

    :param action: read|write.
    :param query: Substring filter for read.
    :param fact: Fact to store for write.
    :param category: Category for write.
    """
    from ..config import get_settings
    from ..store import database

    settings = get_settings()
    memories = database.get_state(settings, "memory", []) or []
    action = (action or "read").lower()
    if action == "write":
        if not fact:
            return "memory write needs a fact."
        memories.append({"fact": fact, "category": category, "created": time.time()})
        database.put_state(settings, "memory", memories)
        return f"Remembered: {fact}"
    # read
    if not memories:
        return "No memories stored yet."
    q = query.strip().lower()
    if q:
        memories = [m for m in memories if q in json.dumps(m, ensure_ascii=False).lower()]
    return json.dumps(memories[-50:], ensure_ascii=False, indent=1) or "[]"


# ---------------------------------------------------------------------------
# learning — single tool covering the whole learning-state surface
# (upstream learning_status + learning_update + journal merged)
# ---------------------------------------------------------------------------


@tool(mutating=True, tool_icon="📚")
def learning(action: str, topic: str = "", note: str = "", status: str = "",
             minutes: int = 0) -> str:
    """Track the learner's progress across topics — one tool for all learning state.

    Actions:
    - ``status``: show overall progress and per-topic state.
    - ``update``: record progress on ``topic`` (status: learned|learning|weak,
      optional ``note`` and ``minutes`` spent).
    - ``journal``: append a free-form ``note`` to the learning journal.
    - ``weak``: list topics marked weak for review.

    :param action: One of status|update|journal|weak.
    :param topic: Topic name (for update).
    :param note: Free-text note (for update/journal).
    :param status: learned|learning|weak (for update).
    :param minutes: Minutes spent (for update).
    """
    from ..config import get_settings
    from ..store import database

    settings = get_settings()
    data = database.get_state(settings, "learning", {"topics": {}, "journal": []})
    if not isinstance(data, dict):
        data = {"topics": {}, "journal": []}
    topics = cast(dict[str, Any], data.setdefault("topics", {}))
    journal = cast(list[dict[str, Any]], data.setdefault("journal", []))

    action = (action or "status").lower()
    if action == "update":
        if not topic:
            return "learning update needs a topic."
        t = topics.setdefault(topic, {"status": "learning", "notes": [], "minutes": 0})
        if status:
            t["status"] = status
        if note:
            t["notes"].append({"at": time.time(), "note": note})
        t["minutes"] = int(t.get("minutes", 0)) + max(0, minutes)
        t["updated_at"] = time.time()
        database.put_state(settings, "learning", data)
        return f"Recorded: {topic} → {t['status']}"
    if action == "journal":
        if not note:
            return "journal needs a note."
        journal.append({"at": time.time(), "note": note})
        database.put_state(settings, "learning", data)
        return "Journal entry saved."
    if action == "weak":
        weak = {k: v for k, v in topics.items() if v.get("status") == "weak"}
        if not weak:
            return "No weak topics recorded."
        return "Weak topics:\n" + "\n".join(
            f"- {k} ({v.get('minutes', 0)}min)" for k, v in weak.items())
    # status
    if not topics:
        return "No learning progress recorded yet."
    lines = ["Learning status:"]
    for k, v in sorted(topics.items()):
        lines.append(f"- {k}: {v.get('status','?')} ({v.get('minutes',0)}min)")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# workspace — single tool that controls the whole workspace
# (upstream workspace_read/list/present/export merged)
# ---------------------------------------------------------------------------


@tool(mutating=True, tool_icon="🗂️")
def workspace(action: str, path: str = "", content: str = "",
              query: str = "", max_chars: int = 12000) -> str:
    """Full control over the workspace directory — one tool for all file ops.

    Actions:
    - ``list``: list files under ``path`` (default root, non-recursive unless
      path ends with '/').
    - ``read``: read a UTF-8 file at ``path``.
    - ``write``: write ``content`` to ``path`` (creates parents).
    - ``search``: substring-search file contents for ``query`` under ``path``.
    - ``delete``: delete file at ``path``.
    - ``mkdir``: create directory ``path``.
    - ``info``: file size/mtime for ``path``.

    Paths are workspace-relative; ``..`` escapes are rejected.

    :param action: list|read|write|search|delete|mkdir|info.
    :param path: Workspace-relative path.
    :param content: File content for write.
    :param query: Search substring for search.
    :param max_chars: Read truncation limit.
    """
    root = Path(os.environ.get("DT_WORKSPACE_DIR", "./data/workspace")).resolve()
    root.mkdir(parents=True, exist_ok=True)

    def _resolve(p: str) -> Path:
        cand = (root / (p or ".").lstrip("/")).resolve()
        if cand != root and root not in cand.parents:
            raise ValueError(f"path escapes workspace: {p}")
        return cand

    action = (action or "list").lower()
    try:
        if action == "list":
            base = _resolve(path or ".")
            if not base.is_dir():
                return f"Not a directory: {path}"
            entries = sorted(base.iterdir(), key=lambda e: (e.is_file(), e.name))
            lines = []
            for e in entries[:200]:
                rel = e.relative_to(root)
                lines.append(f"{'📁' if e.is_dir() else '📄'} {rel}")
            return "\n".join(lines) or "(empty)"
        if action == "read":
            f = _resolve(path)
            if not f.is_file():
                return f"Not a file: {path}"
            return f.read_text(encoding="utf-8", errors="replace")[:max_chars]
        if action == "write":
            f = _resolve(path)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(content, encoding="utf-8")
            return f"Wrote {len(content)} chars to {path}"
        if action == "search":
            base = _resolve(path or ".")
            hits = []
            for f in base.rglob("*") if base.is_dir() else [base]:
                if not f.is_file() or f.stat().st_size > 2_000_000:
                    continue
                try:
                    text = f.read_text(encoding="utf-8", errors="replace")
                except Exception:  # noqa: BLE001
                    continue
                if query.lower() in text.lower():
                    hits.append(str(f.relative_to(root)))
                    if len(hits) >= 20:
                        break
            return "\n".join(hits) or "No matches."
        if action == "delete":
            f = _resolve(path)
            if f.is_file():
                f.unlink()
                return f"Deleted {path}"
            if f.is_dir():
                import shutil
                shutil.rmtree(f)
                return f"Deleted dir {path}"
            return f"Not found: {path}"
        if action == "mkdir":
            _resolve(path).mkdir(parents=True, exist_ok=True)
            return f"Created {path}"
        if action == "info":
            f = _resolve(path)
            if not f.exists():
                return f"Not found: {path}"
            st = f.stat()
            return f"{path}: {'dir' if f.is_dir() else 'file'}, {st.st_size} bytes, mtime {time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))}"
        return f"Unknown workspace action: {action}"
    except Exception as exc:  # noqa: BLE001
        return f"workspace {action} error: {exc}"


# ---------------------------------------------------------------------------
# mastery — single tool covering the whole Guided Learning surface
# (upstream mastery_* family merged)
# ---------------------------------------------------------------------------


@tool(mutating=True, tool_icon="🎯")
def mastery(action: str, topic: str = "", question: str = "",
            answer: str = "", score: int = -1, note: str = "") -> str:
    """Guided Learning mastery — one tool for the whole mastery loop.

    Actions:
    - ``topics``: list topics and their mastery state.
    - ``start``: begin a mastery session on ``topic``.
    - ``status``: current session state.
    - ``quiz``: get the next review question for ``topic``.
    - ``grade``: record learner's ``answer`` to ``question`` with ``score``
      (0-100, -1 = ungraded); updates mastery level.
    - ``note``: attach a free-form ``note`` to ``topic``.
    - ``leave``: end the current session.

    :param action: topics|start|status|quiz|grade|note|leave.
    :param topic: Topic name.
    :param question: Question being answered (grade).
    :param answer: Learner's answer (grade).
    :param score: 0-100 correctness (grade).
    :param note: Free-text note.
    """
    from ..config import get_settings
    from ..store import database

    settings = get_settings()
    data = database.get_state(settings, "mastery", {"topics": {}, "session": None})
    if not isinstance(data, dict):
        data = {"topics": {}, "session": None}
    topics = cast(dict[str, Any], data.setdefault("topics", {}))
    session = data.get("session")

    action = (action or "status").lower()
    if action == "topics":
        if not topics:
            return "No mastery topics yet. Use mastery(action='start', topic='...')."
        return "Mastery topics:\n" + "\n".join(
            f"- {k}: level {v.get('level', 0)}/5, {v.get('reviews', 0)} reviews"
            for k, v in topics.items())
    if action == "start":
        if not topic:
            return "mastery start needs a topic."
        topics.setdefault(topic, {"level": 0, "reviews": 0, "notes": []})
        data["session"] = {"topic": topic, "started_at": time.time(), "turn": 0}
        database.put_state(settings, "mastery", data)
        return f"Started mastery session on {topic}. Ask a diagnostic question."
    if action == "status":
        return f"Session: {session} " if session else "No active session. " + \
            f"Topics: {len(topics)}"
    if action == "quiz":
        t = session and topics.get(session.get("topic"))
        if not t:
            return "No active session — mastery(action='start', topic='...') first."
        lvl = t.get("level", 0)
        prompts = [
            f"Explain {session['topic']} from scratch.",
            f"Give a non-trivial example of {session['topic']}.",
            f"What are the edge cases of {session['topic']}?",
            f"Compare {session['topic']} with a related concept.",
            f"Teach {session['topic']} to a beginner in 3 steps.",
        ]
        q = prompts[min(lvl, len(prompts) - 1)]
        return f"QUIZ: {q}\n(INSTRUCTION: ask the learner, then call mastery(action='grade').)"
    if action == "grade":
        if not session or not question:
            return "mastery grade needs an active session and question."
        t = topics.setdefault(session["topic"], {"level": 0, "reviews": 0, "notes": []})
        t["reviews"] = int(t.get("reviews", 0)) + 1
        if score >= 0:
            # level 0-5: correct answers raise, wrong lower (min 0)
            delta = 1 if score >= 70 else (-1 if score < 40 else 0)
            t["level"] = max(0, min(5, int(t.get("level", 0)) + delta))
        if note:
            t.setdefault("notes", []).append({"at": time.time(), "note": note})
        t["updated_at"] = time.time()
        database.put_state(settings, "mastery", data)
        return (f"Recorded: level {t['level']}/5 after {t['reviews']} reviews "
                f"on {session['topic']}.")
    if action == "note":
        tname = topic or (session or {}).get("topic")
        t = topics.setdefault(tname or "general", {"level": 0, "reviews": 0, "notes": []})
        t.setdefault("notes", []).append({"at": time.time(), "note": note})
        database.put_state(settings, "mastery", data)
        return "Note saved."
    if action == "leave":
        data["session"] = None
        database.put_state(settings, "mastery", data)
        return "Mastery session ended."
    return f"Unknown mastery action: {action}"


# ---------------------------------------------------------------------------
# video — natural-language query -> Remotion lesson -> self-contained HTML page
# played live in the browser. The writer sub-agent produces a Lesson.tsx against
# the shipped kit; the runtime compiles and frame-checks it, then publishes a
# player page under /files for the chat's VideoLessonViewer.
# ---------------------------------------------------------------------------

_VIDEO_LESSON_MARKER = "VIDEO_LESSON_RESULT:"


@tool(mutating=True, tool_icon="🎬")
async def video(query: str, title: str = "") -> str:
    """Turn a natural-language request into an animated video lesson.

    A dedicated writer sub-agent writes a Remotion (React) scene; the backend
    compiles it, checks sample frames and narration timing, and publishes a
    self-contained player page under /files.

    :param query: The learner's request in plain language, e.g. "explain how
      photosynthesis works in a one-minute animation".
    :param title: Optional short title (used for the lesson card and file slug).
    """
    from .video_lesson import create_lesson

    try:
        lesson = await create_lesson(query, title)
    except RuntimeError as exc:
        # Runtime errors already carry a user-facing "Video ... failed:" prefix.
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Video render failed: {exc}"
    return _VIDEO_LESSON_MARKER + json.dumps(lesson, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------------------
# web — vtx WebTool port: Exa MCP search + Jina Reader fetch, single tool
# ---------------------------------------------------------------------------

_EXA_MCP_URL = "https://mcp.exa.ai/mcp"
_JINA_PREFIX = "https://r.jina.ai/"
_WEB_TIMEOUT = 25.0
_MAX_FETCH_CHARS = 30000

_JINA_HEADER_RE = re.compile(
    r"^(Title|URL Source|Published Time|Warning|Markdown Content):.*\n?",
    re.MULTILINE,
)


def _strip_jina_header(text: str) -> str:
    marker = text.find("Markdown Content:")
    if marker != -1:
        return text[marker + len("Markdown Content:"):].strip()
    return _JINA_HEADER_RE.sub("", text).strip()


async def _exa_search(query: str, num_results: int = 8) -> tuple[str | None, str | None]:
    """POST a JSON-RPC tools/call to the Exa MCP endpoint (no API key)."""
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "web_search_exa",
            "arguments": {
                "query": query,
                "type": "auto",
                "numResults": num_results,
                "livecrawl": "fallback",
            },
        },
    }
    try:
        async with httpx.AsyncClient(timeout=_WEB_TIMEOUT) as client:
            resp = await client.post(_EXA_MCP_URL, headers=headers, json=payload)
            resp.raise_for_status()
    except httpx.TimeoutException:
        return None, f"Exa timed out after {_WEB_TIMEOUT}s"
    except httpx.HTTPStatusError as exc:
        return None, f"Exa API error {exc.response.status_code}"
    except Exception as exc:  # noqa: BLE001
        return None, f"Exa request failed: {exc}"

    def _extract(data: dict) -> str | None:
        content = data.get("result", {}).get("content", [])
        if content and isinstance(content, list):
            return content[0].get("text")
        return None

    # SSE-streamed response: first data line with content wins.
    for line in resp.text.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            data = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        text = _extract(data)
        if text:
            return text, None
    try:
        text = _extract(resp.json())
        if text:
            return text, None
    except Exception:  # noqa: BLE001
        pass
    return None, "No results returned from Exa API"


async def _jina_fetch(url: str) -> tuple[str | None, str | None]:
    """Fetch a URL as markdown via Jina Reader (r.jina.ai)."""
    try:
        async with httpx.AsyncClient(timeout=_WEB_TIMEOUT) as client:
            resp = await client.get(_JINA_PREFIX + url)
    except httpx.TimeoutException:
        return None, f"Fetch timed out after {_WEB_TIMEOUT}s"
    except Exception as exc:  # noqa: BLE001
        return None, f"Fetch failed: {exc}"
    if resp.status_code != 200:
        return None, f"Fetch failed: Jina Reader HTTP {resp.status_code}"
    text = _strip_jina_header(resp.text)
    if not text or "<html" in text[:200].lower():
        return None, "Fetch returned no readable content"
    if len(text) > _MAX_FETCH_CHARS:
        text = text[:_MAX_FETCH_CHARS] + f"\n[truncated at {_MAX_FETCH_CHARS} chars]"
    return text, None


@tool(mutating=False, tool_icon="🌐")
async def web(query: str, mode: str = "search", max_results: int = 8,
              max_chars: int = _MAX_FETCH_CHARS) -> str:
    """Web search (Exa) or URL fetch (Jina Reader) — one tool for both.

    ``mode='search'`` (default): query the web, returns titles/URLs/snippets.
    ``mode='fetch'``: download a URL's readable markdown text.
    Needs internet.

    :param query: Search query, or a URL when mode='fetch'.
    :param mode: 'search' (default) or 'fetch'.
    :param max_results: Max search results (Exa returns up to ~8-10).
    :param max_chars: Fetch truncation limit.
    """
    mode = (mode or "search").lower()
    if mode == "fetch":
        url = query.strip()
        if not url.startswith(("http://", "https://")):
            return "mode='fetch' requires an http(s) URL"
        text, err = await _jina_fetch(url)
        return err or (text or "")[:max_chars] if text else (err or "empty")
    text, err = await _exa_search(query, max_results)
    return err or text or "No results."


# ---------------------------------------------------------------------------
# paper_search — arXiv
# ---------------------------------------------------------------------------


@tool(mutating=False, tool_icon="📄")
async def paper_search(
    query: str, max_results: int = 5, sort_by: str = "relevance"
) -> str:
    """Search arXiv for research papers.

    :param query: Search keywords (arXiv query syntax supported).
    :param max_results: Number of papers to return (max 20).
    :param sort_by: "relevance" or "date".
    """
    import xml.etree.ElementTree as ET

    query = (query or "").strip()
    if not query:
        return "Empty query."
    max_results = max(1, min(int(max_results), 20))
    sort = "submittedDate" if sort_by == "date" else "relevance"
    # Build the arXiv query with urlencode (QueryParams is not a str).
    from urllib.parse import urlencode

    api = "https://export.arxiv.org/api/query?" + urlencode(
        {
            "search_query": f"all:{query}",
            "start": 0,
            "max_results": max_results,
            "sortBy": sort,
            "sortOrder": "descending",
        }
    )
    try:
        async with httpx.AsyncClient(timeout=30.0, headers=_HEADERS) as client:
            resp = await client.get(api)
            resp.raise_for_status()
        ns = {"a": "http://www.w3.org/2005/Atom"}
        root = ET.fromstring(resp.text)
        out = []
        for entry in root.findall("a:entry", ns):
            title = " ".join((entry.findtext("a:title", "", ns) or "").split())
            summary = " ".join((entry.findtext("a:summary", "", ns) or "").split())
            link = ""
            for ln in entry.findall("a:link", ns):
                if ln.get("title") == "pdf" or ln.get("rel") == "related":
                    link = ln.get("href", "")
                    break
            id_node = entry.find("a:id", ns)
            link = link or ((id_node.text or "") if id_node is not None else "")
            authors = [a.findtext("a:name", "", ns) for a in entry.findall("a:author", ns)]
            year = ""
            published = entry.findtext("a:published", "", ns) or ""
            year = published[:4]
            out.append(
                f"Title: {title}\nAuthors: {', '.join(authors)}\nYear: {year}\n"
                f"URL: {link}\nAbstract: {summary[:800]}"
            )
        return "\n\n---\n\n".join(out) if out else "No papers found."
    except Exception as exc:  # noqa: BLE001
        return f"arXiv search error: {exc}"


# ---------------------------------------------------------------------------
# cron — scheduled reminders and automations ("remind me every Monday at 9")
# ---------------------------------------------------------------------------


def _cron_describe(schedule) -> str:  # noqa: ANN001 - CronSchedule
    from datetime import datetime

    def stamp(ms: int | None) -> str:
        if not ms:
            return "—"
        return datetime.fromtimestamp(ms / 1000).astimezone().strftime("%Y-%m-%d %H:%M %Z")

    if schedule.kind == "at":
        return f"once at {stamp(schedule.at_ms)}"
    if schedule.kind == "every":
        return f"every {schedule.every_seconds}s"
    tz_part = f" ({schedule.tz})" if schedule.tz else ""
    return f"cron `{schedule.expr}`{tz_part}"


def _cron_parse_at(value: str) -> int:
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError(
            f"could not parse time {value!r} — use ISO 8601, e.g. 2026-06-12T09:00"
        ) from None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()  # naive times are server-local
    return int(parsed.timestamp() * 1000)


@tool(mutating=True, tool_icon="⏰")
def cron(
    action: str,
    message: str = "",
    name: str = "",
    at: str = "",
    every_seconds: int = 0,
    cron_expr: str = "",
    tz: str = "",
    job_id: str = "",
) -> str:
    """Schedule reminders or automations that run later, and manage them.

    Use this when the learner asks to be reminded, nudged or given something on
    a schedule ("remind me every Monday at 9", "quiz me tomorrow evening").
    The scheduled run lands as a new message in this conversation.

    :param action: "list", "schedule" (aka add) or "cancel".
    :param message: For "schedule": the instruction or reminder to deliver when due.
    :param name: Optional short label for the task.
    :param at: For "schedule": one-off time, ISO 8601, e.g. "2026-06-12T09:00".
    :param every_seconds: For "schedule": repeat interval in seconds (min 30).
    :param cron_expr: For "schedule": cron expression, e.g. "0 9 * * 1" (Mondays 09:00).
    :param tz: For "schedule": IANA timezone for cron_expr, e.g. "Europe/Berlin".
    :param job_id: For "cancel": the id shown by action="list".
    """
    from ..services.cron import CronOwner, get_cron_service
    from .turn_context import turn_context

    session_id, workspace_id = turn_context()
    if not session_id:
        return "Scheduling is not available in this context."
    owner = CronOwner(kind="chat", session_id=session_id, workspace_id=workspace_id)
    service = get_cron_service()
    verb = (action or "").strip().lower()
    verb = {"add": "schedule", "remove": "cancel"}.get(verb, verb)

    def describe(job) -> str:  # noqa: ANN001 - CronJob
        from datetime import datetime

        nxt = job.state.next_run_at_ms
        when = (
            datetime.fromtimestamp(nxt / 1000).astimezone().strftime("%Y-%m-%d %H:%M %Z")
            if nxt
            else "—"
        )
        status = job.state.last_status or "pending"
        return (
            f"- `{job.id}` **{job.name}** — {_cron_describe(job.schedule)}; "
            f"next run {when}; last: {status}"
        )

    if verb == "list":
        jobs = service.list_jobs(owner_key=owner.key)
        if not jobs:
            return "No scheduled reminders for this conversation."
        return "\n".join([f"{len(jobs)} scheduled reminder(s):", *map(describe, jobs)])

    if verb == "cancel":
        key = (job_id or "").strip()
        if not key:
            return "cancel needs a job_id (see action='list')."
        if service.cancel_job(key, owner_key=owner.key):
            return f"Reminder `{key}` cancelled."
        return f"No reminder `{key}` found for this conversation."

    if verb == "schedule":
        text = (message or "").strip()
        if not text:
            return "schedule needs a message — what to deliver when it is due."
        chosen = [bool((at or "").strip()), bool(every_seconds), bool((cron_expr or "").strip())]
        if sum(chosen) != 1:
            return (
                "Provide exactly one of: at (one-off), every_seconds (interval), "
                "or cron_expr (cron expression)."
            )
        try:
            from ..services.cron import CronSchedule

            if at.strip():
                schedule = CronSchedule(kind="at", at_ms=_cron_parse_at(at.strip()))
            elif every_seconds:
                schedule = CronSchedule(kind="every", every_seconds=int(every_seconds))
            else:
                schedule = CronSchedule(
                    kind="cron", expr=cron_expr.strip(), tz=(tz or "").strip() or None
                )
            job = service.add_job(
                name=name, message=text, schedule=schedule, owner=owner
            )
        except (ValueError, TypeError) as exc:
            return f"Could not schedule: {exc}"
        from datetime import datetime

        first = (
            datetime.fromtimestamp(job.state.next_run_at_ms / 1000)
            .astimezone()
            .strftime("%Y-%m-%d %H:%M %Z")
            if job.state.next_run_at_ms
            else "—"
        )
        return (
            f"Scheduled **{job.name}** (`{job.id}`) — {_cron_describe(job.schedule)}; "
            f"first run {first}. The result arrives in this conversation and on the calendar."
        )

    return f"Unknown action {action!r} — use list, schedule or cancel."


# ---------------------------------------------------------------------------
# review — spaced repetition over the question bank (feeds the calendar)
# ---------------------------------------------------------------------------


@tool(mutating=True, tool_icon="🔁")
def review(action: str, question: str = "", correct: bool = True) -> str:
    """Run spaced-repetition reviews of the learner's question bank.

    Cards are due on a growing schedule (1, 3, 7, 14, 30, 60 days). Use
    action="due" to fetch what needs reviewing now, ask the learner, then
    record each outcome with action="grade".

    :param action: "due" (what to review now), "grade" (record an answer) or "status".
    :param question: For "grade": the question text exactly as shown by "due".
    :param correct: For "grade": true if the learner answered correctly.
    """
    from ..services import reviews

    verb = (action or "").strip().lower()
    if verb == "status":
        s = reviews.summary()
        return (
            f"{s['cards']} card(s) scheduled, {s['due_now']} due now. "
            + ", ".join(f"box {box}: {count}" for box, count in s["boxes"].items() if count)
        )
    if verb == "due":
        import time

        now = time.time()
        cards = reviews.due_between(now, now + 86400 * 30)
        if not cards:
            s = reviews.summary()
            return f"Nothing due right now — {s['cards']} card(s) scheduled."
        lines = [f"{len(cards)} card(s) due:"]
        for card in cards[:20]:
            lines.append(f"- [{card['key']}] {card['question']} (box {card['box']})")
        return "\n".join(lines)
    if verb == "grade":
        text = (question or "").strip()
        if not text:
            return "grade needs the question text from action='due'."
        try:
            card = reviews.grade(reviews.key_for(text), bool(correct))
        except KeyError:
            return f"No card matches {text!r} — run action='due' first."
        days = int((card["due_at"] - __import__("time").time()) / 86400)
        return f"Recorded. Box {card['box']}, next review in about {max(days, 0)} day(s)."
    return 'action must be "due", "grade" or "status".'
