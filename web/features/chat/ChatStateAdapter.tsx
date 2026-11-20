"use client";

import { supportsSubmissionReplacement } from "@/lib/session-api";
import { activeWorkspaceId } from "@/lib/workspace-scope";
import {
  clearFailedSubmission,
  readFailedSubmissions,
  serverContainsFailedSubmission,
  storeFailedSubmission,
} from "@/lib/failed-submissions";
import { randomUuid } from "@/lib/random-uuid";
import { newCommandId } from "@/contracts/parse/turn-command";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ClientCommand } from "@/contracts/generated/turn-protocol";
import {
  readStoredChatResponseTimeout,
  writeStoredActiveSessionId,
} from "@/context/app-shell-storage";
import type {
  StreamEvent,
  ChatMessage,
  LLMSelection,
} from "@/features/chat/model/protocol";
import { UnifiedTurnClient } from "@/features/chat/transport/UnifiedTurnClient";
import { buildStartTurnInput } from "@/features/chat/controllers/buildStartTurnInput";
import { notifySessionsChanged } from "@/lib/session-events";
import {
  getSession,
  replaceSubmission,
  getMessageTrace,
  deleteMessage,
  updateBranchSelection,
  updateSessionTitle,
  type MessageTracePage,
  type SessionMessage,
  type DeleteMessageResult,
} from "@/lib/session-api";
import {
  TraceCache,
  compactTracePreview,
  type MessageTraceMetadata,
} from "@/features/chat/trace/memory";
import {
  buildVisiblePath,
  persistedBranchSelections,
  selectChildBranch,
  tipMessageId,
} from "@/lib/message-branches";
import { nextOptimisticId, resolvePersistedMessage } from "@/lib/optimistic-id";
import { recoveryPrincipal, RECOVERY_PRINCIPAL_CHANGED } from "@/lib/recovery-principal";
import {
  SUBMIT_CONNECT_RETRY_INTERVAL_MS,
  SUBMIT_CONNECT_RETRY_LIMIT,
} from "@/lib/send-retry";
import { decideFailedTurnReplay, isFailedTurnVisible } from "@/lib/chat-resend";
import { hasPendingAskUserInMessages, pendingAskUserKeyInMessages } from "@/lib/ask-user-state";
import { notify } from "@/lib/notifications";
import {
  readingTurnFields,
} from "@/lib/reading-turn-state";
import {
  decideIdleTurnRecovery,
  resolveLoadedRunStatus,
} from "@/lib/chat-idle-recovery";
import { normalizeBookReferences } from "@/lib/book-references";
import { normalizeWorkspaceMode } from "@/lib/workspace-mode";
import { normalizeReadingReferences } from "@/lib/reading-references";

import {
  POST_DONE_TITLE_REFRESH_MS,
  emptyResourceSelection,
  type ChatContextValue,
  type ChatState,
  type HistoryReferencePayload,
  type MemoryReferencePayload,
  type MessageAttachment,
  type MessageItem,
  type MessageRequestSnapshot,
  type NotebookReferencePayload,
  type OutgoingAttachment,
  type ProviderState,
  type QuestionNotebookReferencePayload,
  type QueuedMessage,
  type ReadingSelectionSnapshot,
  type ResourceSelection,
  type SendMessageOptions,
  type SessionConfiguration,
  type SessionRuntimeStatus,
  type SessionStatusSnapshot,
} from "./state/types";
import {
  asLLMSelection,
  asStringArray,
  hydrateMessageAttachments,
  hydrateSessionMessages,
  normalizeSelectedBranches,
  sanitizeOutgoingLLMSelection,
} from "./state/hydration";
import {
  createSessionEntry,
  draftFailedSubmissionKey,
  ensureSelectedSession,
  initialState,
  readUserInputIds,
  reducer,
  restoredFailedMessage,
  withCurrentGenerationSettings,
} from "./state/reducer";
import {
  processRunnerEvent,
  type PendingSubmissionEntry,
  type RunnerRecord,
} from "./state/transport";

export {
  emptyResourceSelection,
  readUserInputIds,
  hydrateMessageAttachments,
  asLLMSelection,
  sanitizeOutgoingLLMSelection,
};
export type {
  SendMessageOptions,
  ResourceSelection,
  QueuedMessage,
  ChatState,
  SessionConfiguration,
  MessageAttachment,
  MessageRequestSnapshot,
  ReadingSelectionSnapshot,
  MessageItem,
} from "./state/types";

const ChatCtx = createContext<ChatContextValue | null>(null);

