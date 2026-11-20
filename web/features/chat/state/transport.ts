import type React from "react";
import { NO_LLM_ACCESS, type StreamEvent } from "@/features/chat/model/protocol";
import type { UnifiedTurnClient } from "@/features/chat/transport/UnifiedTurnClient";
import {
  clearFailedSubmission,
  markFailedSubmissionNoLlmAccess,
  moveFailedSubmissions,
} from "@/lib/failed-submissions";
import { notify } from "@/lib/notifications";
import { forwardReaderAction } from "@/lib/reading-reader-action";
import {
  POST_DONE_DISCONNECT_DELAY_MS,
  POST_DONE_TITLE_REFRESH_MS,
  type Action,
  type MessageItem,
  type ProviderState,
  type SessionRuntimeStatus,
} from "./types";

export interface RunnerRecord {
  key: string;
  client: UnifiedTurnClient;
  replyCommand?: { fingerprint: string; commandId: string };
}

export interface PendingSubmissionEntry {
  storageKey: string;
  sourceStorageKey?: string;
  submissionId: string;
  visibleSubmissionIds: string[];
}

export interface RunnerEventDeps {
  runnersRef: React.RefObject<Map<string, RunnerRecord>>;
  stateRef: React.RefObject<ProviderState>;
  pendingSubmissionIdsRef: React.RefObject<Map<string, PendingSubmissionEntry>>;
  pendingRegenerateRef: React.RefObject<Map<string, MessageItem>>;
  pendingResendRef: React.RefObject<Map<string, MessageItem>>;
  loadSessionRef: React.RefObject<
    ((sessionId: string) => Promise<MessageItem[] | undefined>) | null
  >;
  dispatch: React.Dispatch<Action>;
  moveRunner: (oldKey: string, newKey: string) => void;
}

const REJECTED_REASONS = new Set([
  "start_turn_rejected",
  NO_LLM_ACCESS,
  "invalid_command",
  "invalid_json",
  "unsupported_protocol_version",
  "unknown_message_type",
]);

