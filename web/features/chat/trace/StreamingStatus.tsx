"use client";

import { useEffect, useState, type ReactNode } from "react";

import { formatTurnDuration, getTurnDurationSeconds } from "@/lib/trace-timing";
import type { StreamEvent } from "@/features/chat/model/protocol";
import { ActivityHeader } from "@/components/activity";
import { MODE_SPEED, MODE_TO_ORB } from "./ActivityOrb";
import { AnswererMark } from "./AnswererMark";
import type { Answerer } from "./answerer";
import type { TraceMetadata } from "./model";
import { getTraceMeta } from "./selectors";

type StreamingMode =
  | "reasoning"
  | "tool_using"
  | "responding"
  | "responded"
  | "planning"
  | "exploring"
  | "quizzing"
  | "reflecting";

/**
 * Picks the status label shown above the trace card.
 *
 * We scan in reverse so each round's latest signal wins — a tool result
 * mid-iteration flips the label back to reasoning, a planning chunk
 * arriving after a tool flips it to planning, etc. Per-mode mapping:
 *
 *   ``agent_loop_round``     → exploring  (chat exploring loop)
 *   ``llm_planning`` chunks  → planning   (solve plan / replan / pre-retrieve)
 *   ``tool_call`` event      → tool_using (any explicit tool call)
 *   ``llm_final_response``
 *     stage=``writing``      → responding (solve synthesize, also chat default)
 *   ``llm_reasoning`` chunks → reasoning  (generic reasoning trace)
 *
 * Falls back to ``reasoning`` while events are still warming up.
 */
export function detectStreamingMode(
  events: StreamEvent[],
  hasFinalContent: boolean,
  isStreaming: boolean,
): StreamingMode {
  if (!isStreaming) return "responded";

  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    const callKind = String(meta.call_kind ?? "");

    if (event.type === "tool_call") {
      // Tool calls inherit the active stage so the top-level status stays
      // coherent (e.g., a rag call during explore reads as "Exploring",
      // not generic "Tool Calling").
      if (event.stage === "exploring") return "exploring";
      if (event.stage === "quizzing") return "quizzing";
      return "tool_using";
    }
    if (event.type === "tool_result") {
      // Tool finished — keep scanning for the iteration's actual mode.
      continue;
    }
    // Quiz pipeline emits one ``quiz_question_emitted`` content event per
    // question with the structured qa_pair in metadata — that's the signal
    // the quizzing phase is active.
    if (callKind === "agent_loop_round") {
      // The chat loop streams user-facing text as `content` (commentary
      // before a tool call, or the closing answer): show "responding" while
      // text is flowing; thinking keeps "exploring".
      return event.type === "content" ? "responding" : "exploring";
    }
    if (callKind === "quiz_question_emitted") return "quizzing";
    // Question pipeline's Tool Summarizer (Phase 1 reflection over a raw
    // tool result) streams chunks under ``call_kind="tool_result_reflection"``.
    // While those chunks are arriving — and until the next reasoning / tool
    // event flips the mode again — the top-level status row reads
    // "DeepTutor Reflecting…".
    if (callKind === "tool_result_reflection") return "reflecting";
    if (event.type === "content" && callKind === "llm_final_response") {
      // Some pipelines stream response text while an exploration stage is
      // still open; keep the top-level title on "DeepTutor Exploring…" until
      // the bus moves on.
      if (event.stage === "exploring") return "exploring";
      if (event.stage === "writing") return "responding";
      return "responding";
    }
    if (callKind === "llm_planning") return "planning";
    if (event.type === "thinking" && callKind === "llm_reasoning") {
      if (event.stage === "exploring") return "exploring";
      if (event.stage === "quizzing") return "quizzing";
      return "reasoning";
    }
  }
  if (hasFinalContent) return "responding";
  return "reasoning";
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function getResearchTopicIndex(meta: TraceMetadata): number | null {
  const explicit = parsePositiveInt(meta.topic_index);
  if (explicit) return explicit;

  const searchable = [meta.block_id, meta.call_id, meta.trace_id]
    .map((value) => String(value || ""))
    .join(" ");
  const match = /\bblock_(\d+)\b/.exec(searchable);
  return match ? parsePositiveInt(match[1]) : null;
}

