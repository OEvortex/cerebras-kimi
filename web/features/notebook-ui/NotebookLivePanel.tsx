"use client";

import Link from "@/shared/router/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Loader2,
  NotebookPen,
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

/**
 * Live writer panel for the `notebook` tool — the notebook equivalent of the
 * video lesson viewer. It is mounted from the assistant message as soon as the
 * tool result carries a notebook task, and streams the writer's text deltas
 * and tool steps into the chat while it builds the pages.
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
  const steps = useMemo(
    () =>
      progress.filter(
        (event) =>
          (event.metadata as { notebook_progress?: { kind?: string } } | null)
            ?.notebook_progress?.kind === "tool_start",
      ),
    [progress],
  );
  const turns = useMemo(() => {
    const seen = progress.map(
      (event) =>
        (event.metadata as { notebook_progress?: { turns?: number } } | null)
          ?.notebook_progress?.turns || 0,
    );
    return Math.max(0, ...seen);
  }, [progress]);

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

  return (
    <section className="nb-live" aria-label="Live notebook writer">
      <header className="nb-live-head">
        <div className="nb-live-icon">
          <NotebookPen size={18} strokeWidth={1.8} />
        </div>
        <div className="nb-live-heading">
          <div className="nb-live-title">{task.label || "Study notebook"}</div>
          <div className="nb-live-subtitle">
            {task.request || "Building pages from your request"}
          </div>
        </div>
        <span
          className={`nb-live-status ${done ? "is-done" : failed ? "is-error" : "is-running"}`}
        >
          {done ? (
            <><CheckCircle2 size={13} /> Ready</>
          ) : failed ? (
            <><CircleAlert size={13} /> Failed</>
          ) : (
            <><Loader2 size={13} className="nb-live-spin" /> {turns ? `Drafting · turn ${turns}` : "Starting"}</>
          )}
        </span>
      </header>

      {!completion ? (
        <div className="nb-live-body">
          <div className="nb-live-progress">
            <div className="nb-live-progress-label">
              {draft ? "Writer is drafting the notebook document…" : "Writer is getting started…"}
            </div>
            {steps.length ? (
              <div className="nb-live-steps">
                {steps.slice(-6).map((event, index) => (
                  <span key={index} className="nb-live-step">
                    {(event.metadata as { notebook_progress?: { tool?: string } } | null)
                      ?.notebook_progress?.tool || "lookup"}
                  </span>
                ))}
              </div>
            ) : null}
            <div ref={scrollRef} className="nb-live-draft">
              {draft ? <pre>{draft.slice(-4000)}</pre> : (
                <div className="nb-live-loading">
                  <Loader2 size={14} className="nb-live-spin" /> Streaming the notebook as it is written…
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className={`nb-live-body ${failed ? "is-error" : ""}`}>
          {done ? (
            <>
              <p className="nb-live-summary">
                The writer finished and the pages are in your notebook.
              </p>
              {pageLinks.length ? (
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
                <summary>Writer report</summary>
                <pre>{completion.report}</pre>
              </details>
            </>
          ) : (
            <>
              <p className="nb-live-summary">{completion.error || "The writer could not finish."}</p>
              <details className="nb-live-report">
                <summary>Details</summary>
                <pre>{completion.report}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