export function processRunnerEvent(
  deps: RunnerEventDeps,
  runnerKey: string,
  event: StreamEvent,
): void {
  const {
    runnersRef,
    stateRef,
    pendingSubmissionIdsRef,
    pendingRegenerateRef,
    pendingResendRef,
    loadSessionRef,
    dispatch,
    moveRunner,
  } = deps;
  const runner = runnersRef.current.get(runnerKey);
  const effectiveKey = runner?.key || runnerKey;
  forwardReaderAction(event);

  if (event.type === "session") {
    const sessionId =
      (event.metadata as { session_id?: string } | undefined)?.session_id ||
      event.session_id ||
      "";
    const turnId =
      (event.metadata as { turn_id?: string } | undefined)?.turn_id ||
      event.turn_id ||
      null;
    if (sessionId) {
      const pendingSubmission = pendingSubmissionIdsRef.current.get(effectiveKey);
      const draftSession = stateRef.current.sessions[effectiveKey];
      const movedIds =
        pendingSubmission && !draftSession?.sessionId
          ? moveFailedSubmissions(
              pendingSubmission.storageKey,
              sessionId,
              pendingSubmission.visibleSubmissionIds,
            )
          : [];
      if (
        pendingSubmission &&
        !draftSession?.sessionId &&
        movedIds.length < new Set(pendingSubmission.visibleSubmissionIds).size
      ) {
        notify(
          "Some unsent messages could not be moved into this conversation. Open a new chat to recover them.",
          { tone: "error", durationMs: 10_000 },
        );
      }
      if (pendingSubmission) {
        pendingSubmissionIdsRef.current.delete(effectiveKey);
        pendingSubmissionIdsRef.current.set(
          sessionId,
          movedIds.includes(pendingSubmission.submissionId)
            ? {
                ...pendingSubmission,
                sourceStorageKey: pendingSubmission.storageKey,
                storageKey: sessionId,
              }
            : pendingSubmission,
        );
      }
      dispatch({
        type: "BIND_SERVER_SESSION",
        key: effectiveKey,
        sessionId,
        turnId,
      });
      moveRunner(effectiveKey, sessionId);
    }
    return;
  }

  if (event.type === "session_meta") {
    const meta = event.metadata as
      | {
          title?: string;
          mastery_path_id?: string;
          mastery_session_mode?: string;
        }
      | undefined;
    if (typeof meta?.mastery_path_id === "string") {
      dispatch({
        type: "SET_MASTERY_PATH_ID",
        key: effectiveKey,
        masteryPathId: meta.mastery_path_id.trim() || null,
      });
    }
    if (typeof meta?.mastery_session_mode === "string") {
      dispatch({
        type: "SET_MASTERY_SESSION_MODE",
        key: effectiveKey,
        mode: meta.mastery_session_mode.trim() || null,
      });
    }
    const title = String(meta?.title || "").trim();
    if (title) {
      dispatch({
        type: "SET_SESSION_TITLE",
        key: effectiveKey,
        title,
      });
    } else if (!meta?.mastery_path_id) {
      dispatch({ type: "BUMP_SIDEBAR_REFRESH" });
    }
    return;
  }

  if (event.type === "done") {
    const status = String(
      (event.metadata as { status?: string } | undefined)?.status ||
        "completed",
    );
    const pendingSubmission = pendingSubmissionIdsRef.current.get(effectiveKey);
    const doneUserMessageId = (
      event.metadata as { user_message_id?: number | string | null } | undefined
    )?.user_message_id;
    if (pendingSubmission && doneUserMessageId != null) {
      clearFailedSubmission(
        pendingSubmission.storageKey,
        pendingSubmission.submissionId,
      );
      if (pendingSubmission.sourceStorageKey) {
        clearFailedSubmission(
          pendingSubmission.sourceStorageKey,
          pendingSubmission.submissionId,
        );
      }
    }
    pendingSubmissionIdsRef.current.delete(effectiveKey);
    dispatch({
      type: "STREAM_END",
      key: effectiveKey,
      status: (status as SessionRuntimeStatus) || "completed",
      turnId: event.turn_id || null,
    });
    pendingRegenerateRef.current.delete(effectiveKey);
    pendingResendRef.current.delete(effectiveKey);
    const activeRunner = runnersRef.current.get(effectiveKey);
    if (activeRunner) {
      runnersRef.current.delete(effectiveKey);
      window.setTimeout(() => {
        activeRunner.client.disconnect();
      }, POST_DONE_DISCONNECT_DELAY_MS);
    }
    window.setTimeout(() => {
      dispatch({ type: "BUMP_SIDEBAR_REFRESH" });
    }, POST_DONE_TITLE_REFRESH_MS);

    const doneMeta = event.metadata as {
      user_message_id?: number;
      assistant_message_id?: number;
    } | null;
    const userMessageId = doneMeta?.user_message_id ?? null;
    const assistantMessageId = doneMeta?.assistant_message_id ?? null;
    if (assistantMessageId != null || userMessageId != null) {
      dispatch({
        type: "RECONCILE_TURN",
        key: effectiveKey,
        turnId: event.turn_id || null,
        userMessageId,
        assistantMessageId,
      });
      if (assistantMessageId != null) {
        dispatch({
          type: "SETTLE_MESSAGE_TRACE",
          key: effectiveKey,
          messageId: assistantMessageId,
          turnId: event.turn_id || null,
        });
      }
    } else if (status === "completed") {
      const finishedSession = stateRef.current.sessions[effectiveKey];
      const sessionId = finishedSession?.sessionId;
      if (sessionId) {
        loadSessionRef.current?.(sessionId).catch(() => {
          /* non-fatal — local state remains usable */
        });
      }
    }
    return;
  }

  const terminalError =
    event.type === "error" &&
    Boolean(
      (event.metadata as { turn_terminal?: boolean } | undefined)?.turn_terminal,
    );
  const reason = terminalError
    ? String((event.metadata as { reason?: string } | undefined)?.reason || "")
    : "";
  const submissionNoLlmAccess = reason === NO_LLM_ACCESS;
  const pendingSubmission = pendingSubmissionIdsRef.current.get(effectiveKey);
  const submissionRejected = REJECTED_REASONS.has(reason);

  if (!submissionRejected) {
    dispatch({ type: "STREAM_EVENT", key: effectiveKey, event });
  } else if (submissionNoLlmAccess && pendingSubmission) {
    const { storageKey, sourceStorageKey, submissionId } = pendingSubmission;
    markFailedSubmissionNoLlmAccess(storageKey, submissionId);
    if (sourceStorageKey) {
      markFailedSubmissionNoLlmAccess(sourceStorageKey, submissionId);
    }
  } else {
    notify(event.content, { tone: "error", durationMs: 10_000 });
  }

  if (terminalError) {
    if (
      reason === "regenerate_busy" ||
      reason === "regenerate_rejected" ||
      reason === "nothing_to_regenerate" ||
      reason === "start_turn_rejected" ||
      submissionNoLlmAccess
    ) {
      const stash =
        pendingRegenerateRef.current.get(effectiveKey) ??
        pendingResendRef.current.get(effectiveKey);
      if (stash) {
        dispatch({
          type: "RESTORE_ASSISTANT",
          key: effectiveKey,
          message: stash,
        });
      }
    }
    pendingRegenerateRef.current.delete(effectiveKey);
    pendingResendRef.current.delete(effectiveKey);
    pendingSubmissionIdsRef.current.delete(effectiveKey);
    const status = String(
      (event.metadata as { status?: string } | undefined)?.status || "failed",
    );
    dispatch({
      type: "STREAM_END",
      key: effectiveKey,
      status: status as SessionRuntimeStatus,
      turnId: event.turn_id || null,
      submissionFailed: submissionRejected,
      errorMessage: submissionRejected ? event.content : undefined,
      submissionNoLlmAccess,
    });
  }
}
