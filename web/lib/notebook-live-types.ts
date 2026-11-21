import type { StreamEvent } from "@/features/chat/model/protocol";

export interface NotebookTask {
  task_id: string;
  label: string;
  request?: string;
  title?: string;
  parent_page_id?: string;
  tool_call_id?: string;
}

export interface NotebookProgress {
  kind: string;
  delta?: string;
  tool?: string;
  tool_counts?: Record<string, number>;
  turns?: number;
}

export interface NotebookCompletion {
  task_id: string;
  label: string;
  report: string;
  status: "completed" | "error" | string;
  error?: string;
}

export function extractNotebookTask(events: StreamEvent[]): NotebookTask | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "result" || event.source !== "notebook") continue;
    const task = (event.metadata as { notebook_task?: NotebookTask } | undefined)?.notebook_task;
    if (task?.task_id) return task;
  }
  return null;
}

export function notebookProgressEvents(
  events: StreamEvent[],
  task: NotebookTask | null,
): StreamEvent[] {
  if (!task) return [];
  const toolId = task.tool_call_id || task.task_id;
  return events.filter((event) => {
    if (event.type !== "progress") return false;
    const meta = event.metadata as {
      tool_call_id?: string;
      notebook_progress?: NotebookProgress;
    } | null;
    if (!meta?.notebook_progress) return false;
    // Progress for this tool call, or the writer's generic updates when the
    // SDK adapter did not forward a tool_call_id.
    return !meta.tool_call_id || meta.tool_call_id === toolId || meta.tool_call_id.startsWith(toolId);
  });
}

export function notebookDraftText(progress: StreamEvent[]): string {
  let text = "";
  for (const event of progress) {
    const meta = event.metadata as { notebook_progress?: NotebookProgress } | null;
    if (meta?.notebook_progress?.kind === "text_delta") {
      text += meta.notebook_progress.delta || "";
    }
  }
  return text;
}

/** Page ids in the writer's report become real links in the live panel. */
export function notebookPageLinks(report: string): { id: string; label: string }[] {
  const links: { id: string; label: string }[] = [];
  for (const line of report.split("\n")) {
    const match = /^\s*[- ]*(.+?)\s*\(id\s+([0-9a-f]{8,32})/i.exec(line);
    if (match?.[2]) links.push({ id: match[2], label: match[1].trim() });
  }
  return links;
}

const COMPLETION_EVENT = "dt:notebook-completed";
const STORAGE_KEY = "dt:notebook-completions";

function loadCompletions(): Map<string, NotebookCompletion> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as NotebookCompletion[]) : [];
    return new Map(rows.filter((row) => row?.task_id).map((row) => [row.task_id, row]));
  } catch {
    return new Map();
  }
}

const completions = loadCompletions();

export function rememberNotebookCompletion(completion: NotebookCompletion): void {
  completions.set(completion.task_id, completion);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([...completions.values()].slice(-40)),
      );
    } catch {
      // Storage is best effort; the live panel still updates in memory.
    }
    window.dispatchEvent(new CustomEvent(COMPLETION_EVENT, { detail: completion }));
  }
}

export function getNotebookCompletion(taskId: string): NotebookCompletion | undefined {
  return completions.get(taskId);
}

export function subscribeNotebookCompletions(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(COMPLETION_EVENT, listener);
  return () => window.removeEventListener(COMPLETION_EVENT, listener);
}

export const NOTEBOOK_COMPLETION_EVENT = COMPLETION_EVENT;
