# Notebook live writer (main chat)

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

## Pieces

| Path | Role |
| --- | --- |
| `NotebookLivePanel.tsx` | The live writer card mounted in the main chat when the model calls the `notebook` tool. |
| `NotebookNotifications.tsx` | Always-on SSE listener that delivers background-job completions even after the turn ended. |
| `notebook-live.css` | Styling for the live card. |

Back end: `backend/app/agent/notebook_agent/`, `backend/app/api/notebook_ui.py`,
and the `notebook` tool in `backend/app/agent/dt_tools.py`.

## Tests

- `web/tests/notebook-live.spec.tsx` — live panel streaming, loading and completion states.
- Backend: `test_notebook_ui_api.py`, `test_notebook_live.py`, `test_realtime_broadcast.py`.
