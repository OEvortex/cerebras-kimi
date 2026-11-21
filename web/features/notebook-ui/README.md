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
| `notebook-ui-lang/components.tsx` | Custom OpenUI component library: `Notebook`, `Page`, `Heading`, `Para`, `Math`, `Quiz`, `Flashcards`, … |
| `notebook-ui-lang/library.ts` | `createLibrary(...)` with root `Notebook`. |
| `notebook-ui-lang/lang.ts` | Program extraction + `compileNotebookProgram()` → BlockNote page plans. |
| `NotebookUIView.tsx` | The streaming renderer (`@openuidev/react-lang` `Renderer` + the custom library). |
| `useNotebookStream.ts` | SSE client for the generate endpoint. |
| `apply.ts` | Creates real Co-Writer pages from a finished program via `/api/documents`. |
| `NotebookUIStudio.tsx` | The `/notebook-ui` page: prompt → live preview → apply. |

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

Run: `bun run test:unit -- tests/notebook-ui-*` and `pytest tests/test_notebook_ui_api.py`.