function getDeepResearchStatusLabel(
  events: StreamEvent[],
  isStreaming: boolean,
) {
  if (!isStreaming) return null;

  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (event.source !== "deep_research") continue;

    const meta = getTraceMeta(event);
    const key = String(meta.research_status_key || "");

    if (key === "decompose_target" || event.stage === "decomposing") {
      return "Decomposing Target";
    }

    if (key === "research_topic" || event.stage === "researching") {
      const topicIndex = getResearchTopicIndex(meta);
      return topicIndex
        ? `Researching Topic #${topicIndex}`
        : "Researching Topic";
    }

    if (key === "report_intro") return "Reporting Intro";
    if (key === "report_outline") return "Reporting Outline";
    if (key === "report_conclusion") return "Reporting Conclusion";
    if (key === "report_section") {
      const sectionIndex = parsePositiveInt(meta.section_index);
      return sectionIndex
        ? `Reporting Section #${sectionIndex}`
        : "Reporting Section";
    }

    if (event.stage === "reporting") {
      const label = String(meta.label || "").toLowerCase();
      if (label.includes("intro") || label.includes("introduction")) {
        return "Reporting Intro";
      }
      if (label.includes("conclusion") || label.includes("conclusion")) {
        return "Reporting Conclusion";
      }
      if (label.includes("section") || label.includes("section")) {
        const sectionIndex = parsePositiveInt(meta.section_index);
        return sectionIndex
          ? `Reporting Section #${sectionIndex}`
          : "Reporting Section";
      }
      return "Reporting";
    }
  }

  return null;
}

// While the explore_context pre-pass is the most recent activity, the
// turn-level status reads "Exploring Your Contexts" instead of the generic
// reasoning label. Mirrors getDeepResearchStatusLabel: a backward scan that
// bails as soon as a later (answer-phase) activity is seen.
function getExploreContextStatusLabel(
  events: StreamEvent[],
  isStreaming: boolean,
) {
  if (!isStreaming) return null;
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    const meta = getTraceMeta(event);
    const kind = String(meta.call_kind || "");
    const stage = String(event.stage || meta.phase || "");
    // Anything still inside the explore pre-pass — its reasoning rounds AND the
    // read_source tool calls it fires (stage="context_exploration") — keeps the
    // status on the explore verb, so it doesn't flicker to "Tool Calling…".
    if (kind === "context_exploration" || stage === "context_exploration") {
      return "Exploring your context…";
    }
    // The answer loop has taken over — let the normal mode label win.
    if (
      kind === "agent_loop_round" ||
      kind === "llm_final_response" ||
      event.type === "tool_call" ||
      event.type === "content"
    ) {
      return null;
    }
  }
  return null;
}

function getReasoningProgressStatusLabel(
  events: StreamEvent[],
  isStreaming: boolean,
) {
  if (!isStreaming) return null;
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    const meta = getTraceMeta(event);
    if (meta.trace_kind === "reasoning_progress") {
      return "Still reasoning before acting…";
    }
    if (
      meta.trace_kind === "call_status" &&
      (meta.call_state === "running" || meta.call_state === "complete")
    ) {
      return null;
    }
    if (event.type === "content" || event.type === "tool_call") return null;
  }
  return null;
}

