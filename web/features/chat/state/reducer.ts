import type { StreamEvent } from "@/features/chat/model/protocol";
import { settleMessageTrace, traceSettleAction } from "@/features/chat/trace/memory";
import { hasPendingAskUserInMessages } from "@/lib/ask-user-state";
import type { FailedSubmissionRecord } from "@/lib/failed-submissions";
import {
  appendWithEmphasisRepair,
  repairChineseEmphasis,
} from "@/lib/markdown-display";
import { selectChildBranch } from "@/lib/message-branches";
import { hasOpenUILang } from "@/lib/openui/lang";
import { hasLegacyOgui } from "@/lib/openui/legacy-ogui";
import { nextOptimisticId } from "@/lib/optimistic-id";
import { shouldAppendEventContent } from "@/lib/stream";
import { reconcileTurnIds } from "@/lib/turn-reconcile";
import { activeWorkspaceId } from "@/lib/workspace-scope";
import {
  emptyResourceSelection,
  type Action,
  type MessageItem,
  type MessageRequestSnapshot,
  type ProviderState,
  type QueuedMessage,
  type SessionConfiguration,
  type SessionEntry,
} from "./types";

export const initialState: ProviderState = {
  selectedKey: null,
  sessions: {},
  sidebarRefreshToken: 0,
};

export function createSessionEntry(
  key: string,
  sessionId: string | null = null,
): SessionEntry {
  return {
    key,
    sessionId,
    sessionTitle: "",
    enabledTools: [],
    activeCapability: null,
    workspaceMode: null,
    knowledgeBases: [],
    knowledgeBasesInitialized: sessionId !== null,
    llmSelection: null,
    masteryPathId: null,
    masterySessionMode: null,
    noteDocumentId: null,
    createTarget: null,
    workspaceId: activeWorkspaceId() || null,
    personaSelection: "",
    answerBy: null,
    resourceSelection: emptyResourceSelection(),
    messages: [],
    isStreaming: false,
    currentStage: "",
    language:
      typeof window === "undefined" ? "en" : readStoredResponseLanguage(),
    replyLanguageOverride: null,
    status: "idle",
    submissionBaseStatus: "idle",
    activeTurnId: null,
    lastSeq: 0,
    updatedAt: Date.now(),
    selectedBranches: {},
    lastTurnFailed: false,
    submissionFailed: false,
    submissionErrorMessage: "",
    submissionNoLlmAccess: false,
    submissionNeedsReview: false,
    submissionNotSaved: false,
    queuedMessages: [],
  };
}

export function withCurrentGenerationSettings(
  snapshot: MessageRequestSnapshot,
  session: Pick<
    SessionEntry,
    "llmSelection" | "language" | "replyLanguageOverride"
  >,
): MessageRequestSnapshot {
  return {
    ...snapshot,
    llmSelection: session.llmSelection,
    language: session.replyLanguageOverride ?? readStoredResponseLanguage(),
    replyLanguageOverride: session.replyLanguageOverride,
  };
}

export function draftFailedSubmissionKey(): string {
  return `draft:${activeWorkspaceId() || "general"}`;
}

export function restoredFailedMessage(
  record: FailedSubmissionRecord,
  parentMessageId: number | null,
): MessageItem {
  const stored = record.requestSnapshot;
  const base: Record<string, unknown> =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  const snapshot = {
    ...base,
    content: record.content,
    enabledTools: Array.isArray(base.enabledTools) ? base.enabledTools : [],
    knowledgeBases: Array.isArray(base.knowledgeBases)
      ? base.knowledgeBases
      : [],
    language: typeof base.language === "string" ? base.language : "en",
  } as MessageRequestSnapshot;
  return {
    id: nextOptimisticId(),
    role: "user",
    content: record.content,
    capability: record.capability,
    parentMessageId,
    ...(snapshot.attachments?.length
      ? { attachments: snapshot.attachments }
      : {}),
    requestSnapshot: snapshot,
    failedSubmission: true,
    failedSubmissionNoLlmAccess: record.noLlmAccess === true,
    failedSubmissionNeedsReview: record.retryRequiresReview,
    failedSubmissionId: record.submissionId,
  };
}

