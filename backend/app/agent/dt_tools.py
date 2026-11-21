"""DeepTutor's built-in tools as vtx ``BaseTool`` classes.

Same shape as ``vtx.coding_agent.tools``: a ``*Params`` pydantic model with
per-field descriptions plus a ``BaseTool`` subclass whose ``execute``
returns ``ToolResult``. The notebook companion (Co-writer) lives in
``co_writer.py``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Literal, cast

import httpx
from pydantic import BaseModel, Field
from vtx.agent.tools.base import BaseTool
from vtx.protocol.types import ToolResult


_HEADERS = {"User-Agent": "DeepTutor/0.1 (+https://deeptutor.info)"}


class NotesParams(BaseModel):
    action: Literal["write", "list", "search", "update"] = Field(
        description=(
            "write = create a page (needs title, optional content/tags); "
            "list = all notes as 'id | title | tags'; "
            "search = full-text search (needs query); "
            "update = patch a page in place (needs note_id + old_string/"
            "new_string, optional replace_all)."
        )
    )
    title: str = Field(
        default="", description="Note title — required for write."
    )
    content: str = Field(
        default="", description="Markdown body — write only."
    )
    tags: str = Field(
        default="", description="Comma-separated tags — write only."
    )
    query: str = Field(
        default="", description="Search terms — search only."
    )
    note_id: str = Field(
        default="",
        description="Target note id from list/search/write — update only.",
    )
    old_string: str = Field(
        default="",
        description=(
            "Exact text to replace, whitespace included — update only. "
            "Must match uniquely unless replace_all is true."
        ),
    )
    new_string: str = Field(
        default="", description="Replacement text — update only."
    )
    replace_all: bool = Field(
        default=False,
        description="Replace every occurrence instead of requiring a unique match — update only.",
    )


class NotesTool(BaseTool):
    """vtx-style tool: the user's notebook (Co-Writer pages)."""

    name = "notes"
    tool_icon = "📝"
    params = NotesParams
    mutating = True
    prompt_guidelines = (
        "notes for the user's notebook pages (not workspace files)",
    )
    description = (
        "Read and write the user's notebook — notes are Co-Writer pages, "
        "visible in the app's Notebook tab. One action per call; only fill "
        "the params that action uses. update patches a page in place: "
        "old_string must match the body exactly, including whitespace."
    )

    async def execute(
        self, params: NotesParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..services.documents import notes as note_store

        op = params.action.lower()
        if op == "write":
            if not params.title:
                return _fail("notes write needs a title.")
            note_id = note_store.write_note(
                params.title, params.content, params.tags)
            return _ok(f"Saved note '{params.title}' to your notebook as {note_id}")
        if op == "search":
            return _ok(note_store.search_notes(params.query))
        if op == "update":
            return _ok(note_store.update_note(
                params.note_id, params.old_string, params.new_string,
                replace_all=params.replace_all))
        return _ok(note_store.list_notes())


def _ok(text: str) -> ToolResult:
    return ToolResult(success=True, result=text)


def _fail(text: str) -> ToolResult:
    return ToolResult(success=False, result=text)


notes = NotesTool()


class QuestionBankParams(BaseModel):
    action: Literal["add", "list", "search"] = Field(
        description="add = save a Q&A pair; list = recent questions; "
        "search = find entries by text (uses question or topic as the query)."
    )
    question: str = Field(default="", description="The question text.")
    answer: str = Field(default="", description="The answer — add only.")
    topic: str = Field(default="", description="Optional topic tag.")


class QuestionBankTool(BaseTool):
    name = "question_bank"
    tool_icon = "❓"
    params = QuestionBankParams
    mutating = True
    description = (
        "Manage the learner's personal Q&A bank: save questions with "
        "answers, list recent entries, or search by text."
    )

    async def execute(
        self, params: QuestionBankParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..config import get_settings
        from ..store import database

        settings = get_settings()
        bank = database.get_state(settings, "question_bank", []) or []
        verb = params.action.strip().lower()
        if verb == "add":
            if not params.question.strip():
                return _fail("question is required for add.")
            bank.append({"q": params.question, "a": params.answer,
                         "topic": params.topic, "created": time.time()})
            database.put_state(settings, "question_bank", bank)
            return _ok(f"Saved question to bank ({len(bank)} total).")
        if verb == "list":
            return _ok("\n".join(
                f"- {e['q']}" + (f" [{e.get('topic','')}]" if e.get("topic") else "")
                for e in bank[-50:]) or "Question bank is empty.")
        q = params.question.strip().lower() or params.topic.strip().lower()
        hits = [e for e in bank
                if q in (e["q"] + " " + e.get("a", "")).lower()]
        return _ok("\n\n".join(
            f"Q: {e['q']}\nA: {e.get('a','')}" for e in hits[:10]) or "No matches.")


question_bank = QuestionBankTool()


# ---------------------------------------------------------------------------
# memory — tiny persistent memory (read_memory / write_memory)
# ---------------------------------------------------------------------------


class MemoryParams(BaseModel):
    action: Literal["read", "write"] = Field(
        description="read = recall stored facts (query filters by substring); "
        "write = store a durable fact about the learner."
    )
    query: str = Field(default="", description="Substring filter — read only.")
    fact: str = Field(
        default="", description="One-sentence fact to store — write only."
    )
    category: str = Field(
        default="general",
        description="Category for write, e.g. preference|goal|background.",
    )


class MemoryTool(BaseTool):
    name = "memory"
    tool_icon = "🧠"
    params = MemoryParams
    mutating = True
    description = (
        "Long-term memory about the learner: recall stored facts or save "
        "new durable ones (preferences, goals, background)."
    )

    async def execute(
        self, params: MemoryParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..config import get_settings
        from ..store import database

        settings = get_settings()
        memories = database.get_state(settings, "memory", []) or []
        if params.action == "write":
            if not params.fact:
                return _fail("memory write needs a fact.")
            memories.append({"fact": params.fact, "category": params.category,
                             "created": time.time()})
            database.put_state(settings, "memory", memories)
            return _ok(f"Remembered: {params.fact}")
        if not memories:
            return _ok("No memories stored yet.")
        kept = memories
        q = params.query.strip().lower()
        if q:
            kept = [m for m in memories
                    if q in json.dumps(m, ensure_ascii=False).lower()]
        return _ok(json.dumps(kept[-50:], ensure_ascii=False, indent=1) or "[]")


memory = MemoryTool()


# ---------------------------------------------------------------------------
# learning — single tool covering the whole learning-state surface
# (upstream learning_status + learning_update + journal merged)
# ---------------------------------------------------------------------------


class LearningParams(BaseModel):
    action: Literal["status", "update", "journal", "weak"] = Field(
        description="status = overall progress; update = record progress on "
        "a topic; journal = append a free-form note; weak = list weak topics."
    )
    topic: str = Field(default="", description="Topic name — update only.")
    note: str = Field(
        default="", description="Free-text note — update and journal."
    )
    status: str = Field(
        default="",
        description="learned|learning|weak — update only.",
    )
    minutes: int = Field(default=0, description="Minutes spent — update only.")


class LearningTool(BaseTool):
    name = "learning"
    tool_icon = "📚"
    params = LearningParams
    mutating = True
    description = (
        "Track the learner's progress across topics: per-topic mastery "
        "state, a free-form journal, and a weak-topics list for review."
    )

    async def execute(
        self, params: LearningParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..config import get_settings
        from ..store import database

        settings = get_settings()
        data = database.get_state(settings, "learning", {"topics": {}, "journal": []})
        if not isinstance(data, dict):
            data = {"topics": {}, "journal": []}
        topics = cast(dict[str, Any], data.setdefault("topics", {}))
        journal = cast(list[dict[str, Any]], data.setdefault("journal", []))

        verb = params.action.lower()
        if verb == "update":
            if not params.topic:
                return _fail("learning update needs a topic.")
            t = topics.setdefault(params.topic,
                                  {"status": "learning", "notes": [], "minutes": 0})
            if params.status:
                t["status"] = params.status
            if params.note:
                t["notes"].append({"at": time.time(), "note": params.note})
            t["minutes"] = int(t.get("minutes", 0)) + max(0, params.minutes)
            t["updated_at"] = time.time()
            database.put_state(settings, "learning", data)
            return _ok(f"Recorded: {params.topic} → {t['status']}")
        if verb == "journal":
            if not params.note:
                return _fail("journal needs a note.")
            journal.append({"at": time.time(), "note": params.note})
            database.put_state(settings, "learning", data)
            return _ok("Journal entry saved.")
        if verb == "weak":
            weak = {k: v for k, v in topics.items() if v.get("status") == "weak"}
            if not weak:
                return _ok("No weak topics recorded.")
            return _ok("Weak topics:\n" + "\n".join(
                f"- {k} ({v.get('minutes', 0)}min)" for k, v in weak.items()))
        if not topics:
            return _ok("No learning progress recorded yet.")
        lines = ["Learning status:"]
        for k, v in sorted(topics.items()):
            lines.append(f"- {k}: {v.get('status','?')} ({v.get('minutes',0)}min)")
        return _ok("\n".join(lines))


learning = LearningTool()


# ---------------------------------------------------------------------------
# workspace — single tool that controls the whole workspace
# (upstream workspace_read/list/present/export merged)
# ---------------------------------------------------------------------------


class WorkspaceParams(BaseModel):
    action: Literal["list", "read", "write", "search", "delete", "mkdir",
                    "info"] = Field(
        description="list = files under path; read = file contents; "
        "write = save content; search = substring match under path; "
        "delete = remove file/dir; mkdir = create dir; info = size/mtime."
    )
    path: str = Field(
        default="", description="Workspace-relative path (default '.')."
    )
    content: str = Field(default="", description="File content — write only.")
    query: str = Field(default="", description="Search substring — search only.")
    max_chars: int = Field(default=12000, description="Read truncation limit.")


class WorkspaceTool(BaseTool):
    name = "workspace"
    tool_icon = "🗂️"
    params = WorkspaceParams
    mutating = True
    description = (
        "Full control over the workspace directory: list, read, write, "
        "search, delete, mkdir and info. Paths are workspace-relative; "
        "'..' escapes are rejected."
    )

    async def execute(
        self, params: WorkspaceParams, cancel_event: Any = None
    ) -> ToolResult:
        root = Path(os.environ.get("DT_WORKSPACE_DIR", "./data/workspace")).resolve()
        root.mkdir(parents=True, exist_ok=True)

        def _resolve(p: str) -> Path:
            cand = (root / (p or ".").lstrip("/")).resolve()
            if cand != root and root not in cand.parents:
                raise ValueError(f"path escapes workspace: {p}")
            return cand

        verb = params.action.lower()
        try:
            if verb == "list":
                base = _resolve(params.path or ".")
                if not base.is_dir():
                    return _ok(f"Not a directory: {params.path}")
                entries = sorted(base.iterdir(), key=lambda e: (e.is_file(), e.name))
                lines = []
                for e in entries[:200]:
                    rel = e.relative_to(root)
                    lines.append(f"{'📁' if e.is_dir() else '📄'} {rel}")
                return _ok("\n".join(lines) or "(empty)")
            if verb == "read":
                f = _resolve(params.path)
                if not f.is_file():
                    return _ok(f"Not a file: {params.path}")
                return _ok(f.read_text(encoding="utf-8", errors="replace")[:params.max_chars])
            if verb == "write":
                f = _resolve(params.path)
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(params.content, encoding="utf-8")
                return _ok(f"Wrote {len(params.content)} chars to {params.path}")
            if verb == "search":
                base = _resolve(params.path or ".")
                hits = []
                for f in base.rglob("*") if base.is_dir() else [base]:
                    if not f.is_file() or f.stat().st_size > 2_000_000:
                        continue
                    try:
                        text = f.read_text(encoding="utf-8", errors="replace")
                    except Exception:  # noqa: BLE001
                        continue
                    if params.query.lower() in text.lower():
                        hits.append(str(f.relative_to(root)))
                        if len(hits) >= 20:
                            break
                return _ok("\n".join(hits) or "No matches.")
            if verb == "delete":
                f = _resolve(params.path)
                if f.is_file():
                    f.unlink()
                    return _ok(f"Deleted {params.path}")
                if f.is_dir():
                    shutil.rmtree(f)
                    return _ok(f"Deleted dir {params.path}")
                return _ok(f"Not found: {params.path}")
            if verb == "mkdir":
                _resolve(params.path).mkdir(parents=True, exist_ok=True)
                return _ok(f"Created {params.path}")
            if verb == "info":
                f = _resolve(params.path)
                if not f.exists():
                    return _ok(f"Not found: {params.path}")
                st = f.stat()
                return _ok(
                    f"{params.path}: {'dir' if f.is_dir() else 'file'}, "
                    f"{st.st_size} bytes, mtime "
                    f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))}")
            return _ok(f"Unknown workspace action: {params.action}")
        except Exception as exc:  # noqa: BLE001
            return _ok(f"workspace {verb} error: {exc}")


workspace = WorkspaceTool()


# ---------------------------------------------------------------------------
# mastery — single tool covering the whole Guided Learning surface
# (upstream mastery_* family merged)
# ---------------------------------------------------------------------------


class MasteryParams(BaseModel):
    action: Literal["topics", "start", "status", "quiz", "grade", "note",
                    "leave"] = Field(
        description="topics = list mastery state; start = begin a session "
        "on a topic; status = session state; quiz = next review question; "
        "grade = record an answer with a score; note = attach a note; "
        "leave = end the session."
    )
    topic: str = Field(default="", description="Topic name.")
    question: str = Field(
        default="", description="Question being answered — grade only."
    )
    answer: str = Field(default="", description="Learner's answer — grade only.")
    score: int = Field(
        default=-1,
        description="0-100 correctness for grade; -1 = ungraded.",
    )
    note: str = Field(default="", description="Free-text note.")


class MasteryTool(BaseTool):
    name = "mastery"
    tool_icon = "🎯"
    params = MasteryParams
    mutating = True
    description = (
        "Guided Learning mastery loop: start a session on a topic, ask "
        "diagnostic questions, grade answers (0-100), and track level "
        "0-5 across reviews."
    )

    async def execute(
        self, params: MasteryParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..config import get_settings
        from ..store import database

        settings = get_settings()
        data = database.get_state(settings, "mastery", {"topics": {}, "session": None})
        if not isinstance(data, dict):
            data = {"topics": {}, "session": None}
        topics = cast(dict[str, Any], data.setdefault("topics", {}))
        session = data.get("session")

        verb = params.action.lower()
        if verb == "topics":
            if not topics:
                return _ok("No mastery topics yet. Use mastery(action='start', topic='...').")
            return _ok("Mastery topics:\n" + "\n".join(
                f"- {k}: level {v.get('level', 0)}/5, {v.get('reviews', 0)} reviews"
                for k, v in topics.items()))
        if verb == "start":
            if not params.topic:
                return _fail("mastery start needs a topic.")
            topics.setdefault(params.topic, {"level": 0, "reviews": 0, "notes": []})
            data["session"] = {"topic": params.topic,
                               "started_at": time.time(), "turn": 0}
            database.put_state(settings, "mastery", data)
            return _ok(f"Started mastery session on {params.topic}. Ask a diagnostic question.")
        if verb == "status":
            return _ok(
                f"Session: {session} " if session
                else "No active session. " + f"Topics: {len(topics)}")
        if verb == "quiz":
            t = session and topics.get(session.get("topic"))
            if not t:
                return _ok("No active session — mastery(action='start', topic='...') first.")
            lvl = t.get("level", 0)
            prompts = [
                f"Explain {session['topic']} from scratch.",
                f"Give a non-trivial example of {session['topic']}.",
                f"What are the edge cases of {session['topic']}?",
                f"Compare {session['topic']} with a related concept.",
                f"Teach {session['topic']} to a beginner in 3 steps.",
            ]
            q = prompts[min(lvl, len(prompts) - 1)]
            return _ok(f"QUIZ: {q}\n(INSTRUCTION: ask the learner, then call mastery(action='grade').)")
        if verb == "grade":
            if not session or not params.question:
                return _fail("mastery grade needs an active session and question.")
            t = topics.setdefault(session["topic"], {"level": 0, "reviews": 0, "notes": []})
            t["reviews"] = int(t.get("reviews", 0)) + 1
            if params.score >= 0:
                # level 0-5: correct answers raise, wrong lower (min 0)
                delta = 1 if params.score >= 70 else (-1 if params.score < 40 else 0)
                t["level"] = max(0, min(5, int(t.get("level", 0)) + delta))
            if params.note:
                t.setdefault("notes", []).append({"at": time.time(), "note": params.note})
            t["updated_at"] = time.time()
            database.put_state(settings, "mastery", data)
            return _ok(
                f"Recorded: level {t['level']}/5 after {t['reviews']} reviews "
                f"on {session['topic']}.")
        if verb == "note":
            tname = params.topic or (session or {}).get("topic")
            t = topics.setdefault(tname or "general",
                                  {"level": 0, "reviews": 0, "notes": []})
            t.setdefault("notes", []).append({"at": time.time(), "note": params.note})
            database.put_state(settings, "mastery", data)
            return _ok("Note saved.")
        if verb == "leave":
            data["session"] = None
            database.put_state(settings, "mastery", data)
            return _ok("Mastery session ended.")
        return _fail(f"Unknown mastery action: {params.action}")


mastery = MasteryTool()


# ---------------------------------------------------------------------------
# video — natural-language query -> Remotion lesson -> self-contained HTML page
# played live in the browser. The writer sub-agent produces a Lesson.tsx against
# the shipped kit; the runtime compiles and frame-checks it, then publishes a
# player page under /files for the chat's VideoLessonViewer.
# ---------------------------------------------------------------------------

_VIDEO_LESSON_MARKER = "VIDEO_LESSON_RESULT:"


class VideoParams(BaseModel):
    query: str = Field(
        description=(
            "The learner's request in plain language, e.g. 'explain how "
            "photosynthesis works in a one-minute animation'."
        )
    )
    title: str = Field(
        default="", description="Optional short title for the lesson card/file slug."
    )


class VideoTool(BaseTool):
    name = "video"
    tool_icon = "🎬"
    params = VideoParams
    mutating = True
    description = (
        "Turn a natural-language request into an animated video lesson. A "
        "writer sub-agent produces a Remotion scene; the backend compiles "
        "it, frame-checks it, and publishes a player page under /files."
    )

    async def execute(
        self, params: VideoParams, cancel_event: Any = None
    ) -> ToolResult:
        from .video_lesson import create_lesson

        try:
            lesson = await create_lesson(params.query, params.title)
        except RuntimeError as exc:
            # Runtime errors already carry a user-facing "Video ... failed:" prefix.
            return _fail(str(exc))
        except Exception as exc:  # noqa: BLE001
            return _fail(f"Video render failed: {exc}")
        return _ok(_VIDEO_LESSON_MARKER
                   + json.dumps(lesson, ensure_ascii=False, separators=(",", ":")))


video = VideoTool()


# ---------------------------------------------------------------------------
# notebook — natural-language request -> background writer sub-agent -> real
# Co-Writer pages (subpages, mermaid diagrams, quizzes, flashcards). Runs
# through vtx's BackgroundTaskManager like delegate_subagent: the tool
# returns a task_id immediately and the writer's report arrives on a later
# turn. The writer's own prompt and nb_* toolset live in notebook_agent/.
# ---------------------------------------------------------------------------


class NotebookParams(BaseModel):
    request: str = Field(
        description=(
            "What the notebook should contain, in plain language — topic, "
            "structure, depth and audience, e.g. 'a study notebook on the "
            "French Revolution with a timeline and a quiz'."
        )
    )
    title: str = Field(
        default="", description="Optional title for the top page / job label."
    )
    parent_page_id: str = Field(
        default="",
        description=(
            "Optional notebook page id to build under; empty creates a new "
            "top-level page tree."
        ),
    )
    background: bool = Field(
        default=True,
        description=(
            "true (default) = run in the background and return a task_id "
            "immediately; false = wait for the writer and return its report."
        ),
    )


class NotebookTool(BaseTool):
    name = "notebook"
    tool_icon = "📓"
    params = NotebookParams
    mutating = True
    description = (
        "Build a study notebook in the background: a dedicated writer "
        "sub-agent creates pages, subpages, mermaid diagrams, flowcharts, "
        "quizzes and flashcards in the learner's notebook. Use for requests "
        "like 'make me notes on X' or 'build a revision notebook'."
    )

    async def execute(
        self,
        params: NotebookParams,
        cancel_event: Any = None,
        tool_call_id: str | None = None,
    ) -> ToolResult:
        from .notebook_agent import launch_notebook_job

        try:
            text = await launch_notebook_job(
                request=params.request,
                title=params.title,
                parent_page_id=params.parent_page_id,
                background=params.background,
                tool_call_id=tool_call_id,
            )
        except RuntimeError as exc:
            return _fail(str(exc))
        except Exception as exc:  # noqa: BLE001
            return _fail(f"Notebook job failed: {exc}")
        return _ok(text)


notebook = NotebookTool()


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


class WebParams(BaseModel):
    query: str = Field(
        description="Search query, or a full http(s) URL when mode='fetch'."
    )
    mode: Literal["search", "fetch"] = Field(
        default="search",
        description="search = web search results (titles/URLs/snippets); "
        "fetch = download a URL's readable markdown text.",
    )
    max_results: int = Field(
        default=8, description="Max search results (Exa returns up to ~8-10)."
    )
    max_chars: int = Field(
        default=_MAX_FETCH_CHARS, description="Fetch truncation limit."
    )


class WebTool(BaseTool):
    name = "web"
    tool_icon = "🌐"
    params = WebParams
    mutating = False
    description = (
        "Web access: search the web via Exa, or fetch a URL as readable "
        "markdown via Jina Reader. Needs internet."
    )

    async def execute(
        self, params: WebParams, cancel_event: Any = None
    ) -> ToolResult:
        if params.mode == "fetch":
            url = params.query.strip()
            if not url.startswith(("http://", "https://")):
                return _fail("mode='fetch' requires an http(s) URL")
            text, err = await _jina_fetch(url)
            if err:
                return _fail(err)
            return _ok((text or "")[:params.max_chars] if text else "empty")
        text, err = await _exa_search(params.query, params.max_results)
        return _ok(err) if err else _ok(text or "No results.")


web = WebTool()


# ---------------------------------------------------------------------------
# paper_search — arXiv
# ---------------------------------------------------------------------------


class PaperSearchParams(BaseModel):
    query: str = Field(
        description="Search keywords (arXiv query syntax supported)."
    )
    max_results: int = Field(default=5, description="Number of papers (max 20).")
    sort_by: Literal["relevance", "date"] = Field(
        default="relevance", description="Sort order for results."
    )


class PaperSearchTool(BaseTool):
    name = "paper_search"
    tool_icon = "📄"
    params = PaperSearchParams
    mutating = False
    description = "Search arXiv for research papers; returns titles, authors, year, URL and abstract."

    async def execute(
        self, params: PaperSearchParams, cancel_event: Any = None
    ) -> ToolResult:
        import xml.etree.ElementTree as ET

        query = params.query.strip()
        if not query:
            return _fail("Empty query.")
        max_results = max(1, min(int(params.max_results), 20))
        sort = "submittedDate" if params.sort_by == "date" else "relevance"
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
                published = entry.findtext("a:published", "", ns) or ""
                out.append(
                    f"Title: {title}\nAuthors: {', '.join(authors)}\nYear: {published[:4]}\n"
                    f"URL: {link}\nAbstract: {summary[:800]}"
                )
            return _ok("\n\n---\n\n".join(out) if out else "No papers found.")
        except Exception as exc:  # noqa: BLE001
            return _fail(f"arXiv search error: {exc}")


paper_search = PaperSearchTool()


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


class CronParams(BaseModel):
    action: str = Field(
        description=(
            "list = show scheduled reminders; schedule (alias add) = create "
            "one; cancel (alias remove) = delete by job_id. Provide exactly "
            "one of at / every_seconds / cron_expr when scheduling."
        )
    )
    message: str = Field(
        default="", description="Instruction or reminder to deliver when due — schedule only."
    )
    name: str = Field(default="", description="Optional short label for the task.")
    at: str = Field(
        default="",
        description="One-off time, ISO 8601 e.g. '2026-06-12T09:00' — schedule only.",
    )
    every_seconds: int = Field(
        default=0, description="Repeat interval in seconds (min 30) — schedule only."
    )
    cron_expr: str = Field(
        default="", description="Cron expression e.g. '0 9 * * 1' — schedule only."
    )
    tz: str = Field(
        default="", description="IANA timezone for cron_expr e.g. 'Europe/Berlin'."
    )
    job_id: str = Field(
        default="", description="Job id from action='list' — cancel only."
    )


class CronTool(BaseTool):
    name = "cron"
    tool_icon = "⏰"
    params = CronParams
    mutating = True
    description = (
        "Schedule reminders or automations that run later and manage them. "
        "Use when the learner asks to be reminded, nudged or given "
        "something on a schedule ('remind me every Monday at 9', 'quiz me "
        "tomorrow evening'). The scheduled run lands as a new message in "
        "this conversation."
    )

    async def execute(
        self, params: CronParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..services.cron import CronOwner, get_cron_service
        from .turn_context import turn_context

        session_id, workspace_id = turn_context()
        if not session_id:
            return _fail("Scheduling is not available in this context.")
        owner = CronOwner(kind="chat", session_id=session_id,
                          workspace_id=workspace_id)
        service = get_cron_service()
        verb = params.action.strip().lower()
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
                return _ok("No scheduled reminders for this conversation.")
            return _ok("\n".join([f"{len(jobs)} scheduled reminder(s):",
                                  *map(describe, jobs)]))

        if verb == "cancel":
            key = params.job_id.strip()
            if not key:
                return _fail("cancel needs a job_id (see action='list').")
            if service.cancel_job(key, owner_key=owner.key):
                return _ok(f"Reminder `{key}` cancelled.")
            return _ok(f"No reminder `{key}` found for this conversation.")

        if verb == "schedule":
            text = params.message.strip()
            if not text:
                return _fail("schedule needs a message — what to deliver when it is due.")
            chosen = [bool(params.at.strip()), bool(params.every_seconds),
                      bool(params.cron_expr.strip())]
            if sum(chosen) != 1:
                return _fail(
                    "Provide exactly one of: at (one-off), every_seconds "
                    "(interval), or cron_expr (cron expression)."
                )
            try:
                from ..services.cron import CronSchedule

                if params.at.strip():
                    schedule = CronSchedule(kind="at",
                                            at_ms=_cron_parse_at(params.at.strip()))
                elif params.every_seconds:
                    schedule = CronSchedule(kind="every",
                                            every_seconds=int(params.every_seconds))
                else:
                    schedule = CronSchedule(
                        kind="cron", expr=params.cron_expr.strip(),
                        tz=params.tz.strip() or None,
                    )
                job = service.add_job(
                    name=params.name, message=text, schedule=schedule, owner=owner
                )
            except (ValueError, TypeError) as exc:
                return _fail(f"Could not schedule: {exc}")
            from datetime import datetime

            first = (
                datetime.fromtimestamp(job.state.next_run_at_ms / 1000)
                .astimezone()
                .strftime("%Y-%m-%d %H:%M %Z")
                if job.state.next_run_at_ms
                else "—"
            )
            return _ok(
                f"Scheduled **{job.name}** (`{job.id}`) — {_cron_describe(job.schedule)}; "
                f"first run {first}. The result arrives in this conversation and on the calendar."
            )

        return _fail(f"Unknown action {params.action!r} — use list, schedule or cancel.")


cron = CronTool()


# ---------------------------------------------------------------------------
# review — spaced repetition over the question bank (feeds the calendar)
# ---------------------------------------------------------------------------


class ReviewParams(BaseModel):
    action: Literal["due", "grade", "status"] = Field(
        description="due = cards due for review now; grade = record an "
        "answer; status = schedule summary."
    )
    question: str = Field(
        default="",
        description="Question text exactly as shown by 'due' — grade only.",
    )
    correct: bool = Field(
        default=True, description="True if the learner answered correctly — grade only."
    )


class ReviewTool(BaseTool):
    name = "review"
    tool_icon = "🔁"
    params = ReviewParams
    mutating = True
    description = (
        "Spaced-repetition reviews of the learner's question bank. Cards "
        "are due on a growing schedule (1, 3, 7, 14, 30, 60 days): fetch "
        "what's due, ask the learner, then record each outcome."
    )

    async def execute(
        self, params: ReviewParams, cancel_event: Any = None
    ) -> ToolResult:
        from ..services import reviews

        verb = params.action.lower()
        if verb == "status":
            s = reviews.summary()
            return _ok(
                f"{s['cards']} card(s) scheduled, {s['due_now']} due now. "
                + ", ".join(f"box {box}: {count}" for box, count in s["boxes"].items() if count)
            )
        if verb == "due":
            import time

            now = time.time()
            cards = reviews.due_between(now, now + 86400 * 30)
            if not cards:
                s = reviews.summary()
                return _ok(f"Nothing due right now — {s['cards']} card(s) scheduled.")
            lines = [f"{len(cards)} card(s) due:"]
            for card in cards[:20]:
                lines.append(f"- [{card['key']}] {card['question']} (box {card['box']})")
            return _ok("\n".join(lines))
        text = params.question.strip()
        if not text:
            return _fail("grade needs the question text from action='due'.")
        try:
            card = reviews.grade(reviews.key_for(text), bool(params.correct))
        except KeyError:
            return _fail(f"No card matches {text!r} — run action='due' first.")
        days = int((card["due_at"] - __import__("time").time()) / 86400)
        return _ok(f"Recorded. Box {card['box']}, next review in about {max(days, 0)} day(s).")


review = ReviewTool()