export function StreamingStatus({
  events,
  isStreaming,
  content,
  className = "",
  expandable = false,
  expanded = false,
  onToggle,
  summary,
  agentName,
  answerer,
  showMark = true,
  traceBounds,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
  content?: string;
  /** A turn handed to a partner or an agent: they own the line, mark and all. */
  answerer?: Answerer;
  /** The turn's real span, when ``events`` is only a preview of it. */
  traceBounds?: { started_at?: number | null; ended_at?: number | null } | null;
  // Extra layout classes from the call site (e.g. ``mt-3`` when the row
  // sits at the bottom of the assistant output).
  className?: string;
  // When ``expandable`` the row becomes a disclosure toggle (a trailing
  // chevron rotates with ``expanded``) — used by ``AssistantActivity`` to
  // fold the trace nested beneath it.
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  // What the folded stack holds, shown while it is closed.
  summary?: ReactNode;
  // Who is doing the thinking — partner chat passes the partner's name so
  // the status reads "Ada Exploring…" instead of the product name.
  agentName?: string;
  // Partner chat shows the partner avatar beside this row, which already
  // signals "who / working", so it hides the activity mark to avoid two
  // icons fighting on one line.
  showMark?: boolean;
}) {
  
  const hasFinalContent = Boolean(content && content.trim().length > 0);
  const [nowSeconds, setNowSeconds] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!isStreaming) return;
    const timer = window.setInterval(
      () => setNowSeconds(Date.now() / 1000),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  // Only render once we either have a streaming turn, a completed turn that
  // produced visible content, or a completed turn whose trace is still worth
  // disclosing — empty placeholders (e.g. system message shells) shouldn't
  // show a status row. A turn that ran tools and then ended without a
  // user-facing answer belongs in that third case: dropping the row there
  // also drops the only affordance for opening the trace, so the whole
  // activity block renders as an invisible collapsed shell and the turn looks
  // like it never happened.
  if (!isStreaming && !hasFinalContent && !expandable) return null;
  const mode = detectStreamingMode(
    events,
    hasFinalContent,
    Boolean(isStreaming),
  );

  const name = agentName?.trim() || "DeepTutor";
  let modeLabel = `${name} Reasoning…`;
  if (mode === "tool_using") modeLabel = "Tool Calling…";
  else if (mode === "planning") modeLabel = `${name} Planning…`;
  // ``responding`` remains a useful transport/trace distinction, but it is
  // not a second user-facing phase. Keep the one continuous activity surface
  // the conversation already established instead of adding a competing
  // "Responding…" label beside the composer.
  else if (mode === "responding")
    modeLabel = `${name} Exploring…`;
  else if (mode === "exploring") modeLabel = `${name} Exploring…`;
  else if (mode === "quizzing") modeLabel = `${name} Quizzing…`;
  else if (mode === "reflecting")
    modeLabel = `${name} Reflecting…`;
  else if (mode === "responded") modeLabel = "Done";

  const label =
    getExploreContextStatusLabel(events, Boolean(isStreaming)) ??
    getDeepResearchStatusLabel(events, Boolean(isStreaming)) ??
    getReasoningProgressStatusLabel(events, Boolean(isStreaming)) ??
    modeLabel;

  // Single turn-level clock. Ticks every second while the turn is in
  // flight and freezes on the final elapsed time once the answer ends —
  // replaces the per-sub-trace duration chips that used to live inside
  // the trace card.
  const turnSeconds = getTurnDurationSeconds(
    events,
    nowSeconds,
    Boolean(isStreaming),
    traceBounds,
  );
  const durationLabel =
    turnSeconds != null ? formatTurnDuration(turnSeconds) : null;

  if (answerer) {
    // Their mark where the orb would be, their name held still, and what
    // they are doing breathing beside it — "Paul is thinking…", "Paul
    // answered". DeepTutor's own phase words do not apply to someone else.
    const doing =
      mode === "responded"
        ? "answered"
        : mode === "tool_using"
          ? "is using tools…"
          : hasFinalContent
            ? "is answering…"
            : "is thinking…";
    return (
      <ActivityHeader
        orb={MODE_TO_ORB[mode]}
        mark={<AnswererMark answerer={answerer} working={mode !== "responded"} />}
        lead={<span className="dt-answerer-name">{answerer.name}</span>}
        label={doing}
        duration={durationLabel}
        settled={mode === "responded"}
        expandable={expandable}
        expanded={expanded}
        onToggle={onToggle}
        summary={summary}
        className={className}
      />
    );
  }
  // Static label after the answer is done — no breathing animation. Every
  // other state is live, so the label breathes to signal ongoing work while
  // the orb beside it runs its own motion.

  return (
    <ActivityHeader
      orb={MODE_TO_ORB[mode]}
      orbSpeed={MODE_SPEED[mode] ?? 1}
      label={label}
      duration={durationLabel}
      settled={mode === "responded"}
      expandable={expandable}
      expanded={expanded}
      onToggle={onToggle}
      summary={summary}
      showOrb={showMark}
      className={className}
    />
  );
}
