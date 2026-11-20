# DeepTutor

An agent-native AI learning companion — Vite + React 19 + TanStack Router frontend + Python backend powered by the [VTX coding-agent SDK](https://github.com/OEvortex/vtx-coding-agent). The frontend talks to the backend over **REST**; real-time turn and channel events are delivered over **Server-Sent Events (SSE)**. There are no WebSockets.

## Architecture

```
Browser ──POST /api/realtime/commands──▶ FastAPI (127.0.0.1:8001) ──▶ REST controller ──▶ AgentRuntime / vtx ConversationRuntime
Browser ◀──SSE /api/realtime/events───── FastAPI event queues ◀────────┘

Browser ──GET/POST /api/*──────────────▶ FastAPI handler registry (sessions, settings, KBs, notebooks, mastery, partners, …)
```

- **`backend/`** — FastAPI/Uvicorn app (`app/main.py`). REST handlers live in `app/api/handlers.py`; turn commands and feature-channel messages are dispatched directly by the REST+SSE controller in `app/api/realtime.py`, which drives the vtx agent loop in `app/agent/runtime.py`. There is no ACP or JSON-RPC layer.
- **`web/`** — Vite + React 19 + TanStack Router app (`vite.config.ts`, `src/router.tsx`). `features/chat/transport/` holds the SSE-backed `TurnSocket` and the turn protocol client; `lib/sse-socket.ts` is the shared REST+SSE shim used by the turn protocol, `lib/rpc-ws.ts`, and `lib/reconnecting-websocket.ts` for legacy feature channels. Commands are POSTed; frames arrive as named SSE events and are re-emitted with the same JSON payloads the old transport produced.
- **DeepTutor owns its state** — everything persistent lives in one WAL-mode SQLite database, `data/deeptutor.sqlite3`: conversations (`sessions`, `messages`, `turns`, `vtx_items`, FTS5 `session_fts`), settings, workspaces, notebook pages, knowledge-base text, memory/learning/mastery, question bank and reviews, calendar, cron jobs and AI edit history. The agent uses a real, append-only vtx `Session`; nothing is read from or written to `~/.vtx/sessions`. Legacy JSON/SQLite stores are imported once on first open; old `data/sessions/*.json` records are archived under `data/sessions-legacy/`.

### API surface

- **REST resources** (`/api/*`): auth, sessions and message events, settings and provider catalogs, knowledge bases and uploads, notebooks, question bank, mastery paths, partners and partner groups, documents, memory, dashboard, and more (`app/api/handlers.py`).
- **Turn commands** — `POST /api/realtime/commands` accepts the existing `ClientCommand` JSON: `start_turn`, `subscribe_turn`, `subscribe_session`, `resume_from`, `unsubscribe`, `cancel_turn`, `regenerate`, `submit_user_reply`, `user_input`, `check_active_turn`, `ping`.
- **Legacy channel messages** — the same endpoint with `?channel=<name>` (books, quiz judge, mastery paths, KB progress, partners, partner groups) wraps the payload as the backend's `legacy.send`.
- **Event stream** — `GET /api/realtime/events?client_id=<id>` (`text/event-stream`). Named events: `turn_event` (with `id: <turn_id>:<seq>` for replay), `session_update`, `legacy_event`, and `ready`/`heartbeat`. Each browser client has its own event queue, so events are scoped to the client that sent the command.
- **Client lifecycle** — `DELETE /api/realtime/clients/{client_id}` releases a client explicitly; idle clients are reclaimed by a periodic sweep.
- **Health** — `GET /health` → `{"status":"ok"}`.
- **Note pages** — `GET/POST /api/documents`, `GET/PUT/DELETE /api/documents/{id}`
  (revision-checked block pages, `409` on stale writes), plus `/suggestions`
  (review queue of proposed edits), `/threads`, `/backlinks`, `/assets`,
  `/review/due` + `/review` (flashcards), `/flashcards/export` (Anki text) and
  `/export|import/docx`.
- **Co-Writer AI edits** — `POST /api/documents/actions/edit` (whole draft),
  `/edit-react` + `/edit-react/stream` (SSE selection edit, optional rag/web
  reference), `/automark` (inline annotation), and `GET /documents/history`
  (`/{operation_id}`, `/tool-calls/{operation_id}`). All use the model picked in
  Settings through `services/llm_text.py`.
- **Scheduled reminders** — `GET/POST /api/cron/jobs`, `DELETE /api/cron/jobs/{id}`,
  `GET /api/cron/reports?since=` (fired reminders for live in-app delivery).
- **Reviews** — `GET /api/reviews/due`, `POST /api/reviews/{key}/grade` (spaced
  repetition over the question bank, 1/3/7/14/30/60-day boxes).
- **Calendar** — `GET/POST /api/calendar/calendars`, `PATCH/DELETE /api/calendar/calendars/{id}`,
  `GET/POST /api/calendar/events`, `PATCH/DELETE /api/calendar/events/{id}` (with
  `scope=this|following|all` + `occurrence`), `POST /api/calendar/undo/{token}`,
  `GET /api/calendar/search`, `GET /api/calendar/layers`, `GET /api/calendar/task-blocks`,
  `GET /api/calendar/export.ics`, and `GET /api/calendar/stream` (SSE revision feed).
  `GET /api/modules` reports `calendar` as installed so the sidebar entry, route gate and
  reminder runtime switch on.

## Backend layout (`backend/app/`)

| Path | Purpose |
|---|---|
| `main.py` | FastAPI app: middleware, state, REST router, SSE realtime router, `/health`, Uvicorn entry point |
| `api/realtime.py` | REST + SSE controller: per-client command dispatch (turns and feature channels), named-event stream, idle cleanup |
| `api/handlers.py` | REST handler registry mounted at `/api/*` |
| `api/files.py` | Serves workspace and generated files under `/files/*` |
| `api/openui.py` | OpenUI endpoints (`/api/openui/wiki`, `/api/openui/research`, `/api/openui/street-route`) |
| `api/calendar.py` | Calendar router at `/api/calendar` (calendars, events, RRULE expansion, search, ICS export, SSE revision stream, workspace layers) |
| `agent/runtime.py` | `AgentRuntime` — builds vtx `ConversationRuntime`, owns turns/subscribers and event replay |
| `agent/tools.py` | Tool registry — `builtin_tools()` with toggleable/locked-on gating |
| `agent/dt_tools.py` | Consolidated tutor tools (see below) |
| `agent/kb_tools.py` | `knowledge_base_search` — BM25 retrieval over knowledge bases |
| `store/session_store.py` | DeepTutor session records — the sole conversation store |
| `agent/dt_session.py` | vtx `Session` subclass that persists entries into the DeepTutor record |
| `store/kb_store.py` | Knowledge-base store (chunked docs, BM25 search) |
| `services/cron/` | Scheduled reminders/automations: `at`/`every`/`cron` jobs in a WAL SQLite store, scheduler loop, chat executor that runs a turn in the owning session |
| `services/calendar/` | Calendar domain: pydantic wire models, RFC 5545 recurrence engine (dateutil), SQLite store with undo, iCalendar writer, workspace layer projections |
| `config.py` | `Settings` — `data_dir`, `workspace_dir` via `DT_DATA_DIR`/`DT_WORKSPACE_DIR` |

## Agent tools

DeepTutor is a tutor, not a coding agent. vtx's default coding prompt, ponytail
mode, AGENTS.md/skills and git context are replaced by the tutor prompt in
`agent/prompt.py`. The exposed tool set is limited to:

- **`web`** — Exa MCP search + Jina Reader fetch (`mode=search|fetch`)
- **`paper_search`** — arXiv paper search
- **`knowledge_base_search`** — `search|files|read` over uploaded KBs (BM25 + citations)
- **`memory`** — `read|write` durable learner facts (stored in `data/deeptutor.sqlite3`)
- **`notes`** — `write|list|search` notebook pages (stored in `data/deeptutor.sqlite3`)
- **`learning`** — `status|update|journal|weak` progress tracking
- **`mastery`** — Guided Learning loop `topics|start|status|quiz|grade|note|leave`
- **`quiz`** — `generate|grade`
- **`video`** — Remotion video lesson: a writer sub-agent authors `Lesson.tsx` against the bundled kit (`backend/app/agent/video_lesson/remotion/`); the backend compiles and frame-checks it with a pinned Node toolchain, times narration captions, and publishes a self-contained player page under `/files/videos/<slug>/lesson.html` played live in the chat's `VideoLessonViewer` (no server-side MP4). First use installs the pinned npm packages into `data/runtime/remotion` (override with `DEEPTUTOR_REMOTION_RUNTIME`).
- **`workspace`** — jailed ops for artifacts DeepTutor itself creates
- **`question_bank`** — stored question entries
- **`cron`** — `list|schedule|cancel` for scheduled reminders/automations (`at`, `every_seconds`, `cron_expr`); a due job runs a turn in the session it was scheduled from and appears on the calendar's Automations layer
- **`review`** — `due|grade|status` spaced repetition over the question bank; due cards show on the calendar's Reviews layer

Coding-agent tools (`apply_patch`, `read_file`, `list_files`, `codemode`,
`tool_search`, `ask_user`) are intentionally not registered.

### Provider / model configuration

DeepTutor owns its provider and model catalogue. Nothing is loaded from or featured out of `~/.vtx`: no `provider_catalog`, no `~/.vtx/models/` caches, no `~/.vtx/config.yml` (`last_selected`/`recent_models`) and no `~/.vtx/dynamic_auth.json`. The vtx SDK is used **only as an execution engine** — the backend passes the selected provider, model, base URL and API key into `ConversationRuntime` explicitly. (The engine still uses vtx's own built-in model-metadata tables internally for context windows; that metadata is not used to build the settings catalogue or choose a model.)

- **Built-in presets** — 62 providers (OpenAI, Anthropic, OpenRouter, DeepSeek, Zhipu, Together, Fireworks, NVIDIA, Hugging Face, Ollama, Aerolink, Kilo, WuS Router, aihubmix, Vercel AI, and more) live in `backend/app/provider_catalog.json` and are loaded by `backend/app/provider_config.py`. They supply connection prefills and fallback model options. Each entry carries its own `base_url`, `api_key_env`, model-discovery path and parser options.
- **User configuration** — connections (including API keys), profiles, models, the active `llm_selection` and `recent_models` — lives in the `kv` table of `data/deeptutor.sqlite3` (keys `settings/catalog` and `settings/selection`).
- **Model discovery** (`/api/settings/test-provider`, `/api/settings/fetch-models`) calls each preset's own `models_endpoint` directly (e.g. Experiential Labs uses `/api/models` with a custom parser) and stores the result in DeepTutor's catalog.
- **Provider icons** are bundled locally in `web/public/provider-icons/` (favicons fetched from the providers' domains, with a generated initials fallback), keyed by slug in `web/lib/provider-branding.ts`; provenance is recorded in `web/public/provider-icons/sources.json`. No external request is made to render them.
- A preset key can also come from its conventional env var (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) when no connection is configured.

## Frontend layout (`web/`)

- `vite.config.ts` — Vite config: `/api` & `/files` proxy to `127.0.0.1:8001`, `compactLocalePlugin`, env defines
- `src/router.tsx` — TanStack Router code-based route tree, auth gate, and redirects
- `app/(workspace)/` — chat, settings, knowledge, calendar, notebook page & layout components
- `lib/sse-socket.ts` — shared WebSocket-shaped client over REST command POST + SSE event stream
- `features/chat/transport/` — `TurnRuntimeClient`, `socket.ts` (SSE-backed), protocol parsing
- `features/notes/components/NoteAiEdit.tsx` — "Edit with AI" in the note editor's selection toolbar: Rewrite/Shorten/Expand or a custom instruction streams from `/documents/actions/edit-react/stream` and lands in the page's suggestion queue; "Annotate page" applies `【term】`/`《statement》` markers directly
- `components/chat/home/ReminderButton.tsx` — composer "Remind me" control (one-off or daily/weekly at 09:00) posting to `/api/cron/jobs`
- `features/calendar/components/CalendarRuntime.tsx` — event reminders *and* polled cron reports: toast + desktop notification anywhere in the signed-in app
- `lib/rpc-ws.ts`, `lib/reconnecting-websocket.ts` — legacy channel compatibility shims over the same SSE transport
- `lib/*-api.ts` — typed clients for sessions/settings/partners/notebooks/etc.

## Persistence

Everything persistent except uploaded binary workspace files lives in the single
WAL-mode database `data/deeptutor.sqlite3` (FTS5 index for session search).

| Data | Table(s) |
|---|---|
| Conversations and messages | `sessions`, `messages`, `turns`, `vtx_items`, `session_fts` |
| Settings catalog, selection and draft | `kv` (`settings/catalog`, `settings/selection`, `settings/draft`) |
| Workspaces | `kv` (`workspaces`) |
| Memory / learning / mastery | `kv` (`memory`, `learning`, `mastery`) |
| Question bank and reviews | `kv` (`question_bank`, `reviews`) |
| Notebook pages | `documents` (blocks, revision) |
| Suggestions, threads, flashcard review | `doc_extras` |
| Notebook assets | `doc_assets` |
| AI edit history (last 200 operations) | `kv` (`documents/history`) |
| Knowledge bases | `kb_meta`, `kb_docs`, `kb_chunks` |
| Calendars, events and undo tokens | `calendars`, `events`, `undo` |
| Scheduled reminders and delivery reports | `cron_jobs`, `kv` (`cron/reports`) |
| Extended feature stores | `ext_items`, `kv` |
| Uploaded workspace files | `data/files/` (binary media only) |
| Legacy import sources | read once on first open; session JSON archived to `data/sessions-legacy/` |
| Model/provider presets | `backend/app/provider_catalog.json` (static); API keys in `kv` or env vars |

## Development

The frontend and the Python backend are **separate processes**. The backend is a FastAPI/Uvicorn server on `127.0.0.1:8001` (REST under `/api/*`, SSE event stream at `/api/realtime/events`). `bun run dev` starts **only Vite** (`http://localhost:5173`, proxying `/api` and `/files` to `127.0.0.1:8001`) — if the backend is not running, chat fails after ~12 s with *"Couldn't reach the server. Please check your connection and retry."*

```bash
# Terminal 1 — backend (required)
cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

# Terminal 2 — frontend (http://localhost:5173)
cd web && bun run dev
```

Alternatively, `cd web && bun start` builds with Vite and starts both FastAPI and `vite preview` (`http://127.0.0.1:3000`) together.
Check the backend with `curl http://127.0.0.1:8001/health` → `{"status":"ok"}`.

## Notes

- `reff/` contains the upstream DeepTutor source used as reference (gitignored).
- `deep_question` (Quiz) is implemented: `agent/quiz.py` plans questions, generates them with the configured model, and emits `quiz_question_emitted` + `result` events for the interactive `QuizViewer`. AI Judge runs over the REST+SSE channel instead of a WebSocket.
- Remaining feature gaps vs upstream: deep capability pipelines (`deep_research`, `mastery_path` stages), obsidian/ima/marginnote connectors — transports and tool surfaces exist, domain logic is incremental.