export function ChatStateAdapterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(initialState);
  const runtimeGeneration = useRef(0);
  const runnersRef = useRef<Map<string, RunnerRecord>>(new Map());
  const draftCounterRef = useRef(0);
  const retryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Tracks in-flight regenerate requests so we can restore the popped
  // assistant message if the server rejects the request (e.g. ``regenerate_busy``
  // or ``nothing_to_regenerate``). Keyed by session entry key.
  const pendingRegenerateRef = useRef<Map<string, MessageItem>>(new Map());
  const pendingResendRef = useRef<Map<string, MessageItem>>(new Map());
  const pendingSubmissionIdsRef = useRef<Map<string, PendingSubmissionEntry>>(new Map());
  const resolvingResendRef = useRef<Set<string>>(new Set());
  // Parked (``waiting_input``) turns already resubscribed to on load, keyed
  // ``<sessionKey>:<turnId>``. A parked turn keeps the conversation's lease
  // while it waits, and its ask_user card exists only in the live event
  // stream (no assistant row is persisted until the turn settles), so opening
  // the conversation must replay that stream or the card is unreachable.
  const resumedParkedTurnsRef = useRef<Set<string>>(new Set());
  const traceCacheRef = useRef<TraceCache>(new TraceCache());
  const traceRequestsRef = useRef<Map<string, AbortController>>(new Map());
  // Forward-declared so ``handleRunnerEvent`` (created above
  // ``loadSession`` in source order) can trigger a server refresh after
  // a turn finishes without taking a stale closure of ``loadSession``.
  const loadSessionRef = useRef<
    ((sessionId: string) => Promise<MessageItem[] | undefined>) | null
  >(null);
  const principalRef = useRef(recoveryPrincipal());
  const principalResolvedRef = useRef(principalRef.current !== null);

  useEffect(() => {
    const onPrincipalChanged = () => {
      const principal = recoveryPrincipal();
      if (principal === principalRef.current) return;
      const firstResolution = !principalResolvedRef.current && principalRef.current === null;
      principalRef.current = principal;
      if (principal !== null) principalResolvedRef.current = true;
      if (!firstResolution) {
        runtimeGeneration.current += 1;
        runnersRef.current.forEach(({ client }) => client.disconnect());
        runnersRef.current.clear();
        retryTimersRef.current.forEach(clearTimeout);
        retryTimersRef.current.clear();
        traceRequestsRef.current.forEach((controller) => controller.abort());
        traceRequestsRef.current.clear();
        traceCacheRef.current.clear();
        pendingSubmissionIdsRef.current.clear();
        pendingRegenerateRef.current.clear();
        pendingResendRef.current.clear();
        resolvingResendRef.current.clear();
        resumedParkedTurnsRef.current.clear();
        stateRef.current = initialState;
        dispatch({ type: "RESET_ACCOUNT" });
        writeStoredActiveSessionId(null);
      }
      dispatch({ type: "ENSURE_DRAFT_SESSION", key: `draft_${Date.now()}_${++draftCounterRef.current}`,
        failedRecords: readFailedSubmissions(draftFailedSubmissionKey()) });
    };
    window.addEventListener(RECOVERY_PRINCIPAL_CHANGED, onPrincipalChanged);
    onPrincipalChanged();
    return () => window.removeEventListener(RECOVERY_PRINCIPAL_CHANGED, onPrincipalChanged);
  }, []);

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!state.selectedKey) return;
    for (const [key, controller] of traceRequestsRef.current) {
      if (key.startsWith(`${state.selectedKey}:`)) continue;
      controller.abort();
      traceRequestsRef.current.delete(key);
    }
    const released = traceCacheRef.current.releaseExcept(state.selectedKey);
    for (const [key, snapshot] of released) {
      const [sessionId, messageId] = key.split(":");
      dispatch({
        type: "SET_MESSAGE_TRACE",
        key: sessionId,
        messageId: Number(messageId),
        events: snapshot.events,
        trace: snapshot.metadata ?? {},
      });
    }
  }, [state.selectedKey]);

  useEffect(
    () => () => {
      runtimeGeneration.current += 1;
      runnersRef.current.forEach(({ client }) => client.disconnect());
      runnersRef.current.clear();
      retryTimersRef.current.forEach((id) => clearTimeout(id));
      retryTimersRef.current.clear();
      traceRequestsRef.current.forEach((controller) => controller.abort());
      traceRequestsRef.current.clear();
    },
    [],
  );

  const makeDraftKey = useCallback(() => {
    draftCounterRef.current += 1;
    return `draft_${Date.now()}_${draftCounterRef.current}`;
  }, []);

  const hydrateMessages = useCallback(
    (messages: SessionMessage[]): MessageItem[] => hydrateSessionMessages(messages),
    [],
  );

  const moveRunner = useCallback((oldKey: string, newKey: string) => {
    if (oldKey === newKey) return;
    const runner = runnersRef.current.get(oldKey);
    if (!runner) return;
    runnersRef.current.delete(oldKey);
    runner.key = newKey;
    runnersRef.current.set(newKey, runner);
  }, []);

  const handleRunnerEvent = useCallback(
    (runnerKey: string, event: StreamEvent) => {
      processRunnerEvent(
        {
          runnersRef,
          stateRef,
          pendingSubmissionIdsRef,
          pendingRegenerateRef,
          pendingResendRef,
          loadSessionRef,
          dispatch,
          moveRunner,
        },
        runnerKey,
        event,
      );
    },
    [moveRunner],
  );

  const ensureRunner = useCallback(
    (key: string) => {
      const existing = runnersRef.current.get(key);
      if (existing) {
        const session = stateRef.current.sessions[key];
        if (session) {
          existing.client.setResumeState(session.activeTurnId, session.lastSeq);
        }
        if (!existing.client.connected) existing.client.connect();
        return existing;
      }
      const generation = runtimeGeneration.current;
      const record: {
        key: string;
        client: UnifiedTurnClient;
        replyCommand?: { fingerprint: string; commandId: string };
      } = {
        key,
        client: new UnifiedTurnClient(
          (event) => {
            if (generation === runtimeGeneration.current) handleRunnerEvent(record.key, event);
          },
          () => {
            if (generation !== runtimeGeneration.current) return;
            const session = stateRef.current.sessions[record.key];
            if (session?.isStreaming) {
              if (
                hasPendingAskUserInMessages(
                  session.messages,
                  session.activeTurnId,
                )
              ) {
                return;
              }
              dispatch({
                type: "STREAM_END",
                key: record.key,
                status: "failed",
                errorMessage: "Connection lost while generating. Please retry your message.",
              });
              // Surface the disconnect to the user. The WS client already
              // logs to console — we add a toast so non-debugging users
              // don't see streaming silently flatline.
              notify(
                "Connection lost while generating. Please retry your message.",
                {
                  tone: "error",
                  durationMs: 6000,
                },
              );
            }
          },
        ),
      };
      runnersRef.current.set(key, record);
      const session = stateRef.current.sessions[key];
      if (session?.activeTurnId) {
        record.client.setResumeState(session.activeTurnId, session.lastSeq);
      }
      record.client.connect();
      return record;
    },
    [handleRunnerEvent],
  );

  const sendThroughRunner = useCallback(
    function dispatchToRunner(
      key: string,
      msg: ChatMessage | ClientCommand,
      options: { awaitAck?: boolean; attempt?: number } = {},
    ): Promise<boolean> {
      const attempt = options.attempt ?? 0;
      if (attempt > 0 && !stateRef.current.sessions[key]?.isStreaming) {
        return Promise.resolve(false);
      }
      const runner = ensureRunner(key);
      // The transport owns reconnection and queues durable replies. Local
      // connection retries must not end this already-running turn (#1648).
      if (options.awaitAck) {
        return runner.client.sendAwaitingAck(msg as ClientCommand);
      }
      if (!runner.client.connected) {
        if (attempt >= SUBMIT_CONNECT_RETRY_LIMIT) {
          console.error("WebSocket failed to connect after retries");
          dispatch({
            type: "STREAM_END",
            key,
            status: "failed",
            errorMessage: "Couldn't reach the server. Please check your connection and retry.",
            // The start_turn command never left this tab — mark the turn
            // as an unsent submission rather than a failed assistant
            // reply (#1594).
            submissionFailed: true,
          });
          // Surfaces the dead-after-N-retries case (different code path
          // from the close-while-streaming handler above). Same user
          // mental model, so same toast copy.
          notify(
            "Couldn't reach the server. Please check your connection and retry.",
            {
              tone: "error",
              durationMs: 6000,
            },
          );
          return Promise.resolve(false);
        }
        return new Promise<boolean>((resolve) => {
          const timerId = setTimeout(() => {
            retryTimersRef.current.delete(timerId);
            resolve(
              dispatchToRunner(key, msg, { ...options, attempt: attempt + 1 }),
            );
          }, SUBMIT_CONNECT_RETRY_INTERVAL_MS);
          retryTimersRef.current.add(timerId);
        });
      }
      runner.client.send(msg);
      return Promise.resolve(true);
    },
    [ensureRunner],
  );

  /** Select a session we already hold in memory, if we do.
   *
   *  Lets a caller paint a previously-opened conversation immediately and
   *  refresh it in the background (``loadSession`` with ``revalidate``),
   *  rather than blanking the view behind a spinner for a round-trip whose
   *  result it usually already has. */
  const showCachedSession = useCallback((sessionId: string) => {
    const cached = stateRef.current.sessions[sessionId];
    if (!cached?.messages.length) return false;
    dispatch({ type: "SELECT_SESSION", key: sessionId });
    return true;
  }, []);

  const releaseMessageTrace = useCallback((sessionId: string, messageId: number) => {
    const key = `${sessionId}:${messageId}`;
    traceRequestsRef.current.get(key)?.abort();
    traceRequestsRef.current.delete(key);
    const preview = traceCacheRef.current.release(key);
    if (!preview) return;
    dispatch({
      type: "SET_MESSAGE_TRACE",
      key: sessionId,
      messageId,
      events: preview.events,
      trace: preview.metadata ?? {},
    });
  }, []);

  const loadMessageTrace = useCallback(
    async (sessionId: string, messageId: number) => {
      const key = `${sessionId}:${messageId}`;
      if (traceCacheRef.current.has(key) || traceRequestsRef.current.has(key)) return;
      const session = stateRef.current.sessions[sessionId];
      if (!session || session.isStreaming || session.status === "running") return;
      const message = session.messages.find(
        (item) => item.id === messageId && item.role === "assistant",
      );
      if (!message?.trace?.turn_id) return;
      // Already holding the whole thing — the turn that just finished keeps
      // its events. Fetching would replace them with an identical list and
      // repaint the trace for nothing.
      if (
        !message.trace.truncated &&
        (message.events?.length ?? 0) >= (message.trace.total ?? 0)
      ) {
        return;
      }

      const controller = new AbortController();
      traceRequestsRef.current.set(key, controller);
      try {
        const events: StreamEvent[] = [];
        let afterSeq = 0;
        let page: MessageTracePage | null = null;
        for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
          page = await getMessageTrace(
            sessionId,
            messageId,
            afterSeq,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          events.push(...page.events);
          if (page.complete || page.next_seq == null) break;
          if (page.next_seq <= afterSeq) return;
          afterSeq = page.next_seq;
        }
        if (!page || controller.signal.aborted) return;
        const metadata: MessageTraceMetadata = {
          turn_id: page.turn_id,
          total: page.total,
          last_seq: page.last_seq,
          truncated: false,
          // The turn's span is measured over the whole stream and the trace
          // pages do not carry it, so dropping it here left the duration to be
          // re-derived from whatever events came back — and a turn that read
          // "11s" while collapsed read "12s" the moment it was opened.
          ...(typeof message.trace.started_at === "number"
            ? { started_at: message.trace.started_at }
            : {}),
          ...(typeof message.trace.ended_at === "number"
            ? { ended_at: message.trace.ended_at }
            : {}),
        };
        const preview = compactTracePreview(message.events ?? []);
        const evicted = traceCacheRef.current.retain(key, {
          events: preview.events,
          metadata: message.trace,
        });
        for (const [evictedKey, snapshot] of evicted) {
          const [evictedSession, evictedMessage] = evictedKey.split(":");
          dispatch({
            type: "SET_MESSAGE_TRACE",
            key: evictedSession,
            messageId: Number(evictedMessage),
            events: snapshot.events,
            trace: snapshot.metadata ?? {},
          });
        }
        dispatch({
          type: "SET_MESSAGE_TRACE",
          key: sessionId,
          messageId,
          events,
          trace: metadata,
        });
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          console.warn("Failed to load message trace", reason);
        }
      } finally {
        if (traceRequestsRef.current.get(key) === controller) {
          traceRequestsRef.current.delete(key);
        }
      }
    },
    [],
  );

  const loadSession = useCallback(
    async (
      sessionId: string,
      options?: { signal?: AbortSignal; revalidate?: boolean },
    ) => {
      const generation = runtimeGeneration.current;
      const session = await getSession(sessionId, options?.signal);
      if (options?.signal?.aborted || generation !== runtimeGeneration.current) return;
      const key = session.session_id || session.id;
      const activeTurn = Array.isArray(session.active_turns)
        ? session.active_turns[0]
        : undefined;
      if (options?.revalidate) {
        // Background refresh of a session already on screen. Drop the whole
        // snapshot — data *and* the re-subscribe below — once a turn is live
        // locally: this tab is already receiving that turn's events, so
        // re-subscribing from ``after_seq: 0`` would replay them on top of
        // what we have, and the snapshot predates the turn anyway.
        const local = stateRef.current.sessions[key];
        if (!local || local.isStreaming || local.status === "running") return;
      }
      // Other conversations' opened traces go back to their previews, as on
      // any switch; this one's are moot, its messages are read afresh below.
      // Clearing outright left those traces whole in memory for good.
      for (const [cacheKey, snapshot] of traceCacheRef.current.releaseExcept(key)) {
        const [sessionId, messageId] = cacheKey.split(":");
        dispatch({
          type: "SET_MESSAGE_TRACE",
          key: sessionId,
          messageId: Number(messageId),
          events: snapshot.events,
          trace: snapshot.metadata ?? {},
        });
      }
      traceCacheRef.current.clear();
      const messages = hydrateMessages(session.messages ?? []);
      const loadedWorkspaceMode = normalizeWorkspaceMode(
        session.preferences?.workspace_mode,
        session.preferences?.capability,
      );
      // A stored `running` is only believable while it is recent — see
      // `resolveLoadedRunStatus`. A turn the backend never got to close out
      // (crash, restart) would otherwise open the conversation into a
      // permanent "answering" state: Stop instead of Send, with no stream to
      // stop and no way back except starting a new conversation.
      const loadedStatus = resolveLoadedRunStatus(
        (session.status as SessionRuntimeStatus | undefined) ||
          (activeTurn ? "running" : "idle"),
        Number(session.updated_at) > 0 ? Number(session.updated_at) * 1000 : 0,
        Date.now(),
        readStoredChatResponseTimeout() * 1000,
      );
      // Restore every pending submission. A matching client_submission_id on
      // a persisted user row is the only evidence that this particular send
      // was accepted; equal text from another tab is not enough.
      let restoredMessages = messages;
      let restoredStatus = loadedStatus;
      const pendingRecords = readFailedSubmissions(key).filter(record => {
        if (!serverContainsFailedSubmission(session.messages ?? [], record)) return true;
        clearFailedSubmission(key, record.submissionId);
        return false;
      });
      // A background refresh must reconcile pending records exactly like a
      // foreground load; otherwise they vanish until the next full reload.
      if (loadedStatus !== "running") {
        for (const failedRecord of pendingRecords) {
          restoredMessages = [
            ...restoredMessages,
            restoredFailedMessage(
              failedRecord,
              tipMessageId(buildVisiblePath(
                restoredMessages,
                normalizeSelectedBranches(session.preferences?.selected_branches),
              ).messages),
            ),
          ];
          restoredStatus = "failed";
        }
      }
      if (loadedStatus !== "running") {
        for (const local of stateRef.current.sessions[key]?.messages ?? []) {
          if (!local.failedSubmission || !local.failedSubmissionNotSaved ||
              !local.failedSubmissionId ||
              serverContainsFailedSubmission(session.messages ?? [], { submissionId: local.failedSubmissionId }) ||
              restoredMessages.some(message => message.failedSubmissionId === local.failedSubmissionId)) continue;
          restoredMessages = [...restoredMessages, {
            ...local,
            parentMessageId: tipMessageId(buildVisiblePath(
              restoredMessages,
              normalizeSelectedBranches(session.preferences?.selected_branches),
            ).messages),
          }];
          restoredStatus = "failed";
        }
      }
      dispatch({
        type: options?.revalidate ? "REVALIDATE_SESSION" : "LOAD_SESSION",
        key,
        sessionId: key,
        title: session.title || "",
        messages: restoredMessages,
        activeTurnId: activeTurn?.turn_id || activeTurn?.id || null,
        status: restoredStatus,
        serverStatus: loadedStatus,
        tools: Array.isArray(session.preferences?.tools)
          ? session.preferences.tools
          : [],
        // Old sessions stored Reading/Mastery as the capability itself. Once
        // promoted to a workspace mode, that value means the default Chat
        // action rather than a hidden legacy entry in the action picker.
        capability:
          session.preferences?.capability === loadedWorkspaceMode
            ? null
            : session.preferences?.capability || null,
        workspaceMode: loadedWorkspaceMode,
        knowledgeBases: Array.isArray(session.preferences?.knowledge_bases)
          ? session.preferences.knowledge_bases
          : [],
        llmSelection: asLLMSelection(session.preferences?.llm_selection),
        masteryPathId:
          typeof session.preferences?.mastery_path_id === "string"
            ? session.preferences.mastery_path_id
            : null,
        masterySessionMode:
          typeof session.preferences?.mastery_session_mode === "string"
            ? session.preferences.mastery_session_mode
            : null,
        noteDocumentId:
          typeof session.preferences?.note_document_id === "string"
            ? session.preferences.note_document_id || null
            : null,
        createTarget:
          typeof session.preferences?.create_target === "string"
            ? session.preferences.create_target || null
            : null,
        workspaceId: session.preferences?.workspace_id || null,
        personaSelection:
          typeof session.preferences?.persona === "string"
            ? session.preferences.persona
            : "",
        answerBy:
          typeof session.preferences?.answer_by === "string" && session.preferences.answer_by
            ? session.preferences.answer_by
            : null,
        resourceSelection: {
          skills: asStringArray(session.preferences?.skills),
          mcp: asStringArray(session.preferences?.mcp),
        },
        // English is the only conversation language.
        language: "en",
        selectedBranches: normalizeSelectedBranches(
          session.preferences?.selected_branches,
        ),
      });
      const activeTurnId = activeTurn?.turn_id || activeTurn?.id || "";
      if (activeTurnId && loadedStatus === "running") {
        // Reached on a revalidate too, when the turn is live on the server but
        // not in this tab (started in another tab, or our socket dropped) —
        // that is exactly the case that still needs a subscribe. A turn we
        // just judged stale is not one of them: subscribing would open a
        // socket for a turn that will never speak again.
        sendThroughRunner(key, {
          type: "subscribe_turn",
          turn_id: activeTurnId,
          after_seq: 0,
        });
      } else if (activeTurnId && String(session.status || "") === "waiting_input") {
        // A parked turn still owns the conversation's lease, and its ask_user
        // card only lives in the live event stream: nothing about the pause is
        // persisted as a message until the turn settles. Without a
        // resubscribe, a reload loses the card while the turn keeps waiting —
        // the user can neither answer nor send, and only a backend restart
        // recovers the conversation. Send through the client's durable queue
        // rather than ``sendThroughRunner``: its retry gate drops a command
        // for a session that is not streaming, and a parked turn is exactly
        // that. Once per turn per tab is enough; the reducer de-duplicates a
        // replayed stream anyway.
        const resumeKey = `${key}:${activeTurnId}`;
        if (!resumedParkedTurnsRef.current.has(resumeKey)) {
          resumedParkedTurnsRef.current.add(resumeKey);
          ensureRunner(key).client.send({
            type: "subscribe_turn",
            turn_id: activeTurnId,
            after_seq: 0,
          });
        }
      }
      return messages;
    },
    [ensureRunner, hydrateMessages, sendThroughRunner],
  );

  useLayoutEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = state.selectedKey
      ? state.sessions[state.selectedKey]
      : null;
    writeStoredActiveSessionId(current?.sessionId ?? null);
  }, [state.selectedKey, state.sessions]);

  // URL is now the source of truth for session loading.
  // Initialize a draft session, restoring first-message failures before a
  // server session ID exists. A page with a URL-selected session still wins.
  //
  // React flushes a child's effects before its parent's, so any page under
  // this provider has already picked and configured its session by the time
  // this runs — a plain NEW_SESSION here would throw that away (it is what
  // used to silently drop ``/chat?capability=…&mastery_path_id=…``). The
  // reducer decides on live state; this only supplies the key it may need.
  useEffect(() => {
    if (typeof window === "undefined") return;
    dispatch({
      type: "ENSURE_DRAFT_SESSION",
      key: makeDraftKey(),
      failedRecords: readFailedSubmissions(draftFailedSubmissionKey()),
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Idle recovery: if a streaming session receives no events for the
  // configured window (default 180s, set in Settings > Network), re-subscribe
  // from the last sequence. A quiet stream is not terminal: long research
  // calls can emit nothing for minutes, while a dropped browser connection
  // leaves the backend turn alive with replayable events.
  useEffect(() => {
    const CHECK_INTERVAL_MS = 10_000;

    const timer = setInterval(() => {
      const timeoutSeconds = readStoredChatResponseTimeout();
      const idleTimeoutMs = timeoutSeconds * 1000;
      const current = stateRef.current;
      for (const [key, session] of Object.entries(current.sessions)) {
        const decision = decideIdleTurnRecovery({
          isStreaming: session.isStreaming,
          hasPendingUserInput: hasPendingAskUserInMessages(
            session.messages,
            session.activeTurnId,
          ),
          activeTurnId: session.activeTurnId,
          lastSeq: session.lastSeq,
          updatedAt: session.updatedAt,
          now: Date.now(),
          idleTimeoutMs,
        });
        if (decision.kind === "none") continue;

        if (decision.kind === "resubscribe") {
          // Avoid retrying on every watchdog tick while the re-subscription is
          // opening. The next event will replace this timestamp naturally.
          dispatch({ type: "STREAM_TOUCH", key });
          sendThroughRunner(key, decision.message);
          continue;
        }

        // A local timeout cannot invent a terminal state. Mark the session as
        // observed so the runtime/session reconciliation path can query the
        // authoritative turn once the server supplies its id.
        dispatch({ type: "STREAM_TOUCH", key });
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [sendThroughRunner]);

  const sendMessage = useCallback(
    async (
      content: string,
      attachments?: OutgoingAttachment[],
      config?: Record<string, unknown>,
      notebookReferences?: NotebookReferencePayload[],
      historyReferences?: HistoryReferencePayload,
      options?: SendMessageOptions,
      questionNotebookReferences?: QuestionNotebookReferencePayload,
      persona?: string,
      memoryReferences?: MemoryReferencePayload,
    ) => {
      const generation = runtimeGeneration.current;
      const msgAttachments = attachments?.map((a) => ({
        type: a.type,
        filename: a.filename,
        base64: a.base64,
        url: a.url,
        mime_type: a.mime_type,
      }));
      const currentState = stateRef.current;
      let key = currentState.selectedKey;
      if (!key) {
        key = makeDraftKey();
        dispatch({ type: "NEW_SESSION", key });
      }
      const session = currentState.sessions[key] ?? createSessionEntry(key);
      const replaySnapshot = options?.requestSnapshotOverride;
      const exactReplay = Boolean(replaySnapshot);
      const effectiveCapability =
        exactReplay ? (replaySnapshot?.capability ?? null) :
        replaySnapshot?.capability ??
        options?.capability ??
        session.activeCapability;
      const capabilityOnce = replaySnapshot
        ? replaySnapshot.capabilityOnce === true
        : Boolean(options?.capability);
      const effectiveWorkspaceMode =
        exactReplay ? (replaySnapshot?.workspaceMode ?? null) :
        replaySnapshot?.workspaceMode ?? session.workspaceMode;
      const effectiveTools =
        replaySnapshot?.enabledTools ?? session.enabledTools;
      const effectiveKnowledgeBases =
        replaySnapshot?.knowledgeBases ?? session.knowledgeBases;
      // #641: a reasoning-effort override the selected model does not
      // support (or that cannot be validated against the option catalog)
      // never reaches the provider — it is dropped from the outgoing
      // llm_selection, never from the persisted conversation selection.
      const effectiveLLMSelection = sanitizeOutgoingLLMSelection(
        exactReplay ? (replaySnapshot?.llmSelection ?? null) :
        replaySnapshot && "llmSelection" in replaySnapshot
          ? (replaySnapshot.llmSelection ?? null)
          : session.llmSelection,
      );
      const effectiveMasteryPathId =
        exactReplay ? (replaySnapshot?.masteryPathId ?? null) :
        replaySnapshot?.masteryPathId ?? session.masteryPathId;
      const effectiveMasterySessionMode =
        exactReplay ? (replaySnapshot?.masterySessionMode ?? null) :
        replaySnapshot?.masterySessionMode ?? session.masterySessionMode;
      const effectiveLanguage = "en";
      // Persona resolution: replay snapshot wins; then an explicit per-call
      // persona (quiz follow-up surface); then the session-level preference.
      // Always a string — "" means Default / no persona.
      const effectivePersona =
        exactReplay ? (replaySnapshot?.persona ?? "") :
        replaySnapshot?.persona ?? persona ?? session.personaSelection ?? "";
      // Replays retain the original resource selection, including one-turn choices.
      const effectiveResources =
        exactReplay ? (replaySnapshot?.resourceSelection ?? emptyResourceSelection()) :
        replaySnapshot?.resourceSelection ?? session.resourceSelection ?? emptyResourceSelection();
      // Create mode: a replay restates the exact kind it ran with (the chip
      // may have been removed, or the session moved on, since); a live turn
      // sends the session's current choice.
      const effectiveCreateTarget =
        exactReplay ? (replaySnapshot?.createTarget ?? null) :
        replaySnapshot?.createTarget ?? session.createTarget ?? null;
      const effectiveMemoryReferences =
        exactReplay ? replaySnapshot?.memoryReferences :
        replaySnapshot?.memoryReferences ?? memoryReferences;
      const effectiveBookReferences =
        exactReplay ? replaySnapshot?.bookReferences :
        replaySnapshot?.bookReferences ?? options?.bookReferences;
      const effectiveReadingReferences =
        exactReplay ? replaySnapshot?.readingReferences :
        replaySnapshot?.readingReferences ?? options?.readingReferences;
      const effectiveAttachments =
        replaySnapshot?.attachments?.map((a) => ({
          type: a.type,
          filename: a.filename,
          base64: a.base64,
          url: a.url,
          mime_type: a.mime_type,
        })) ?? (exactReplay ? undefined : msgAttachments);
      const effectiveConfig = exactReplay ? replaySnapshot?.config : config ?? replaySnapshot?.config;
      const effectiveNotebookReferences =
        exactReplay ? replaySnapshot?.notebookReferences :
        replaySnapshot?.notebookReferences ?? notebookReferences;
      const effectiveHistoryReferences =
        exactReplay ? replaySnapshot?.historyReferences :
        replaySnapshot?.historyReferences ?? historyReferences;
      const effectiveQuestionNotebookReferences =
        exactReplay ? replaySnapshot?.questionNotebookReferences :
        replaySnapshot?.questionNotebookReferences ??
        questionNotebookReferences;
      const liveReadingFields = exactReplay ? {} : readingTurnFields(effectiveWorkspaceMode);
      const replaySelection = replaySnapshot?.readingSelection;
      const effectiveReadingTurnFields = exactReplay
        ? (replaySnapshot?.readingTurnFields ?? (replaySnapshot?.readingMaterialId
          ? {
              reading_material_id: replaySnapshot.readingMaterialId,
              ...(replaySnapshot.readingMaterialRevision
                ? { reading_material_revision: replaySnapshot.readingMaterialRevision }
                : {}),
              ...(replaySelection
                ? { reading_viewport: { selection: replaySelection.quote,
                    locator: replaySelection.locator } }
                : {}),
            }
          : {}))
        : replaySnapshot?.readingMaterialId
        ? {
            reading_material_id: replaySnapshot.readingMaterialId,
            ...(replaySnapshot.readingMaterialRevision
              ? {
                  reading_material_revision:
                    replaySnapshot.readingMaterialRevision,
                }
              : {}),
            // A regenerate answers the same passage, not whatever the reader
            // happens to have selected now.
            ...(replaySelection
              ? {
                  reading_viewport: {
                    selection: replaySelection.quote,
                    ...(replaySelection.locator
                      ? { locator: replaySelection.locator }
                      : {}),
                  },
                }
              : {}),
          }
        : liveReadingFields;
      const liveViewport = liveReadingFields.reading_viewport;
      const effectiveReadingSelection: ReadingSelectionSnapshot | undefined =
        replaySelection ??
        (liveReadingFields.reading_material_id && liveViewport?.selection
          ? {
              quote: liveViewport.selection,
              locator: liveViewport.locator ?? 0,
            }
          : undefined);
      const effectiveReadingMaterialId =
        effectiveReadingTurnFields.reading_material_id;
      const effectiveReadingMaterialRevision =
        effectiveReadingTurnFields.reading_material_revision;
      const effectiveTimedMediaId = replaySnapshot?.timedMediaId;
      const effectiveWatchingTurnFields = replaySnapshot?.watchingTurnFields ??
        (effectiveTimedMediaId ? { timed_media_id: effectiveTimedMediaId } : {});
      // The bubble names who it was handed to, as the stored snapshot will.
      const snapshotConfig =
        session.answerBy && effectiveConfig?.answer_by === undefined
          ? { ...(effectiveConfig ?? {}), answer_by: session.answerBy }
          : effectiveConfig;
      const requestSnapshot: MessageRequestSnapshot = replaySnapshot ? { ...replaySnapshot } : {
        resourceSelection: {skills:[...effectiveResources.skills],mcp:[...effectiveResources.mcp]},
        content,
        capability: effectiveCapability,
        workspaceMode: effectiveWorkspaceMode,
        workspaceId: session.workspaceId ?? null,
        enabledTools: [...effectiveTools],
        knowledgeBases: [...effectiveKnowledgeBases],
        language: effectiveLanguage,
        ...(effectiveAttachments?.length
          ? { attachments: effectiveAttachments }
          : {}),
        ...(snapshotConfig && Object.keys(snapshotConfig).length > 0
          ? { config: snapshotConfig }
          : {}),
        ...(effectiveNotebookReferences?.length
          ? { notebookReferences: effectiveNotebookReferences }
          : {}),
        ...(effectiveHistoryReferences?.length
          ? { historyReferences: [...effectiveHistoryReferences] }
          : {}),
        ...(effectiveQuestionNotebookReferences?.length
          ? {
              questionNotebookReferences: [
                ...effectiveQuestionNotebookReferences,
              ],
            }
          : {}),
        ...(effectiveBookReferences?.length
          ? { bookReferences: effectiveBookReferences }
          : {}),
        ...(effectiveReadingReferences?.length
          ? { readingReferences: effectiveReadingReferences }
          : {}),
        ...(effectiveMasteryPathId
          ? { masteryPathId: effectiveMasteryPathId }
          : {}),
        ...(effectiveMasterySessionMode
          ? { masterySessionMode: effectiveMasterySessionMode }
          : {}),
        ...(options?.masteryAnswer ? { masteryAnswer: options.masteryAnswer } : {}),
        ...(options?.noteGeneration ? { noteGeneration: options.noteGeneration } : {}),
        ...(options?.masterySkip ? { masterySkip: options.masterySkip } : {}),
        ...(effectivePersona ? { persona: effectivePersona } : {}),
        ...(effectiveCreateTarget ? { createTarget: effectiveCreateTarget } : {}),
        ...(effectiveMemoryReferences?.length
          ? { memoryReferences: [...effectiveMemoryReferences] }
          : {}),
        ...(effectiveLLMSelection
          ? { llmSelection: effectiveLLMSelection }
          : {}),
        ...(effectiveReadingMaterialId
          ? { readingMaterialId: effectiveReadingMaterialId }
          : {}),
        ...(effectiveReadingMaterialId && effectiveReadingMaterialRevision
          ? { readingMaterialRevision: effectiveReadingMaterialRevision }
          : {}),
        ...(effectiveReadingSelection
          ? { readingSelection: effectiveReadingSelection }
          : {}),
        ...(Object.keys(effectiveReadingTurnFields).length
          ? { readingTurnFields: effectiveReadingTurnFields }
          : {}),
        ...(capabilityOnce ? { capabilityOnce: true } : {}),
        ...(effectiveTimedMediaId
          ? { timedMediaId: effectiveTimedMediaId }
          : {}),
        ...(Object.keys(effectiveWatchingTurnFields).length
          ? { watchingTurnFields: effectiveWatchingTurnFields }
          : {}),
      };
      // Default the new message's parent to the tip of the currently-
      // visible path so the local chat tree stays connected during
      // streaming. The wire-level ``parent_message_id`` is computed
      // separately further down: only persisted (positive) ids or an
      // explicit ``null`` (root edit) are sent — optimistic negative ids
      // would be meaningless to the server.
      const visible = buildVisiblePath(
        session.messages,
        session.selectedBranches,
      ).messages;
      const tipId = tipMessageId(visible);
      const localParentId =
        options?.parentMessageId !== undefined
          ? options.parentMessageId
          : tipId;
      const wireParentId: number | null | undefined =
        options?.parentMessageId !== undefined
          ? options.parentMessageId
          : tipId !== null && tipId > 0
            ? tipId
            : undefined;
      const trackNewSubmission =
        options?.displayUserMessage !== false &&
        !options?.masteryAnswer &&
        !options?.masterySkip &&
        (content.trim() !== "" || Boolean(effectiveAttachments?.length));
      const submissionId = options?.retrySubmissionId ??
        (trackNewSubmission ? randomUuid() : undefined);
      const persistSubmission = Boolean(submissionId) &&
        (trackNewSubmission || Boolean(options?.retrySubmissionId));
      const replacesSubmissionId = options?.replacesSubmissionId ?? replaySnapshot?.replacesSubmissionId;
      if (replacesSubmissionId && !(await supportsSubmissionReplacement())) return false;
      if (generation !== runtimeGeneration.current) return false;
      const showSubmission = () => {
        if (options?.displayUserMessage !== false) {
        dispatch({
          type: "ADD_USER_MSG",
          key,
          content,
          capability: effectiveCapability,
          attachments: effectiveAttachments,
          requestSnapshot,
          parentMessageId: localParentId,
          failedSubmissionId: submissionId,
        });
        }
        dispatch({
          type: "STREAM_START", key, startedAt: Date.now() / 1000,
          capability: effectiveCapability,
        });
      };
      const {
        _persist_user_message: legacyPersistUserMessage,
        followup_question_context: followupQuestionContext,
        selection_tutor_context: selectionTutorContext,
        subagent_consult_budget: subagentConsultBudget,
        consult_partner_id: consultPartnerId,
        partner_discussion_group_id: partnerDiscussionGroupId,
        answer_by: answerBy,
        auto_route: autoRoute,
        ...finalTurnConfig
      } = effectiveConfig ?? {};
      const persistUserMessage =
        options?.persistUserMessage === false ||
        legacyPersistUserMessage === false
          ? false
          : undefined;
      // Capture the complete command before persisting or displaying its snapshot.
      const submissionStorageKey = session.sessionId ?? draftFailedSubmissionKey();
      if (submissionId) {
        pendingSubmissionIdsRef.current.set(key, {
          storageKey: submissionStorageKey,
          submissionId,
          visibleSubmissionIds: [
            ...session.messages
              .map((message) => message.failedSubmissionId)
              .filter((id): id is string => Boolean(id)),
            submissionId,
          ],
        });
      }
      let command = buildStartTurnInput({
        content,
        clientSubmissionId: submissionId,
        tools: effectiveTools,
        capability: effectiveCapability,
        workspaceMode: effectiveWorkspaceMode ?? "",
        knowledgeBases: effectiveKnowledgeBases,
        skills: effectiveResources.skills,
        mcp: effectiveResources.mcp,
        sessionId: session.sessionId,
        // Existing sessions inherit server ownership; new drafts declare it once.
        ...(!session.sessionId ? {
          workspaceId: exactReplay
            ? (replaySnapshot?.workspaceId ?? null)
            : (session.workspaceId ?? null),
        } : {}),
        persistUserMessage,
        followupQuestionContext:
          followupQuestionContext && typeof followupQuestionContext === "object"
            ? (followupQuestionContext as Record<string, unknown>)
            : null,
        selectionTutorContext:
          selectionTutorContext && typeof selectionTutorContext === "object"
            ? (selectionTutorContext as Record<string, unknown>)
            : null,
        consultPartnerId: typeof consultPartnerId === "string" ? consultPartnerId : null,
        partnerDiscussionGroupId: typeof partnerDiscussionGroupId === "string" ? partnerDiscussionGroupId : null,
        // A replay restates the answerer it ran with; a new turn goes to
        // whoever this conversation is handed to now.
        answerBy: typeof answerBy === "string"
          ? answerBy
          : exactReplay ? null : session.answerBy,
        subagentConsultBudget:
          typeof subagentConsultBudget === "number"
            ? subagentConsultBudget
            : null,
        autoRoute: typeof autoRoute === "boolean" ? autoRoute : null,
        capabilityOnce,
        attachments: effectiveAttachments,
        language: effectiveLanguage,
        notebookReferences: effectiveNotebookReferences,
        historyReferences: effectiveHistoryReferences,
        questionNotebookReferences: effectiveQuestionNotebookReferences,
        bookReferences: effectiveBookReferences,
        readingReferences: effectiveReadingReferences,
        masteryPathId: effectiveMasteryPathId || null,
        masterySessionMode: effectiveMasterySessionMode || null,
        // A note companion's conversation stays bound to its page for every
        // turn, regenerations included: the binding is the session's, not the
        // request's.
        noteDocumentId: session.noteDocumentId || null,
        // Always sent, string or null — the wire contract for create mode.
        createTarget: effectiveCreateTarget,
        noteGeneration: options?.noteGeneration ?? replaySnapshot?.noteGeneration ?? null,
        masteryAnswer: options?.masteryAnswer ?? replaySnapshot?.masteryAnswer ?? null,
        masterySkip: options?.masterySkip ?? replaySnapshot?.masterySkip ?? null,
        // Immersive reading. Gated on the stable workspace mode as well as on
        // an open document: the reader outlives action switches and new
        // sessions, so Home must never inherit its source context.
        // Read from a module cell rather than context state so scrolling the
        // reader never re-renders the chat.
        readingWorkspaceId:
          effectiveReadingTurnFields.reading_workspace_id ?? null,
        readingMaterialId:
          effectiveReadingTurnFields.reading_material_id ?? null,
        readingMaterialRevision:
          effectiveReadingTurnFields.reading_material_revision ?? null,
        readingViewport: effectiveReadingTurnFields.reading_viewport ?? null,
        timedMediaId: effectiveTimedMediaId ?? null,
        timedMediaViewport: null,
        // Always sent (possibly ""): an explicit key is the backend's signal
        // to persist the value into session.preferences — "" clears back to
        // Default. Omitting the key would make the backend fall back to the
        // stored preference, so a clear could never propagate.
        persona: effectivePersona,
        memoryReferences: effectiveMemoryReferences,
        llmSelection: effectiveLLMSelection,
        capabilityConfig: finalTurnConfig,
        // Send ``parent_message_id`` only when we have a real (positive)
        // server id to chain under, or when the caller explicitly pinned
        // a parent (incl. ``null`` for editing the session's first
        // message). When the visible tip is still an optimistic
        // negative id, omit the key and let the backend auto-append to
        // the latest persisted row.
        parentMessageId: wireParentId,
        });
      const originalRequest = replaySnapshot?.submissionRequest;
      if (!replacesSubmissionId && submissionId &&
          originalRequest?.client_submission_id === submissionId) {
        // Only the assigned session can change; it is excluded from the
        // server's submission digest. Preserve even omitted/null fields.
        command = { ...originalRequest,
          session_id: session.sessionId ?? originalRequest.session_id,
        } as typeof command;
      }
      requestSnapshot.submissionRequest = { ...command };
      if (!replacesSubmissionId) showSubmission();
      // Persist before attempting the socket, including a first turn that
      // has no server session yet. Replays reuse their original identity.
      if (persistSubmission && submissionId && !replacesSubmissionId) {
        const saved = storeFailedSubmission(submissionStorageKey, {
          content, capability: effectiveCapability, requestSnapshot, submissionId,
        });
        dispatch({ type: "SET_SUBMISSION_PERSISTENCE", key, submissionId, saved: saved !== null });
        if (!saved) {
          notify("This unsent message could not be saved in your browser. Copy it before leaving this page.", { tone: "error", durationMs: 10_000 });
        }
      }
      if (replacesSubmissionId && submissionId) {
        command = (replaySnapshot?.replacementRequest ?? command) as typeof command;
        requestSnapshot.replacesSubmissionId = replacesSubmissionId;
        requestSnapshot.replacementRootSubmissionId = options?.replacementRootSubmissionId ??
          replaySnapshot?.replacementRootSubmissionId ?? replacesSubmissionId;
        requestSnapshot.replacementRequest = { ...command };
        // Save the edit and its identity before fencing the original. A lost
        // HTTP receipt then retries the same native reservation after reload.
        if (!storeFailedSubmission(submissionStorageKey, {
          content, capability: effectiveCapability, requestSnapshot, submissionId,
        })) return false;
        const durable = readFailedSubmissions(submissionStorageKey).find((record) => record.submissionId === submissionId);
        if (!durable || durable.retryRequiresReview || JSON.stringify(durable.requestSnapshot) !== JSON.stringify(requestSnapshot)) {
          notify("This unsent message could not be saved in your browser. Copy it before leaving this page.", { tone: "error" });
          return false;
        }
        try {
          const receipt = await replaceSubmission(replacesSubmissionId, { ...command });
          if (generation !== runtimeGeneration.current) return true;
          command.session_id = receipt.session_id;
          // The server receipt, not transcript absence, authorizes retirement
          // of the superseded local copy. The new durable record already exists.
          clearFailedSubmission(submissionStorageKey, replacesSubmissionId);
          if (options?.replacedMessageId != null) {
            const replaced = session.messages.find((message) => message.id === options.replacedMessageId);
            if (replaced?.failedSubmissionId) dispatch({ type: "DISCARD_FAILED_SUBMISSION", key,
              messageId: options.replacedMessageId, submissionId: replaced.failedSubmissionId });
          }
          showSubmission();
          // HTTP acknowledged native admission. Subscribe/replay the same
          // turn; never send another start command for this edit.
          ensureRunner(key).client.send({ type: "subscribe_turn", turn_id: receipt.turn.id, after_seq: 0 });
          return true;
        } catch {
          pendingSubmissionIdsRef.current.delete(key);
          return false;
        }
      }
      return sendThroughRunner(key, command);
    },
    [makeDraftKey, sendThroughRunner, ensureRunner],
  );

  const cancelStreamingTurn = useCallback(async () => {
    const generation = runtimeGeneration.current;
    const currentState = stateRef.current;
    const key = currentState.selectedKey;
    if (!key) return;
    const session = currentState.sessions[key];
    if (!session) return;
    const runner = runnersRef.current.get(key);
    if (runner) {
      notify("Cancelling…", { tone: "info" });
      try {
        if (!await runner.client.cancelCurrentTurn()) {
          notify("Couldn't reach the server. Please check your connection and retry.", { tone: "error" });
          return;
        }
        if (generation !== runtimeGeneration.current) return;
      } catch {
        notify("Couldn't reach the server. Please check your connection and retry.", { tone: "error" });
        return;
      }
      runner.client.disconnect();
      runnersRef.current.delete(runner.key);
    }
    // Admission may have moved the draft while Stop was waiting.
    const stoppedKey = runner?.key ?? key;
    const stoppedSession = stateRef.current.sessions[stoppedKey] ?? session;
    const turnId = stoppedSession.activeTurnId;
    if (stoppedSession.isStreaming) {
      // Stop is not proof that the server accepted the user row. In
      // particular, before a turn ID exists another tab may have stored a
      // newer attempt with this same logical submission ID. Keep the record
      // until a server transcript or DONE proves acceptance.
      const pendingSubmission = pendingSubmissionIdsRef.current.get(stoppedKey);
      if (pendingSubmission) pendingSubmissionIdsRef.current.delete(stoppedKey);
      dispatch({
        type: "STREAM_END", key: stoppedKey,
        status: pendingSubmission && !turnId ? "failed" : "cancelled",
        submissionFailed: Boolean(pendingSubmission && !turnId),
      });
    }
  }, []);

  const submitUserReply = useCallback(
    async (
      reply:
        | string
        | {
            text?: string;
            answers?: Array<{ questionId: string; text: string }>;
          },
    ): Promise<boolean> => {
      const currentState = stateRef.current;
      const key = currentState.selectedKey;
      if (!key) return false;
      const session = currentState.sessions[key];
      const turnId = session?.activeTurnId;
      const pendingAskUser = session
        ? hasPendingAskUserInMessages(session.messages, turnId)
        : false;
      // Only meaningful while a turn is live. A paused ask_user turn can be
      // silent long enough for the socket to reconnect, so allow submission
      // whenever the unresolved card and active turn id are still present.
      if (!session || !turnId || (!session.isStreaming && !pendingAskUser)) {
        return false;
      }
      const message: import("@/features/chat/model/protocol").SubmitUserReplyMessage =
        {
          type: "submit_user_reply",
          turn_id: turnId,
        };
      if (typeof reply === "string") {
        message.text = reply;
      } else {
        if (typeof reply.text === "string") message.text = reply.text;
        if (Array.isArray(reply.answers)) message.answers = reply.answers;
      }
      const runner = ensureRunner(key);
      const fingerprint = JSON.stringify([
        message, pendingAskUserKeyInMessages(session.messages, turnId),
      ]);
      // Retrying an unconfirmed answer reuses its idempotency key. The server
      // may already have accepted it even if its ACK was lost (#1648).
      const commandId = runner.replyCommand?.fingerprint === fingerprint
        ? runner.replyCommand.commandId
        : newCommandId();
      runner.replyCommand = { fingerprint, commandId };
      message.command_id = commandId;
      return sendThroughRunner(key, message, { awaitAck: true });
    },
    [ensureRunner, sendThroughRunner],
  );

  const regenerateLastMessage = useCallback((replaySnapshot = false) => {
    const currentState = stateRef.current;
    const key = currentState.selectedKey;
    if (!key) return;
    const session = currentState.sessions[key];
    if (!session || !session.sessionId) return;
    if (session.isStreaming) return;
    const lastUser = [...session.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUser) return;
    // Snapshot the trailing assistant (if any) so we can put it back when the
    // server rejects the request. We intentionally keep events/attachments so
    // the restored bubble round-trips identically.
    const lastMessage = session.messages[session.messages.length - 1];
    if (lastMessage && lastMessage.role === "assistant") {
      pendingRegenerateRef.current.set(key, { ...lastMessage });
    } else {
      pendingRegenerateRef.current.delete(key);
    }
    dispatch({ type: "POP_LAST_ASSISTANT", key });
    dispatch({
      type: "STREAM_START", key, startedAt: Date.now() / 1000,
      capability: lastUser.requestSnapshot?.capability ?? lastUser.capability ?? null,
    });
    sendThroughRunner(key, {
      type: "regenerate",
      session_id: session.sessionId,
      overrides: replaySnapshot
        ? {
            replay_snapshot: true,
            // The failed turn's context is replayed, but the model is the one
            // selected right now (#2105). The reasoning-effort override is
            // validated like a live send (#641): unsupported values are
            // omitted, not forwarded.
            llm_selection: sanitizeOutgoingLLMSelection(session.llmSelection),
            language: "en",
          }
        : { language: "en" },
    });
  }, [sendThroughRunner]);

  const resendLastMessage = useCallback(async () => {
    const currentState = stateRef.current;
    const key = currentState.selectedKey;
    if (!key) return;
    const session = currentState.sessions[key];
    if (!session) return;
    if (!isFailedTurnVisible(
      session.messages,
      session.selectedBranches,
      session.status,
      session.isStreaming,
    )) return;
    const lastUser = [...session.messages]
      .reverse()
      .find((m) => m.role === "user" && m.requestSnapshot);
    if (!lastUser?.requestSnapshot) return;
    // Retry the failed tail as a new turn, keeping the existing optimistic
    // user row visible. An unconfirmed submission is replayed with its own
    // parameters: the server may already hold that submission id, and a
    // changed request would no longer match it (#2105).
    const retryUnsavedTail = () => {
      const live = stateRef.current;
      const liveSession = live.sessions[key];
      if (
        live.selectedKey !== key ||
        !liveSession ||
        !isFailedTurnVisible(
          liveSession.messages,
          liveSession.selectedBranches,
          liveSession.status,
          liveSession.isStreaming,
        )
      ) return;
      const liveLastUser = [...liveSession.messages]
        .reverse()
        .find((message) => message.role === "user" && message.requestSnapshot);
      if (!liveLastUser?.requestSnapshot) return;
      const lastMessage =
        liveSession.messages[liveSession.messages.length - 1];
      if (lastMessage?.role === "assistant") {
        pendingResendRef.current.set(key, { ...lastMessage });
      }
      // Remove the trailing failed assistant bubble so the new turn's
      // STREAM_START placeholder replaces it rather than stacking below.
      dispatch({ type: "POP_LAST_ASSISTANT", key });
      const snapshot = liveLastUser.requestSnapshot;
      void sendMessage(
        snapshot.content,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          displayUserMessage: false,
          requestSnapshotOverride: snapshot,
          retrySubmissionId: liveLastUser.failedSubmissionId,
          parentMessageId:
            typeof liveLastUser.parentMessageId === "number" &&
            liveLastUser.parentMessageId <= 0
              ? undefined
              : liveLastUser.parentMessageId,
        },
      ).then((sent) => {
        if (sent) return;
        const stash = pendingResendRef.current.get(key);
        pendingResendRef.current.delete(key);
        // A submission failure settles the tail itself (pops the
        // placeholder, flags the user row) — restoring the stash then
        // would resurrect an empty assistant bubble (#1594).
        const tail = stateRef.current.sessions[key]?.messages.at(-1);
        if (!stash || tail?.role === "user") return;
        dispatch({ type: "RESTORE_ASSISTANT", key, message: stash });
      });
    };
    // A draft has no server session to reconcile against — nothing was
    // persisted, so retry directly (#1594).
    if (!session.sessionId) {
      retryUnsavedTail();
      return;
    }
    // A dropped socket can hide a successfully persisted user row before its
    // DONE ids reach this tab. Query the server before deciding whether this
    // is a regenerate or a genuinely unsaved first attempt.
    if (resolvingResendRef.current.has(key)) return;
    resolvingResendRef.current.add(key);
    let remote: Awaited<ReturnType<typeof getSession>>;
    try {
      remote = await getSession(session.sessionId);
    } catch {
      notify("Couldn't reach the server. Please check your connection and retry.", {
        tone: "error",
      });
      return;
    } finally {
      resolvingResendRef.current.delete(key);
    }
    const live = stateRef.current;
    const liveSession = live.sessions[key];
    if (
      live.selectedKey !== key ||
      !liveSession ||
      !isFailedTurnVisible(
        liveSession.messages,
        liveSession.selectedBranches,
        liveSession.status,
        liveSession.isStreaming,
      )
    ) return;
    const liveLastUser = [...liveSession.messages]
      .reverse()
      .find((message) => message.role === "user" && message.requestSnapshot);
    if (!liveLastUser?.requestSnapshot) return;
    const decision = decideFailedTurnReplay(
      liveSession.messages,
      { ...liveLastUser, requestSnapshot: liveLastUser.requestSnapshot },
      remote,
    );
    if (decision.kind === "refresh") {
      void loadSessionRef.current?.(session.sessionId);
      return;
    }
    if (decision.kind === "reconcile_regenerate") {
      dispatch({
        type: "RECONCILE_TURN",
        key,
        turnId: null,
        // Runtime storage can return PocketBase string IDs; the existing
        // reconciliation path preserves them despite its numeric legacy type.
        userMessageId: decision.userId as number,
        assistantMessageId: null,
      });
    }
    if (decision.kind === "regenerate" || decision.kind === "reconcile_regenerate") {
      regenerateLastMessage(true);
      return;
    }
    // The first attempt failed before the user row reached storage.
    retryUnsavedTail();
  }, [regenerateLastMessage, sendMessage]);

  const derivedState = useMemo<ChatState>(() => {
    const current = ensureSelectedSession(state);
    const tail = current.messages.at(-1);
    const submissionNoLlmAccess = tail?.failedSubmission === true &&
      tail.failedSubmissionNoLlmAccess === true;
    return {
      sessionKey: current.key,
      boundFromKey: current.boundFromKey ?? null,
      sessionId: current.sessionId,
      sessionTitle: current.sessionTitle,
      enabledTools: current.enabledTools,
      activeCapability: current.activeCapability,
      workspaceMode: current.workspaceMode,
      knowledgeBases: current.knowledgeBases,
      knowledgeBasesInitialized: current.knowledgeBasesInitialized,
      llmSelection: current.llmSelection,
      masteryPathId: current.masteryPathId,
      masterySessionMode: current.masterySessionMode,
      noteDocumentId: current.noteDocumentId,
      createTarget: current.createTarget,
      workspaceId: current.workspaceId,
      personaSelection: current.personaSelection,
      answerBy: current.answerBy,
      resourceSelection: current.resourceSelection,
      messages: current.messages,
      isStreaming: current.isStreaming,
      currentStage: current.currentStage,
      language: "en",
      selectedBranches: current.selectedBranches,
      queuedMessages: current.queuedMessages ?? [],
      lastTurnFailed: isFailedTurnVisible(
        current.messages,
        current.selectedBranches,
        current.status,
        current.isStreaming,
      ),
      submissionFailed: (() => {
        if (current.isStreaming) return false;
        return (
          (current.status === "failed" || current.status === "rejected") &&
          tail?.role === "user" &&
          tail.failedSubmission === true
        );
      })(),
      submissionNoLlmAccess,
      submissionNeedsReview: (() => {
        const tail = current.messages[current.messages.length - 1];
        return tail?.role === "user" && tail.failedSubmissionNeedsReview === true;
      })(),
      submissionNotSaved: (() => {
        const tail = current.messages[current.messages.length - 1];
        return tail?.role === "user" && tail.failedSubmissionNotSaved === true;
      })(),
      submissionErrorMessage: (() => {
        const tail = current.messages[current.messages.length - 1];
        return tail?.role === "user" && tail.failedSubmissionMessage
          ? tail.failedSubmissionMessage
          : "";
      })(),
    };
  }, [state]);

  const sessionStatuses = useMemo<Record<string, SessionStatusSnapshot>>(() => {
    const entries: Record<string, SessionStatusSnapshot> = {};
    for (const session of Object.values(state.sessions)) {
      if (!session.sessionId || session.status !== "running") continue;
      entries[session.sessionId] = {
        sessionId: session.sessionId,
        status: session.status,
        activeTurnId: session.activeTurnId,
        updatedAt: session.updatedAt,
      };
    }
    return entries;
  }, [state.sessions]);

  const setTools = useCallback((tools: string[]) => {
    dispatch({ type: "SET_TOOLS", tools });
  }, []);

  const setCapability = useCallback((cap: string | null) => {
    dispatch({ type: "SET_CAPABILITY", cap });
  }, []);

  const setKBs = useCallback((kbs: string[]) => {
    dispatch({ type: "SET_KB", kbs });
  }, []);

  const initializeKBs = useCallback((key: string, workspaceId: string | null, kbs: string[]) => {
    dispatch({ type: "INITIALIZE_KB", key, workspaceId, kbs });
  }, []);

  const setLLMSelection = useCallback((selection: LLMSelection | null) => {
    dispatch({ type: "SET_LLM_SELECTION", selection });
  }, []);

  const setMasteryPathId = useCallback((masteryPathId: string | null) => {
    const normalized = masteryPathId?.trim() || null;
    dispatch({ type: "SET_MASTERY_PATH_ID", masteryPathId: normalized });
  }, []);

  const setMasterySessionMode = useCallback((mode: string | null) => {
    dispatch({
      type: "SET_MASTERY_SESSION_MODE",
      mode: mode?.trim() || null,
    });
  }, []);

  const setPersonaSelection = useCallback((persona: string) => {
    dispatch({ type: "SET_PERSONA_SELECTION", persona });
  }, []);

  const setAnswerBy = useCallback((answerBy: string | null) => {
    dispatch({ type: "SET_ANSWER_BY", answerBy });
  }, []);

  const setResourceSelection = useCallback((selection: ResourceSelection) => {
    dispatch({ type: "SET_RESOURCE_SELECTION", selection });
  }, []);
  const setCreateTarget = useCallback((createTarget: string | null) => {
    dispatch({ type: "SET_CREATE_TARGET", createTarget });
  }, []);

  const setLanguage = useCallback((_lang: string) => {
    dispatch({ type: "SET_LANGUAGE", lang: "en" });
  }, []);

  const renameSessionTitle = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const currentState = stateRef.current;
    const key = currentState.selectedKey;
    if (!key) return;
    const session = currentState.sessions[key];
    const sessionId = session?.sessionId;
    if (!sessionId) return;
    const updated = await updateSessionTitle(sessionId, trimmed);
    dispatch({
      type: "SET_SESSION_TITLE",
      key,
      title: updated.title || trimmed,
    });
  }, []);

  const newSession = useCallback(
    (configuration?: SessionConfiguration) => {
      const key = makeDraftKey();
      dispatch({ type: "NEW_SESSION", key, configuration });
      // The provider stays mounted while /chat pages come and go. Restore
      // unsent first turns every time a page creates a fresh draft, too.
      dispatch({
        type: "ENSURE_DRAFT_SESSION",
        key,
        failedRecords: readFailedSubmissions(draftFailedSubmissionKey()),
      });
      return key;
    },
    [makeDraftKey],
  );

  const configureSession = useCallback(
    (configuration: SessionConfiguration, sessionKey?: string) => {
      dispatch({
        type: "CONFIGURE_SESSION",
        key: sessionKey,
        configuration,
      });
    },
    [],
  );

  const discardFailedSubmission = useCallback((messageId: number): boolean => {
    const currentState = stateRef.current;
    const key = currentState.selectedKey;
    const session = key ? currentState.sessions[key] : undefined;
    if (!key || !session || session.isStreaming) return false;
    const message = session.messages.find((item) => item.id === messageId);
    if (message?.role !== "user" || !message.failedSubmission || messageId >= 0 || !message.failedSubmissionId) return false;
    const storageKey = session.sessionId ?? draftFailedSubmissionKey();
    const rootId = message.requestSnapshot?.replacementRootSubmissionId ?? message.failedSubmissionId;
    const pendingEdits = readFailedSubmissions(storageKey, true).filter((record) => {
      const snapshot = record.requestSnapshot as MessageRequestSnapshot;
      return (snapshot?.replacementRootSubmissionId ?? snapshot?.replacesSubmissionId) === rootId;
    });
    for (const pendingEdit of pendingEdits) {
      if (pendingEdit.submissionId && !clearFailedSubmission(storageKey, pendingEdit.submissionId)) return false;
    }
    if (rootId !== message.failedSubmissionId && !clearFailedSubmission(storageKey, rootId)) return false;
    if (!clearFailedSubmission(storageKey, message.failedSubmissionId) && !message.failedSubmissionNotSaved) return false;
    dispatch({ type: "DISCARD_FAILED_SUBMISSION", key, messageId, submissionId: message.failedSubmissionId });
    return true;
  }, []);

  const editMessage = useCallback(
    async (messageId: number, newContent: string): Promise<boolean> => {
      const generation = runtimeGeneration.current;
      const trimmed = newContent.trim();
      if (!trimmed) return false;
      const currentState = stateRef.current;
      const key = currentState.selectedKey;
      if (!key) return false;
      const session = currentState.sessions[key];
      if (!session) return false;
      // Edits create a new branch via a fresh turn — block while one is
      // already running so we don't queue against an in-flight stream
      // (matches the delete-turn guard).
      if (session.isStreaming) return false;
      const local = session.messages.find((message) => message.id === messageId && message.role === "user");
      if (local?.failedSubmission && local.failedSubmissionId && local.requestSnapshot && !local.failedSubmissionNeedsReview) {
        if (!(await supportsSubmissionReplacement()) || generation !== runtimeGeneration.current) return false;
        const rootId = local.requestSnapshot.replacementRootSubmissionId ?? local.failedSubmissionId;
        const pending = readFailedSubmissions(session.sessionId ?? draftFailedSubmissionKey()).find((record) => {
          const snapshot = record.requestSnapshot as MessageRequestSnapshot;
          return (snapshot?.replacementRootSubmissionId ?? snapshot?.replacesSubmissionId) === rootId;
        });
        const sameEdit = pending?.content === trimmed;
        if (pending && !sameEdit) {
          const priorEdit = pending.requestSnapshot as MessageRequestSnapshot;
          if (!priorEdit.replacesSubmissionId || !priorEdit.replacementRequest) return false;
          try {
            // Before chaining another edit, resolve the uncertain predecessor.
            // It might never have reached the server, so replacing its ID alone
            // would leave the original delayed request free to be admitted.
            await replaceSubmission(priorEdit.replacesSubmissionId, priorEdit.replacementRequest);
            if (generation !== runtimeGeneration.current) return false;
          } catch { return false; }
        }
        const snapshot = { ...(sameEdit ? pending.requestSnapshot as MessageRequestSnapshot : local.requestSnapshot), content: trimmed };
        if (!sameEdit) {
          delete snapshot.replacementRequest;
          delete snapshot.replacesSubmissionId;
        }
        return sendMessage(trimmed, undefined, undefined, undefined, undefined, {
          requestSnapshotOverride: snapshot,
          retrySubmissionId: sameEdit ? pending.submissionId : undefined,
          replacesSubmissionId: sameEdit ? (pending.requestSnapshot as MessageRequestSnapshot).replacesSubmissionId : pending?.submissionId ?? local.failedSubmissionId,
          replacementRootSubmissionId: rootId,
          replacedMessageId: messageId,
          parentMessageId: local.parentMessageId != null && local.parentMessageId > 0 ? local.parentMessageId : null,
        });
      }
      let original: MessageItem | undefined;
      try {
        original = await resolvePersistedMessage(
          session.messages,
          messageId,
          "user",
          async () =>
            session.sessionId
              ? await loadSession(session.sessionId)
              : undefined,
        );
      } catch {
        return false;
      }
      if (!original || generation !== runtimeGeneration.current) return false;
      const parentId = original.parentMessageId ?? null;
      return sendMessage(
        trimmed,
        original.attachments,
        undefined,
        undefined,
        undefined,
        { parentMessageId: parentId,
          requestSnapshotOverride: (local?.requestSnapshot ?? original.requestSnapshot)
            ? withCurrentGenerationSettings(
                {
                  ...(local?.requestSnapshot ?? original.requestSnapshot)!,
                  content: trimmed,
                  // An edit is a new turn under the current settings; it does
                  // not inherit the failed submission's replacement identity.
                  replacesSubmissionId: undefined,
                  replacementRequest: undefined,
                },
                session,
              )
            : undefined },
        undefined,
        undefined,
        undefined,
      );
    },
    [loadSession, sendMessage],
  );

  const retryFailedSubmission = useCallback(async (messageId: number): Promise<boolean> => {
    const current = stateRef.current;
    const key = current.selectedKey;
    const session = key ? current.sessions[key] : undefined;
    const message = session?.messages.find((item) => item.id === messageId);
    if (!key || !session || session.isStreaming || !message?.failedSubmission ||
      !message.failedSubmissionId || !message.requestSnapshot || message.failedSubmissionNeedsReview) return false;
    if (message.requestSnapshot.replacesSubmissionId && !(await supportsSubmissionReplacement())) return false;
    const rootId = message.requestSnapshot.replacementRootSubmissionId ?? message.failedSubmissionId;
    const pending = readFailedSubmissions(session.sessionId ?? draftFailedSubmissionKey()).find((record) => {
      const snapshot = record.requestSnapshot as MessageRequestSnapshot;
      return (snapshot?.replacementRootSubmissionId ?? snapshot?.replacesSubmissionId) === rootId;
    });
    if (pending && pending.submissionId !== message.failedSubmissionId) return editMessage(messageId, pending.content);
    // Older recovery records did not retain the actual wire request. Reusing
    // their ID can conflict with an already-reserved digest after a reload.
    // Fence that ID before starting anew, including attachment-only drafts.
    if (!message.requestSnapshot.submissionRequest && !message.requestSnapshot.replacementRequest) {
      return sendMessage(message.content, undefined, undefined, undefined, undefined, {
        requestSnapshotOverride: message.requestSnapshot,
        replacesSubmissionId: message.failedSubmissionId,
        replacementRootSubmissionId: rootId,
        replacedMessageId: messageId,
        parentMessageId: message.parentMessageId != null && message.parentMessageId > 0 ? message.parentMessageId : null,
      });
    }
    // Move this exact local row to the active tail while retaining its causal
    // ID; retrying an older draft must never resend the newest row instead.
    dispatch({ type: "DISCARD_FAILED_SUBMISSION", key, messageId, submissionId: message.failedSubmissionId });
    return sendMessage(message.content, undefined, undefined, undefined, undefined, {
      requestSnapshotOverride: message.requestSnapshot, retrySubmissionId: message.failedSubmissionId,
      parentMessageId: message.parentMessageId != null && message.parentMessageId > 0 ? message.parentMessageId : null,
    });
  }, [sendMessage, editMessage]);

  const switchBranch = useCallback(
    (parentMessageId: number | null, childId: number) => {
      const currentState = stateRef.current;
      const key = currentState.selectedKey;
      if (!key) return;
      const session = currentState.sessions[key];
      if (!session) return;
      const parentKey =
        parentMessageId == null ? "null" : String(parentMessageId);
      dispatch({
        type: "SET_SELECTED_BRANCH",
        key,
        parentKey,
        childId,
      });
      const sessionId = session.sessionId;
      if (!sessionId || childId < 0) return;
      const nextSelections = persistedBranchSelections({
        ...session.selectedBranches,
        [parentKey]: childId,
      });
      if (Object.keys(nextSelections).length === 0) return;
      // Fire-and-forget — local state is the source of truth for the UI;
      // the server copy only matters for reload-time hydration.
      updateBranchSelection(sessionId, nextSelections).catch((err) => {
        console.warn("Failed to persist branch selection:", err);
      });
    },
    [],
  );

  const deleteTurn = useCallback(
    async (messageId: number): Promise<DeleteMessageResult> => {
      const generation = runtimeGeneration.current;
      const currentState = stateRef.current;
      const key = currentState.selectedKey;
      const empty = (): DeleteMessageResult => ({
        detachedThreadIds: [],
        deletedMessageIds: [],
      });
      if (!key) return empty();
      const session = currentState.sessions[key];
      if (!session || !session.sessionId) return empty();
      if (session.isStreaming) return empty();
      // Same optimistic-id race as editMessage (#739): after loadSession
      // dispatches, stateRef can still hold the negative sentinel until
      // React commits. Resolve from the returned snapshot instead.
      let target: MessageItem | undefined;
      try {
        target = await resolvePersistedMessage(
          session.messages,
          messageId,
          "user",
          async () =>
            session.sessionId
              ? await loadSession(session.sessionId)
              : undefined,
        );
      } catch {
        return empty();
      }
      if (
        !target ||
        typeof target.id !== "number" ||
        target.id < 0 ||
        generation !== runtimeGeneration.current
      ) {
        return empty();
      }
      const effectiveId = target.id;
      try {
        const result = await deleteMessage(session.sessionId, effectiveId);
        dispatch({ type: "DELETE_TURN", key, messageId: effectiveId });
        // The server detached any Little Tutor thread filed under the deleted
        // message. Both the thread list and the open side-chat tabs subscribe
        // to this bus, so marker/popover/context state refresh together.
        notifySessionsChanged();
        return result;
      } catch (err) {
        console.error("Failed to delete turn:", err);
        return empty();
      }
    },
    [loadSession],
  );

  // ── Messages sent while a turn runs ───────────────────────────
  const queueMessage = useCallback(
    (content: string, send: QueuedMessage["send"], steerable: boolean) => {
      const key = stateRef.current.selectedKey;
      if (!key) return;
      dispatch({
        type: "QUEUE_MESSAGE",
        key,
        message: { id: newCommandId(), content, send, steerable, offeredTo: null },
      });
    },
    [],
  );

  const withdrawQueuedMessage = useCallback(
    (id: string) => {
      const key = stateRef.current.selectedKey;
      const session = key ? stateRef.current.sessions[key] : undefined;
      const queued = session?.queuedMessages?.find((item) => item.id === id);
      if (!key || !session || !queued) return;
      dispatch({ type: "DROP_QUEUED", key, ids: [id] });
      // Already offered: take it back before the turn's next step reads it.
      if (queued.offeredTo && queued.offeredTo === session.activeTurnId) {
        void sendThroughRunner(key, {
          type: "user_input",
          turn_id: queued.offeredTo,
          content: "",
          withdraw: id,
          command_id: newCommandId(),
          protocol_version: "2.0",
        });
      }
    },
    [sendThroughRunner],
  );

  // Offer what can steer to the turn running now; it reads them between steps.
  const selectedSession = state.selectedKey ? state.sessions[state.selectedKey] : undefined;
  useEffect(() => {
    const key = state.selectedKey;
    const turnId = selectedSession?.activeTurnId;
    if (!key || !selectedSession?.isStreaming || !turnId) return;
    const offers = (selectedSession.queuedMessages ?? []).filter(
      (queued) => queued.steerable && queued.offeredTo !== turnId,
    );
    if (!offers.length) return;
    dispatch({ type: "OFFER_QUEUED", key, ids: offers.map((queued) => queued.id), turnId });
    for (const queued of offers) {
      void sendThroughRunner(
        key,
        {
          type: "user_input",
          turn_id: turnId,
          content: queued.content,
          command_id: queued.id,
          protocol_version: "2.0",
        },
        { awaitAck: true },
      );
    }
  }, [selectedSession, sendThroughRunner, state.selectedKey]);

  // Once the turn has ended, what it never read goes as the next turn — one
  // at a time, so later messages can steer that one in turn.
  useEffect(() => {
    const key = state.selectedKey;
    const next = selectedSession?.queuedMessages?.[0];
    if (
      !key ||
      !next ||
      selectedSession.isStreaming ||
      selectedSession.status === "running" ||
      // A send the server never received is retried by hand, not queued past.
      derivedState.submissionFailed
    ) {
      return;
    }
    dispatch({ type: "DROP_QUEUED", key, ids: [next.id] });
    sendMessage(...next.send);
  }, [derivedState.submissionFailed, selectedSession, sendMessage, state.selectedKey]);

  // Memoize the context value so consumers don't re-render on every render of
  // this provider. Without this wrap, every stream-event-driven reducer
  // dispatch produced a fresh object identity, cascading a re-render through
  // every adapter consumer (chat page, composer, sidebar) on each
  // token. The callbacks below are already stable via useCallback; the only
  // things that should change identity are derivedState, sessionStatuses,
  // and sidebarRefreshToken.
  const value = useMemo<ChatContextValue>(
    () => ({
      state: derivedState,
      setTools,
      setCapability,
      setKBs,
      initializeKBs,
      setLLMSelection,
      setMasteryPathId,
      setMasterySessionMode,
      setPersonaSelection,
      setAnswerBy,
      setResourceSelection,
      setCreateTarget,
      setLanguage,
      sendMessage,
      queueMessage,
      withdrawQueuedMessage,
      cancelStreamingTurn,
      submitUserReply,
      regenerateLastMessage,
      resendLastMessage,
      deleteTurn,
      discardFailedSubmission,
      retryFailedSubmission,
      editMessage,
      switchBranch,
      renameSessionTitle,
      newSession,
      configureSession,
      loadSession,
      showCachedSession,
      loadMessageTrace,
      releaseMessageTrace,
      selectedSessionId: derivedState.sessionId,
      sessionStatuses,
      sidebarRefreshToken: state.sidebarRefreshToken,
    }),
    [
      derivedState,
      setTools,
      setCapability,
      setKBs,
      initializeKBs,
      setLLMSelection,
      setMasteryPathId,
      setMasterySessionMode,
      setPersonaSelection,
      setAnswerBy,
      setResourceSelection,
      setCreateTarget,
      setLanguage,
      sendMessage,
      queueMessage,
      withdrawQueuedMessage,
      cancelStreamingTurn,
      submitUserReply,
      regenerateLastMessage,
      resendLastMessage,
      deleteTurn,
      discardFailedSubmission,
      retryFailedSubmission,
      editMessage,
      switchBranch,
      renameSessionTitle,
      newSession,
      configureSession,
      loadSession,
      showCachedSession,
      loadMessageTrace,
      releaseMessageTrace,
      sessionStatuses,
      state.sidebarRefreshToken,
    ],
  );

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}

/** Transitional state adapter for surfaces that have not moved to store selectors yet. */
export function useChatStateAdapter() {
  const ctx = useContext(ChatCtx);
  if (!ctx)
    throw new Error(
      "useChatStateAdapter must be inside ChatStateAdapterProvider",
    );
  return ctx;
}
