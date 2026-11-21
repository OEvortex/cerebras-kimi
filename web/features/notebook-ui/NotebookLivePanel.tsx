"use client";

import Link from "@/shared/router/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  CircleAlert,
  Loader2,
  NotebookPen,
  Sparkles,
} from "lucide-react";

import type { StreamEvent } from "@/features/chat/model/protocol";
import {
  getNotebookCompletion,
  notebookDraftText,
  notebookPageLinks,
  notebookProgressEvents,
  subscribeNotebookCompletions,
  type NotebookCompletion,
  type NotebookTask,
} from "@/lib/notebook-live-types";
import "./notebook-live.css";

type ProgressInfo = {
  kind: string;
  tool?: string;
  turns: number;
};

function progressInfo(event: StreamEvent): ProgressInfo | null {
  const meta = event.metadata as { notebook_progress?: ProgressInfo & { turns?: number } } | null;
  if (!meta?.notebook_progress) return null;
  return {
    kind: meta.notebook_progress.kind,
    tool: (meta.notebook_progress as { tool?: string }).tool,
    turns: Number(meta.notebook_progress.turns || 0),
  };
}

/** Collapse repeated `nb_list` steps into a single `nb_list ×5` chip. */
function countSteps(events: StreamEvent[]): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const info = progressInfo(event);
    if (info?.kind !== "tool_start" || !info.tool) continue;
    counts.set(info.tool, (counts.get(info.tool) || 0) + 1);
  }
  return [...counts.entries()].map(([tool, count]) => ({ tool, count }));
}

/**
 * Live writer panel for the `notebook` tool — the notebook counterpart of
 * `VideoLessonViewer`. Mounted from the assistant message as soon as the tool
 * result carries a notebook task, it streams the writer's progress and draft
 * into the chat while the pages are built.
 */
export default function NotebookLivePanel({
  task,
  events,
  isStreaming,
}: {
  task: NotebookTask;
  events: StreamEvent[];
  isStreaming?: boolean;
}) {
  const [completion, setCompletion] = useState<NotebookCompletion | undefined>(
    () => getNotebookCompletion(task.task_id),
  );

  useEffect(() => {
    setCompletion(getNotebookCompletion(task.task_id));
    return subscribeNotebookCompletions(() => {
      const next = getNotebookCompletion(task.task_id);
      if (next) setCompletion(next);
    });
  }, [task.task_id]);

  const progress = useMemo(
    () => notebookProgressEvents(events, task),
    [events, task],
  );
  const draft = useMemo(() => notebookDraftText(progress), [progress]);
  const steps = useMemo(() => countSteps(progress), [progress]);
  const turns = useMemo(
    () => Math.max(0, ...progress.map((event) => progressInfo(event)?.turns || 0)),
    [progress],
  );
  const pageLinks = useMemo(
    () => notebookPageLinks(completion?.report || ""),
    [completion?.report],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [draft]);

  const status = completion?.status || (isStreaming ? "running" : "pending");
  const done = status === "completed";
  const failed = status === "error";
  const hasDraft = draft.trim().length > 0;

  const phase = draft
    ? "Writing the notebook document…"
    : steps.length
      ? "Looking up your existing pages…"
      : "Starting the writer…";

  return (
    <section className="nb-live" aria-label="Live notebook writer">
      <header className="nb-live-head">
        <div className="nb-live-icon"><NotebookPen size={17} strokeWidth={1.8} /></div>
        <div className="nb-live-heading">
          <div className="nb-live-title">
            {task.label || task.title || "Study notebook"}
          </div>
          {task.request ? (
            <div className="nb-live-subtitle">{task.request}</div>
          ) : null}
        </div>
        <span className={`nb-live-status ${done ? "is-done" : failed ? "is-error" : "is-running"}`}>
          {done ? (
            <><Check size={12} /> Ready</>
          ) : failed ? (
            <><CircleAlert size={12} /> Failed</>
          ) : (
            <><Loader2 size={12} className="nb-live-spin" /> {turns ? `Turn ${turns}` : "Working"}</>
          )}
        </span>
      </header>

      {!done && !failed ? (
        <>
          <div className="nb-live-bar" aria-hidden>
            <span />
          </div>
          <div className="nb-live-body">
            <div className="nb-live-phase">
              <Sparkles size={12} /> {phase}
            </div>
            {steps.length ? (
              <div className="nb-live-steps">
                {steps.map(({ tool, count }) => (
                  <span key={tool} className="nb-live-step">
                    {tool}{count > 1 ? <b> ×{count}</b> : null}
                  </span>
                ))}
              </div>
            ) : null}
            <div ref={scrollRef} className={`nb-live-draft ${hasDraft ? "has-text" : ""}`}>
              {hasDraft ? (
                <pre>{draft.slice(-4000)}</pre>
              ) : (
                <div className="nb-live-skeleton" aria-hidden>
                  <span /><span /><span />
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className={`nb-live-body ${failed ? "is-error" : "is-done"}`}>
          <div className="nb-live-result-head">
            {done ? <Check size={14} /> : <CircleAlert size={14} />}
            <span>
              {done
                ? pageLinks.length
                  ? `${pageLinks.length} page${pageLinks.length === 1 ? "" : "s"} added to your notebook`
                  : "The writer finished."
                : "The writer could not finish."}
            </span>
          </div>
          {done && pageLinks.length ? (
            <ul className="nb-live-pages">
              {pageLinks.map((page) => (
                <li key={page.id}>
                  <Link href={`/co-writer/${page.id}`}>
                    <BookOpen size={13} /> {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <details className="nb-live-report">
            <summary>{failed ? "Details" : "Writer report"}</summary>
            <pre>{completion?.report || completion?.error}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
