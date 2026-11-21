# OpenNotebookUI

A generative-UI path for notebooks: the model writes a **notebook-ui-lang**
program instead of calling `notebook` / `note_suggest` / `flashcards` tools.
The program IS the notebook — it is parsed on every streamed chunk and rendered
live as pages, headings, LaTeX, quizzes and flashcards.

## Pieces

| Path | Role |
| --- | --- |
| `backend/app/agent/notebook_ui_prompt.txt` | The DSL spec / system prompt (source of truth for the model). |
| `backend/app/api/notebook_ui.py` | `POST /api/notebook-ui/generate` — SSE stream of `content` deltas, then the full program. |
| `notebook-ui-lang/components.tsx` | Small OpenUI library: the `Notebook`/`Page` shell plus thin adapters. Prose/code/maths go through `MarkdownRenderer`; quiz/flashcards/timeline/diagram reuse the notes and book renderers. |
| `notebook-ui-lang/library.ts` | `createLibrary(...)` with root `Notebook`. |
| `notebook-ui-lang/lang.ts` | Program extraction + `compileNotebookProgram()` → BlockNote page plans. |
| `NotebookUIView.tsx` | The streaming renderer (`@openuidev/react-lang` `Renderer` + the custom library). |
| `useNotebookStream.ts` | SSE client for the generate endpoint. |
| `apply.ts` | Creates real Co-Writer pages from a finished program via `/api/documents`. |
| `NotebookUIStudio.tsx` | The `/notebook-ui` page: prompt → live preview → apply. |
| `NotebookLivePanel.tsx` | The live writer card mounted in the main chat when the model calls the `notebook` tool. |
| `NotebookNotifications.tsx` | Always-on SSE listener that delivers background-job completions even after the turn ended. |

## Live notebook writer (main chat)

When the tutor calls the `notebook` tool, the tool result carries a
`NOTEBOOK_TASK:` marker. The backend maps it to a `result` event with
`source: "notebook"`, and `AssistantMessage` mounts `NotebookLivePanel` — the
notebook counterpart of `VideoLessonViewer`:

- the writer sub-agent's `text_delta` / `tool_start` / `turn_end` events are
  forwarded into the turn as `progress` events (vtx `progress_callback` is
  installed by `AgentRuntime`), so the draft streams live into the card;
- when the job settles — even minutes later, after the turn is gone —
  `notebook_events.notify_completion()` broadcasts a completion frame over the
  realtime hub, `NotebookNotifications` shows a toast, and the card flips to
  the finished report with links to the created pages;
- the finished report is also appended to the vtx session as a synthetic
  tagged message, so the **main agent** sees it in context on the next turn.

The completion is cached in `localStorage`, so a panel mounted after a reload
still shows the result.

## Why a separate library?

The chat's OpenUI library renders conversational card layouts. A notebook
program describes a *document*: pages, parent links, headings, display math and
learning blocks. Registering notebook components in a separate library keeps
both prompt surfaces small and lets each stream into its own renderer.

## Example program

```openui-lang
root = Notebook([hub, quiz], "The Water Cycle")
hub = Page([intro, facts], "The Water Cycle")
intro = Para("Water moves in a loop. $E = mc^2$ sets the energy scale.")
facts = Bullets(["Evaporation", "Condensation", "Precipitation"])
quiz = Page([check], "Water Cycle Quiz", "The Water Cycle")
check = Quiz([{question: "Which process lifts water?", type: "choice",
               options: ["Runoff", "Evaporation"], answer: "Evaporation"}])
```

## Tests

- `web/tests/notebook-ui-lang.spec.ts` — extraction, streaming fallback, compile-to-blocks.
- `web/tests/notebook-ui-render.spec.tsx` — live render, KaTeX, quiz and flashcard interaction.
- `backend/tests/test_notebook_ui_api.py` — SSE protocol and spec shipping.
- `backend/tests/test_notebook_live.py` — progress events, completion broadcast, tool marker.
- `backend/tests/test_realtime_broadcast.py` — hub broadcast reaches all clients.
- `web/tests/notebook-live.spec.tsx` — live panel streaming, loading and completion states.

Run: `bun run test:unit -- tests/notebook-ui-* tests/notebook-live.spec.tsx` and
`pytest tests/test_notebook_ui_api.py tests/test_notebook_live.py tests/test_realtime_broadcast.py`.