export function ensureSelectedSession(state: ProviderState): SessionEntry {
  if (state.selectedKey && state.sessions[state.selectedKey]) {
    return state.sessions[state.selectedKey];
  }
  return createSessionEntry("draft");
}

function updateSessionQueue(
  state: ProviderState,
  key: string,
  update: (queue: QueuedMessage[]) => QueuedMessage[],
): ProviderState {
  const session = state.sessions[key];
  if (!session) return state;
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [key]: { ...session, queuedMessages: update(session.queuedMessages ?? []) },
    },
  };
}

export function readUserInputIds(event: StreamEvent): string[] {
  const metadata = event.metadata as
    | { trace_kind?: string; user_inputs?: unknown }
    | undefined;
  if (
    metadata?.trace_kind !== "user_input" ||
    !Array.isArray(metadata.user_inputs)
  ) {
    return [];
  }
  return metadata.user_inputs
    .map((item) => String((item as { command_id?: unknown })?.command_id ?? ""))
    .filter(Boolean);
}

function updateSelectedSession(
  state: ProviderState,
  updater: (session: SessionEntry) => SessionEntry,
): ProviderState {
  const current = ensureSelectedSession(state);
  const key = state.selectedKey || current.key;
  const nextSession = updater(current);
  return {
    ...state,
    selectedKey: key,
    sessions: {
      ...state.sessions,
      [key]: nextSession,
    },
  };
}

function applySessionConfiguration(
  session: SessionEntry,
  configuration?: SessionConfiguration,
): SessionEntry {
  if (!configuration) return session;
  return {
    ...session,
    llmSelection:
      configuration.llmSelection !== undefined
        ? configuration.llmSelection
        : session.llmSelection,
    activeCapability:
      configuration.capability !== undefined
        ? configuration.capability
        : session.activeCapability,
    workspaceMode:
      configuration.workspaceMode !== undefined
        ? configuration.workspaceMode
        : session.workspaceMode,
    knowledgeBases:
      configuration.knowledgeBases !== undefined
        ? [...configuration.knowledgeBases]
        : session.knowledgeBases,
    knowledgeBasesInitialized:
      configuration.knowledgeBases !== undefined ||
      session.knowledgeBasesInitialized,
    masteryPathId:
      configuration.masteryPathId !== undefined
        ? configuration.masteryPathId
        : session.masteryPathId,
    masterySessionMode:
      configuration.masterySessionMode !== undefined
        ? configuration.masterySessionMode
        : session.masterySessionMode,
    noteDocumentId:
      configuration.noteDocumentId !== undefined
        ? configuration.noteDocumentId
        : session.noteDocumentId,
    workspaceId:
      configuration.workspaceId !== undefined
        ? configuration.workspaceId
        : session.workspaceId,
    enabledTools:
      configuration.enabledTools !== undefined
        ? [...configuration.enabledTools]
        : session.enabledTools,
    updatedAt: Date.now(),
  };
}

const MAX_CACHED_SESSIONS = 20;

function trimSessions(
  sessions: Record<string, SessionEntry>,
  keep: string | null,
): Record<string, SessionEntry> {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_CACHED_SESSIONS) return sessions;
  const evictable = keys
    .filter(
      (k) =>
        k !== keep &&
        sessions[k].status !== "running" &&
        !sessions[k].isStreaming,
    )
    .sort((a, b) => sessions[a].updatedAt - sessions[b].updatedAt);
  const next = { ...sessions };
  for (const k of evictable.slice(0, keys.length - MAX_CACHED_SESSIONS)) {
    delete next[k];
  }
  return next;
}

