"use client";

import { useEffect } from "react";

import { notify } from "@/lib/notifications";
import { sseSocketFactory } from "@/lib/sse-socket";
import {
  rememberNotebookCompletion,
  type NotebookCompletion,
} from "@/lib/notebook-live-types";

/**
 * Always-on SSE listener for detached notebook jobs.
 *
 * The per-turn chat socket disconnects 15s after `done`, but a background
 * writer takes minutes. This dedicated client keeps the event stream open for
 * the whole workspace, so a completion reaches the learner immediately even
 * though no turn is running.
 */
export default function NotebookNotifications() {
  useEffect(() => {
    const socket = sseSocketFactory("/api/realtime/events");
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data || "")) as {
          type?: string;
          metadata?: { notebook_completed?: NotebookCompletion };
        };
        const completion = frame.metadata?.notebook_completed;
        if (!completion?.task_id) return;
        rememberNotebookCompletion(completion);
        notify(
          completion.status === "completed"
            ? `Notebook ready: ${completion.label}`
            : `Notebook failed: ${completion.label}`,
          { tone: completion.status === "completed" ? "success" : "error", durationMs: 12_000 },
        );
      } catch {
        // Non-protocol frames are ignored.
      }
    };
    return () => socket.close();
  }, []);

  return null;
}
