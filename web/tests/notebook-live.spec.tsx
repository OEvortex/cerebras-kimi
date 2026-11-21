import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import NotebookLivePanel from "@/features/notebook-ui/NotebookLivePanel";
import {
  rememberNotebookCompletion,
  type NotebookTask,
} from "@/lib/notebook-live-types";
import type { StreamEvent } from "@/features/chat/model/protocol";

const TASK: NotebookTask = {
  task_id: "bg_0042",
  tool_call_id: "notebook_abc",
  label: "Water cycle",
  request: "a notebook with a quiz",
};

function event(kind: string, extra: Record<string, unknown> = {}): StreamEvent {
  return {
    type: "progress",
    protocol_version: "2.0",
    seq: 1,
    turn_id: "turn-1",
    session_id: "session-1",
    timestamp: 1,
    source: "notebook",
    stage: "responding",
    content: kind,
    metadata: {
      tool_call_id: "notebook_abc",
      notebook_progress: { kind, ...extra },
    },
  } as StreamEvent;
}

describe("NotebookLivePanel", () => {
  it("streams the writer's draft and tool steps into the chat", () => {
    const events = [
      event("subagent_start"),
      event("tool_start", { tool: "nb_search" }),
      event("text_delta", { delta: "root = Notebook([" }),
      event("text_delta", { delta: "page], \"Water\")" }),
      event("turn_end", { turns: 2 }),
    ];
    render(<NotebookLivePanel task={TASK} events={events} isStreaming />);
    expect(screen.getByText("Water cycle")).toBeTruthy();
    expect(screen.getByText(/nb_search/)).toBeTruthy();
    expect(screen.getByText(/root = Notebook\(/)).toBeTruthy();
    expect(screen.getByText(/Drafting · turn 2/)).toBeTruthy();
  });

  it("shows a loading state before the first token", () => {
    render(<NotebookLivePanel task={TASK} events={[]} isStreaming />);
    expect(screen.getByText(/Streaming the notebook as it is written/)).toBeTruthy();
  });

  it("shows completion links and the report when the job finishes", async () => {
    render(<NotebookLivePanel task={TASK} events={[]} isStreaming={false} />);
    act(() => {
      rememberNotebookCompletion({
        task_id: "bg_0042",
        label: "Water cycle",
        status: "completed",
        report: "Notebook built: 2 page(s).\n- Water Cycle (id abcdef12, 6 blocks)\n- Water Cycle Quiz (id 1234abcd, 2 blocks)",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Ready")).toBeTruthy();
    });
    expect(screen.getByText("Water Cycle")).toBeTruthy();
    expect(screen.getByText("Water Cycle Quiz")).toBeTruthy();
    expect(document.querySelector('a[href="/co-writer/abcdef12"]')).toBeTruthy();
  });
});