function selectFreshDraft(
  state: ProviderState,
  key: string,
  configuration?: SessionConfiguration,
): ProviderState {
  const nextSessions = trimSessions(
    {
      ...state.sessions,
      [key]: applySessionConfiguration(createSessionEntry(key), configuration),
    },
    key,
  );
  return { ...state, selectedKey: key, sessions: nextSessions };
}

function isSameTurnEvent(a: StreamEvent, b: StreamEvent): boolean {
  const aSeq = Number(a.seq || 0);
  const bSeq = Number(b.seq || 0);
  if (aSeq <= 0 || bSeq <= 0 || aSeq !== bSeq) return false;
  const aTurn = a.turn_id || "";
  const bTurn = b.turn_id || "";
  return Boolean(aTurn && bTurn && aTurn === bTurn);
}

function hasTurnEvent(events: StreamEvent[], event: StreamEvent): boolean {
  const seq = Number(event.seq || 0);
  const turn = event.turn_id || "";
  if (seq <= 0 || !turn) return false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const other = events[index];
    const otherSeq = Number(other.seq || 0);
    if ((other.turn_id || "") !== turn || otherSeq <= 0) continue;
    if (otherSeq < seq) return false;
    break;
  }
  return events.some((other) => isSameTurnEvent(other, event));
}

export function reducer(state: ProviderState, action: Action): ProviderState {
  const next = reduce(state, action);
  return action.type === "LOAD_SESSION" && next !== state
    ? { ...next, sessions: trimSessions(next.sessions, next.selectedKey) }
    : next;
}

