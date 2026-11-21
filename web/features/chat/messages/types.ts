import type { StreamEvent } from "@/features/chat/model/protocol";
import type { MessageTraceMetadata } from "@/features/chat/trace/memory";
import type { MessageAttachment, MessageRequestSnapshot } from "@/features/chat/ChatStateAdapter";
import type { OrphanedFailedTurn } from "@/lib/session-api";

export interface ChatMessageItem {
  id?: number;
  role: "user" | "assistant" | "system";
  content: string;
  capability?: string;
  events?: StreamEvent[];
  trace?: MessageTraceMetadata;
  attachments?: MessageAttachment[];
  requestSnapshot?: MessageRequestSnapshot;
  parentMessageId?: number | null;
  /** The server never accepted this submission (#1594) — rendered as an
   *  unsent message, not an ordinary sent one. */
  failedSubmission?: boolean;
  failedSubmissionNeedsReview?: boolean;
  orphanedFailedTurn?: OrphanedFailedTurn;
}

export interface NotebookReferenceGroup {
  notebookId: string;
  notebookName: string;
  count: number;
}

export const MODE_BADGE_LABELS: Record<string, string> = {
  chat: "Chat",
  ask_questions: "Ask Questions",
  deep_solve: "Deep Solve",
  deep_research: "Deep Research",
  math_animator: "Math Animator",
  video_lesson: "Video Lesson",
  notebook: "Notebook",
  visualize: "Visualize",
  mastery_path: "Mastery Path",
  immersive_reading: "Immersive Reading",
};

// Returns the i18n key (and a sensible fallback) for the capability badge
// shown above the user's message. Callers must run `t(...)` on the result.
// Exported so the turn navigator's hover card labels a turn with exactly
// the same wording the bubble carries.
//
// A capability with no entry is title-cased rather than printed raw: an
// unlisted mode used to surface its internal id ("immersive_reading") in the
// conversation, which reads as a bug to everyone who sees it.
/**
 * What a run of working-out actually contains, for the memo below.
 *
 * Prose is identified by its length rather than its text because a streamed
 * segment only ever grows; a run of steps by how many events it holds.
 *
 * ``settled`` says a turn has moved on to writing its answer, and then only
 * the shape matters. The region a turn is working in stays open in the event
 * stream and keeps absorbing everything that arrives, so a finished run of
 * steps went on counting the answer's own deltas — 3300 events for a trace
 * drawing two rows — and reported itself as changed on every one of them.
 * Nothing below the answer can alter the working-out above it: a new round
 * would take the answer back into the process, which moves the shape.
 */
/**
 * The width of an ActivityRow's mark column: the 15px dot cell, the 10px gap
 * after it, and the 2px the stack insets itself by. Pulling a row left by
 * this lands its text on the same edge as the prose around it.
 */
export const ROW_GUTTER = 27;

export function getModeBadgeLabel(capability?: string | null): string {
  if (!capability) return MODE_BADGE_LABELS.chat;
  const known = MODE_BADGE_LABELS[capability];
  if (known) return known;
  return capability
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