function reduce(state: ProviderState, action: Action): ProviderState {
  if (action.type === "RESET_ACCOUNT") return initialState;
  switch (action.type) {
    case "SET_TOOLS":
      return updateSelectedSession(state, (session) => ({
        ...session,
        enabledTools: action.tools,
      }));
    case "SET_CAPABILITY":
      return updateSelectedSession(state, (session) => ({
        ...session,
        activeCapability: action.cap,
      }));
    case "SET_KB":
      return updateSelectedSession(state, (session) => ({
        ...session,
        knowledgeBases: action.kbs,
        knowledgeBasesInitialized: true,
      }));
    case "INITIALIZE_KB": {
      const session = state.sessions[action.key];
      if (
        !session ||
        session.knowledgeBasesInitialized ||
        session.sessionId ||
        session.messages.length ||
        session.workspaceId !== action.workspaceId
      ) {
        return state;
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            knowledgeBases: action.kbs,
            knowledgeBasesInitialized: true,
          },
        },
      };
    }
    case "SET_LLM_SELECTION":
      return updateSelectedSession(state, (session) => ({
        ...session,
        llmSelection: action.selection,
      }));
    case "SET_MASTERY_SESSION_MODE": {
      if (!action.key) {
        return updateSelectedSession(state, (session) => ({
          ...session,
          masterySessionMode: action.mode,
        }));
      }
      const target = state.sessions[action.key];
      if (!target) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: { ...target, masterySessionMode: action.mode },
        },
      };
    }
    case "SET_MASTERY_PATH_ID": {
      if (!action.key) {
        return updateSelectedSession(state, (session) => ({
          ...session,
          masteryPathId: action.masteryPathId,
        }));
      }
      const target = state.sessions[action.key];
      if (!target) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: { ...target, masteryPathId: action.masteryPathId },
        },
      };
    }
    case "SET_PERSONA_SELECTION":
      return updateSelectedSession(state, (session) => ({
        ...session,
        personaSelection: action.persona,
      }));
    case "SET_ANSWER_BY":
      return updateSelectedSession(state, (session) => ({
        ...session,
        answerBy: action.answerBy,
      }));
    case "SET_RESOURCE_SELECTION":
      return updateSelectedSession(state, (session) => ({
        ...session,
        resourceSelection: action.selection,
      }));
    case "SET_CREATE_TARGET":
      return updateSelectedSession(state, (session) => ({
        ...session,
        createTarget: action.createTarget,
      }));
    case "SET_LANGUAGE":
      return updateSelectedSession(state, (session) => ({
        ...session,
        language: session.replyLanguageOverride ?? action.lang,
      }));
    case "SET_REPLY_LANGUAGE_OVERRIDE": {
      const session = state.sessions[action.key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            replyLanguageOverride: action.language,
            language: action.language ?? readStoredResponseLanguage(),
          },
        },
      };
    }
    case "ADD_USER_MSG": {
      const session =
        state.sessions[action.key] ?? createSessionEntry(action.key);
      const userId = nextOptimisticId();
      const parentId =
        action.parentMessageId === undefined ? null : action.parentMessageId;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            submissionBaseStatus: session.messages.some(
              (message) => message.failedSubmission,
            )
              ? session.submissionBaseStatus
              : session.status,
            messages: [
              ...session.messages,
              {
                id: userId,
                role: "user",
                content: action.content,
                capability: action.capability || "",
                parentMessageId: parentId,
                ...(action.attachments?.length
                  ? { attachments: action.attachments }
                  : {}),
                ...(action.requestSnapshot
                  ? { requestSnapshot: action.requestSnapshot }
                  : {}),
                ...(action.failedSubmissionId
                  ? { failedSubmissionId: action.failedSubmissionId }
                  : {}),
              },
            ],
            selectedBranches: selectChildBranch(
              session.selectedBranches,
              parentId,
              userId,
            ),
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "SET_SUBMISSION_PERSISTENCE": {
      const session = state.sessions[action.key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages: session.messages.map((message) =>
              message.failedSubmissionId === action.submissionId
                ? { ...message, failedSubmissionNotSaved: !action.saved }
                : message,
            ),
          },
        },
      };
    }
    case "DISCARD_FAILED_SUBMISSION": {
      const session = state.sessions[action.key];
      if (!session || session.isStreaming) return state;
      const target = session.messages.find(
        (message) =>
          message.id === action.messageId &&
          message.role === "user" &&
          message.failedSubmission &&
          message.failedSubmissionId === action.submissionId &&
          action.messageId < 0,
      );
      if (!target) return state;
      const messages = session.messages
        .filter((message) => message !== target)
        .map((message) =>
          message.parentMessageId === target.id
            ? { ...message, parentMessageId: target.parentMessageId ?? null }
            : message,
        );
      const selectedBranches = { ...session.selectedBranches };
      const parentKey = String(target.parentMessageId ?? "null");
      if (selectedBranches[parentKey] === target.id) {
        const child = selectedBranches[String(target.id)];
        if (child !== undefined) selectedBranches[parentKey] = child;
        else delete selectedBranches[parentKey];
      }
      delete selectedBranches[String(target.id)];
      for (const [key, id] of Object.entries(selectedBranches)) {
        if (id === target.id) delete selectedBranches[key];
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages,
            selectedBranches,
            status: messages.some((message) => message.failedSubmission)
              ? session.status
              : session.submissionBaseStatus,
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "POP_LAST_ASSISTANT": {
      const session = state.sessions[action.key];
      if (!session || session.messages.length === 0) return state;
      const last = session.messages[session.messages.length - 1];
      if (last.role !== "assistant") return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages: session.messages.slice(0, -1),
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "RESTORE_ASSISTANT": {
      const session = state.sessions[action.key];
      if (!session) return state;
      const messages = [...session.messages];
      const placeholder = messages[messages.length - 1];
      if (
        placeholder?.role === "assistant" &&
        typeof placeholder.id === "number" &&
        placeholder.id < 0
      ) {
        messages.pop();
      }
      messages.push(action.message);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages,
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "QUEUE_MESSAGE":
      return updateSessionQueue(state, action.key, (queue) => [
        ...queue,
        action.message,
      ]);
    case "OFFER_QUEUED":
      return updateSessionQueue(state, action.key, (queue) =>
        queue.map((queued) =>
          action.ids.includes(queued.id)
            ? { ...queued, offeredTo: action.turnId }
            : queued,
        ),
      );
    case "DROP_QUEUED":
      return updateSessionQueue(state, action.key, (queue) =>
        queue.filter((queued) => !action.ids.includes(queued.id)),
      );
    case "STREAM_START": {
      const session =
        state.sessions[action.key] ?? createSessionEntry(action.key);
      const existing = session.messages ?? [];
      const flaggedTail = existing[existing.length - 1];
      const unflagged =
        flaggedTail?.role === "user" && flaggedTail.failedSubmission
          ? [
              ...existing.slice(0, -1),
              { ...flaggedTail, failedSubmission: false },
            ]
          : existing;
      const tip = unflagged.length > 0 ? unflagged[unflagged.length - 1] : null;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            isStreaming: true,
            status: "running",
            activeTurnId: null,
            lastSeq: 0,
            messages: [
              ...unflagged,
              {
                id: nextOptimisticId(),
                role: "assistant",
                content: "",
                rawContent: "",
                events: [],
                trace: { started_at: action.startedAt },
                capability:
                  action.capability !== undefined
                    ? action.capability || ""
                    : session.activeCapability || "",
                parentMessageId: tip?.id ?? null,
              },
            ],
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "STREAM_TOUCH": {
      const session = state.sessions[action.key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: { ...session, updatedAt: Date.now() },
        },
      };
    }
    case "STREAM_EVENT": {
      if (!state.sessions[action.key]) return state;
      const session = state.sessions[action.key];
      const msgs = [...session.messages];
      let last = msgs[msgs.length - 1];
      if (last?.role !== "assistant") {
        msgs.push({
          id: nextOptimisticId(),
          role: "assistant",
          content: "",
          rawContent: "",
          events: [],
          capability: session.activeCapability || "",
          parentMessageId: last?.id ?? null,
        });
        last = msgs[msgs.length - 1];
      }
      if (hasTurnEvent(last?.events || [], action.event)) {
        return state;
      }
      const events = [...(last?.events || []), action.event];
      const language = session.language;
      let rawContent = last?.rawContent ?? last?.content ?? "";
      let content = last?.content ?? "";
      if (shouldAppendEventContent(action.event)) {
        const delta = action.event.content;
        rawContent += delta;
        content = hasOpenUILang(rawContent)
          ? rawContent
          : appendWithEmphasisRepair(content, delta, rawContent, language);
      }
      const capability = last?.capability || session.activeCapability || "";
      const read = readUserInputIds(action.event);
      msgs[msgs.length - 1] = {
        ...(last || { role: "assistant", content: "" }),
        content,
        rawContent,
        events,
        capability,
      };
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages: msgs,
            queuedMessages: read.length
              ? (session.queuedMessages ?? []).filter(
                  (queued) => !read.includes(queued.id),
                )
              : session.queuedMessages,
            currentStage:
              action.event.type === "stage_start"
                ? action.event.stage
                : action.event.type === "stage_end"
                  ? ""
                  : session.currentStage,
            activeTurnId: action.event.turn_id || session.activeTurnId,
            lastSeq:
              action.event.turn_id &&
              action.event.turn_id !== session.activeTurnId
                ? action.event.seq || 0
                : Math.max(session.lastSeq, action.event.seq || 0),
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "STREAM_END": {
      const ending = state.sessions[action.key];
      if (action.submissionFailed && ending) {
        const messages = [...ending.messages];
        const placeholder = messages[messages.length - 1];
        const candidate =
          placeholder?.role === "assistant" &&
          !placeholder.content &&
          !(placeholder.events ?? []).length
            ? messages[messages.length - 2]
            : undefined;
        if (
          candidate?.role === "user" &&
          typeof candidate.id === "number" &&
          candidate.id < 0
        ) {
          messages.pop();
          messages[messages.length - 1] = {
            ...candidate,
            failedSubmission: true,
            ...(action.errorMessage
              ? { failedSubmissionMessage: action.errorMessage }
              : {}),
            failedSubmissionNoLlmAccess: action.submissionNoLlmAccess,
          };
          return {
            ...state,
            sessions: {
              ...state.sessions,
              [action.key]: {
                ...ending,
                messages,
                isStreaming: false,
                currentStage: "",
                status: action.status ?? "failed",
                activeTurnId: null,
                updatedAt: Date.now(),
              },
            },
            sidebarRefreshToken: state.sidebarRefreshToken + 1,
          };
        }
      }
      const settled = (() => {
        if (!ending?.messages?.length) return ending?.messages ?? [];
        const messages = [...ending.messages];
        const last = messages[messages.length - 1];
        if (last?.role !== "assistant") return messages;
        const raw = last.rawContent ?? last.content ?? "";
        const repaired =
          hasOpenUILang(raw) || hasLegacyOgui(raw)
            ? raw
            : repairChineseEmphasis(raw, ending.language);
        const trace =
          ending.isStreaming && last.trace?.started_at != null
            ? { ...last.trace, ended_at: Date.now() / 1000 }
            : last.trace;
        let events = last.events ?? [];
        if (
          ["cancelled", "failed", "rejected"].includes(action.status ?? "") &&
          !events.some(
            (event) => event.type === "error" && event.metadata?.turn_terminal,
          )
        ) {
          events = [
            ...events,
            {
              type: "error",
              source: "transport",
              stage: "",
              content:
                action.errorMessage ??
                [...events]
                  .reverse()
                  .find((event) => event.type === "error")?.content ??
                "",
              timestamp: Date.now() / 1000,
              metadata: {
                turn_terminal: true,
                status: action.status,
                retryable: action.status !== "cancelled",
              },
            },
          ];
        }
        if (
          repaired === last.content &&
          trace === last.trace &&
          events === last.events
        ) {
          return messages;
        }
        messages[messages.length - 1] = {
          ...last,
          content: repaired,
          trace,
          events,
        };
        return messages;
      })();
      const endedTurnId = action.turnId || ending?.activeTurnId || null;
      const pendingAskUser =
        action.status === "completed" &&
        hasPendingAskUserInMessages(settled, endedTurnId);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...(state.sessions[action.key] ?? createSessionEntry(action.key)),
            messages: settled,
            isStreaming: false,
            currentStage: "",
            queuedMessages: (ending?.queuedMessages ?? []).map((queued) =>
              queued.offeredTo ? { ...queued, offeredTo: null } : queued,
            ),
            status: action.status ?? "completed",
            submissionBaseStatus: action.status ?? "completed",
            activeTurnId:
              action.status === "running" || pendingAskUser
                ? action.turnId ||
                  state.sessions[action.key]?.activeTurnId ||
                  null
                : null,
            updatedAt: Date.now(),
          },
        },
        sidebarRefreshToken: state.sidebarRefreshToken + 1,
      };
    }
    case "BIND_SERVER_SESSION": {
      const current =
        state.sessions[action.key] ?? createSessionEntry(action.key);
      const targetKey = action.sessionId;
      const existing = state.sessions[targetKey];
      const merged: SessionEntry = {
        ...(existing ?? current),
        ...current,
        key: targetKey,
        boundFromKey:
          action.key === targetKey ? current.boundFromKey : action.key,
        sessionId: action.sessionId,
        sessionTitle: current.sessionTitle || existing?.sessionTitle || "",
        activeTurnId: action.turnId || current.activeTurnId,
        lastSeq:
          action.turnId && action.turnId !== current.activeTurnId
            ? 0
            : current.lastSeq,
        status: current.isStreaming ? "running" : current.status,
        updatedAt: Date.now(),
      };
      const nextSessions = { ...state.sessions };
      delete nextSessions[action.key];
      nextSessions[targetKey] = merged;
      const selectedKey =
        state.selectedKey === action.key ? targetKey : state.selectedKey;
      return {
        ...state,
        selectedKey,
        sessions: trimSessions(nextSessions, selectedKey),
        sidebarRefreshToken: state.sidebarRefreshToken + 1,
      };
    }
    case "SELECT_SESSION": {
      if (!state.sessions[action.key]) return state;
      if (state.selectedKey === action.key) return state;
      return { ...state, selectedKey: action.key };
    }
    case "LOAD_SESSION":
    case "REVALIDATE_SESSION": {
      if (action.type === "REVALIDATE_SESSION") {
        const local = state.sessions[action.key];
        if (!local || local.isStreaming || local.status === "running") {
          return state;
        }
      }
      const existing =
        state.sessions[action.key] ??
        createSessionEntry(action.key, action.sessionId);
      return {
        ...state,
        selectedKey:
          action.type === "LOAD_SESSION" ? action.key : state.selectedKey,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...existing,
            key: action.key,
            sessionId: action.sessionId,
            sessionTitle:
              action.title !== undefined ? action.title : existing.sessionTitle,
            enabledTools: action.tools ?? existing.enabledTools,
            activeCapability:
              action.capability !== undefined
                ? action.capability
                : existing.activeCapability,
            workspaceMode:
              action.workspaceMode !== undefined
                ? action.workspaceMode
                : existing.workspaceMode,
            knowledgeBases: action.knowledgeBases ?? existing.knowledgeBases,
            knowledgeBasesInitialized: true,
            llmSelection:
              action.llmSelection !== undefined
                ? action.llmSelection
                : existing.llmSelection,
            masteryPathId:
              action.masteryPathId !== undefined
                ? action.masteryPathId
                : existing.masteryPathId,
            masterySessionMode:
              action.masterySessionMode !== undefined
                ? action.masterySessionMode
                : existing.masterySessionMode,
            noteDocumentId:
              action.noteDocumentId !== undefined
                ? action.noteDocumentId
                : existing.noteDocumentId,
            createTarget:
              action.createTarget !== undefined
                ? action.createTarget
                : existing.createTarget,
            workspaceId:
              action.workspaceId !== undefined
                ? action.workspaceId
                : existing.workspaceId,
            personaSelection:
              action.personaSelection !== undefined
                ? action.personaSelection
                : existing.personaSelection,
            answerBy:
              action.answerBy !== undefined
                ? action.answerBy
                : existing.answerBy,
            resourceSelection:
              action.resourceSelection !== undefined
                ? action.resourceSelection
                : existing.resourceSelection,
            messages: action.messages,
            isStreaming: (action.status || "idle") === "running",
            currentStage: "",
            activeTurnId: action.activeTurnId || null,
            lastSeq: 0,
            status: action.status || "idle",
            submissionBaseStatus: action.serverStatus ?? action.status ?? "idle",
            language: action.language ?? existing.language,
            replyLanguageOverride:
              action.replyLanguageOverride !== undefined
                ? action.replyLanguageOverride
                : existing.replyLanguageOverride,
            selectedBranches:
              action.selectedBranches ?? existing.selectedBranches,
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "SET_SESSION_TITLE": {
      const session = state.sessions[action.key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            sessionTitle: action.title,
            updatedAt: Date.now(),
          },
        },
        sidebarRefreshToken: state.sidebarRefreshToken + 1,
      };
    }
    case "RECONCILE_TURN": {
      const session = state.sessions[action.key];
      if (!session) return state;
      const result = reconcileTurnIds(
        session.messages,
        session.selectedBranches,
        {
          turnId: action.turnId,
          userMessageId: action.userMessageId,
          assistantMessageId: action.assistantMessageId,
        },
      );
      if (!result.changed) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages: result.messages,
            selectedBranches: result.selectedBranches,
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "SET_MESSAGE_TRACE": {
      const session = state.sessions[action.key];
      if (!session) return state;
      const messages = session.messages.map((message) =>
        message.id === action.messageId && message.role === "assistant"
          ? { ...message, events: action.events, trace: action.trace }
          : message,
      );
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: { ...session, messages, updatedAt: Date.now() },
        },
      };
    }
    case "SETTLE_MESSAGE_TRACE": {
      const session = state.sessions[action.key];
      if (!session) return state;
      let changed = false;
      const messages = session.messages.map((message) => {
        const settleAction = traceSettleAction(message, action.messageId);
        if (settleAction === "skip") return message;
        changed = true;
        if (settleAction === "keep") {
          const settled = settleMessageTrace(
            message.events ?? [],
            action.turnId,
            message.trace,
          );
          return {
            ...message,
            trace: { ...settled.trace, truncated: false },
          };
        }
        return {
          ...message,
          ...settleMessageTrace(
            message.events ?? [],
            message.trace?.turn_id ?? "",
            message.trace,
          ),
        };
      });
      if (!changed) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: { ...session, messages, updatedAt: Date.now() },
        },
      };
    }
    case "SET_SELECTED_BRANCH": {
      const session = state.sessions[action.key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            selectedBranches: {
              ...session.selectedBranches,
              [action.parentKey]: action.childId,
            },
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "REPLACE_SELECTED_BRANCHES": {
      const session = state.sessions[action.key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            selectedBranches: { ...action.selectedBranches },
            updatedAt: Date.now(),
          },
        },
      };
    }
    case "DELETE_TURN": {
      const session = state.sessions[action.key];
      if (!session) return state;
      const idx = session.messages.findIndex((m) => m.id === action.messageId);
      if (idx === -1) return state;
      const msg = session.messages[idx];
      const toRemove = new Set<number>();
      toRemove.add(idx);
      if (msg.role === "user") {
        if (
          idx + 1 < session.messages.length &&
          session.messages[idx + 1].role === "assistant"
        ) {
          toRemove.add(idx + 1);
        }
      } else if (msg.role === "assistant") {
        if (idx - 1 >= 0 && session.messages[idx - 1].role === "user") {
          toRemove.add(idx - 1);
        }
      }
      const nextMessages = session.messages.filter((_, i) => !toRemove.has(i));
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.key]: {
            ...session,
            messages: nextMessages,
            isStreaming: false,
            status: "idle",
            updatedAt: Date.now(),
          },
        },
        sidebarRefreshToken: state.sidebarRefreshToken + 1,
      };
    }
    case "BUMP_SIDEBAR_REFRESH":
      return {
        ...state,
        sidebarRefreshToken: state.sidebarRefreshToken + 1,
      };
    case "NEW_SESSION":
      return selectFreshDraft(state, action.key, action.configuration);
    case "CONFIGURE_SESSION": {
      const key = action.key || state.selectedKey;
      if (!key) return state;
      const session = state.sessions[key];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [key]: applySessionConfiguration(session, action.configuration),
        },
      };
    }
    case "ENSURE_DRAFT_SESSION": {
      const fresh =
        state.selectedKey && state.sessions[state.selectedKey]
          ? state
          : selectFreshDraft(state, action.key);
      const selectedKey = fresh.selectedKey;
      if (!selectedKey || !action.failedRecords?.length) return fresh;
      const selected = fresh.sessions[selectedKey];
      if (selected.sessionId || selected.messages.length) return fresh;
      const messages: MessageItem[] = [];
      for (const record of action.failedRecords) {
        messages.push(
          restoredFailedMessage(record, messages.at(-1)?.id ?? null),
        );
      }
      return {
        ...fresh,
        sessions: {
          ...fresh.sessions,
          [selectedKey]: {
            ...selected,
            messages,
            status: "failed",
          },
        },
      };
    }
    default:
      return state;
  }
}
