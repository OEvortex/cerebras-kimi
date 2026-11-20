import type { StreamEvent, LLMSelection } from "@/features/chat/model/protocol";
import type { MessageTraceMetadata } from "@/features/chat/trace/memory";
import type {
  DeleteMessageResult,
  OrphanedFailedTurn,
} from "@/lib/session-api";
import type { FailedSubmissionRecord } from "@/lib/failed-submissions";
import type { BookReferencePayload } from "@/lib/book-references";
import type { WorkspaceMode } from "@/lib/workspace-mode";
import type { ReadingReferencePayload } from "@/lib/reading-references";
import type { readingTurnFields } from "@/lib/reading-turn-state";

export const POST_DONE_DISCONNECT_DELAY_MS = 15_000;
export const POST_DONE_TITLE_REFRESH_MS = 5_000;

export type SessionRuntimeStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

export interface OutgoingAttachment {
  type: string;
  url?: string;
  base64?: string;
  filename?: string;
  mime_type?: string;
}

export interface NotebookReferencePayload {
  notebook_id: string;
  record_ids: string[];
}

export type HistoryReferencePayload = string[];

export type QuestionNotebookReferencePayload = number[];

export type MemoryReferencePayload = Array<"summary" | "profile">;

export interface SendMessageOptions {
  displayUserMessage?: boolean;
  persistUserMessage?: boolean;
  requestSnapshotOverride?: MessageRequestSnapshot;
  /** Internal resend identity: reuse the original server correlation token. */
  retrySubmissionId?: string;
  replacesSubmissionId?: string;
  replacementRootSubmissionId?: string;
  replacedMessageId?: number;
  bookReferences?: BookReferencePayload[];
  readingReferences?: ReadingReferencePayload[];
  /** Edit-branching: when set, the new user message is inserted as a
   *  sibling under this parent rather than appended to the session tail.
   *  ``null`` means "explicitly attach to the session root". */
  parentMessageId?: number | null;
  /** Which mastery question this message is answering. */
  masteryAnswer?: { question_id: string; text: string } | null;
  /** Which mastery question this message drops. */
  masterySkip?: { question_id: string } | null;
  /** Run this one turn in another mode without switching the conversation's own mode. */
  capability?: string;
  /** The note page's learning block this turn fills in (note companion). */
  noteGeneration?: { block_id: string; kind?: string } | null;
}

/** Per-conversation narrowing of the workspace's skill and MCP selections. */
export interface ResourceSelection {
  skills: string[];
  mcp: string[];
}

export function emptyResourceSelection(): ResourceSelection {
  return { skills: [], mcp: [] };
}

/**
 * A message sent while a turn was still running.
 */
export interface QueuedMessage {
  /** Also the command id it is offered to the running turn under. */
  id: string;
  content: string;
  /** The send it becomes as a turn of its own. */
  send: Parameters<ChatContextValue["sendMessage"]>;
  /** Text only, so the running turn can take it. */
  steerable: boolean;
  /** The turn it was offered to; null until offered. */
  offeredTo: string | null;
}

export interface ChatState {
  /** Local identity, available before the backend assigns a session ID. */
  sessionKey: string;
  /** The draft key this entry had before the server bound it to a session. */
  boundFromKey?: string | null;
  sessionId: string | null;
  sessionTitle: string;
  enabledTools: string[];
  activeCapability: string | null;
  /** Stable product surface; per-turn capability selection is orthogonal. */
  workspaceMode: WorkspaceMode | null;
  knowledgeBases: string[];
  /** A saved or explicit choice, including an explicit empty selection. */
  knowledgeBasesInitialized: boolean;
  llmSelection: LLMSelection | null;
  /** Persistent mastery state associated with this conversation. */
  masteryPathId: string | null;
  /** Note page this conversation is held beside (the notebook's companion). */
  noteDocumentId: string | null;
  /** Create mode: the artifact kind ("skill" | "persona") this conversation is authoring. */
  createTarget: string | null;
  /** What this mastery conversation is for — "outline" | "study" | "review". */
  masterySessionMode: string | null;
  workspaceId: string | null;
  /** Session-level persona preference; "" = Default (no persona). */
  personaSelection: string;
  /** Who answers this conversation instead of DeepTutor — `partner:<id>` or `subagent:<name>`. */
  answerBy: string | null;
  /** Skills and MCP servers this conversation narrowed itself to. */
  resourceSelection: ResourceSelection;
  messages: MessageItem[];
  isStreaming: boolean;
  currentStage: string;
  language: string;
  /** Edit-branching: keyed by stringified parent_message_id (or "null" for the root). */
  selectedBranches: Record<string, number>;
  /** True when the last turn ended in a failure (not a user cancel). */
  lastTurnFailed: boolean;
  /** True when the tail of the transcript is a user row the server never accepted (#1594). */
  submissionFailed: boolean;
  submissionNoLlmAccess: boolean;
  /** The text was recovered without its attachments or other request context. */
  submissionNeedsReview: boolean;
  /** No browser storage accepted even the text. Copy before leaving this tab. */
  submissionNotSaved: boolean;
  /** The server's own rejection text for the flagged submission (#2637). */
  submissionErrorMessage: string;
  /** Messages sent while a turn ran, oldest first. */
  queuedMessages: QueuedMessage[];
}

export interface SessionConfiguration {
  llmSelection?: LLMSelection | null;
  capability?: string | null;
  workspaceMode?: WorkspaceMode | null;
  knowledgeBases?: string[];
  masteryPathId?: string | null;
  masterySessionMode?: string | null;
  noteDocumentId?: string | null;
  createTarget?: string | null;
  workspaceId?: string | null;
  enabledTools?: string[];
}

export interface SessionStatusSnapshot {
  sessionId: string;
  status: SessionRuntimeStatus;
  activeTurnId: string | null;
  updatedAt: number;
}

export interface MessageAttachment {
  type: string;
  filename?: string;
  base64?: string;
  url?: string;
  mime_type?: string;
  id?: string;
  extracted_text?: string;
  generated?: boolean;
  size_bytes?: number;
  origin?: "workspace";
  workspace_id?: string;
  workspace_item_id?: string;
  relative_path?: string;
  sha256?: string;
  title?: string;
  caption?: string;
}

export interface MessageRequestSnapshot {
  submissionRequest?: Record<string, unknown>;
  replacesSubmissionId?: string;
  replacementRootSubmissionId?: string;
  replacementRequest?: Record<string, unknown>;
  resourceSelection?: ResourceSelection;
  content: string;
  capability?: string | null;
  workspaceMode?: WorkspaceMode | null;
  workspaceId?: string | null;
  enabledTools: string[];
  knowledgeBases: string[];
  language: string;
  attachments?: MessageAttachment[];
  config?: Record<string, unknown>;
  notebookReferences?: NotebookReferencePayload[];
  historyReferences?: HistoryReferencePayload;
  questionNotebookReferences?: QuestionNotebookReferencePayload;
  bookReferences?: BookReferencePayload[];
  readingReferences?: ReadingReferencePayload[];
  masteryPathId?: string;
  masterySessionMode?: string;
  masteryAnswer?: { question_id: string; text: string };
  masterySkip?: { question_id: string };
  timedMediaId?: string;
  persona?: string;
  createTarget?: string | null;
  memoryReferences?: MemoryReferencePayload;
  llmSelection?: LLMSelection | null;
  readingMaterialId?: string;
  readingMaterialRevision?: number;
  readingSelection?: ReadingSelectionSnapshot;
  readingTurnFields?: ReturnType<typeof readingTurnFields>;
  watchingTurnFields?: {
    timed_media_id?: string;
    timed_media_viewport?: { time_seconds: number };
  };
  capabilityOnce?: boolean;
  noteGeneration?: { block_id: string; kind?: string };
}

export interface ReadingSelectionSnapshot {
  quote: string;
  locator: number;
}

export interface MessageItem {
  id?: number;
  role: "user" | "assistant" | "system";
  content: string;
  rawContent?: string;
  capability?: string;
  events?: StreamEvent[];
  attachments?: MessageAttachment[];
  requestSnapshot?: MessageRequestSnapshot;
  trace?: MessageTraceMetadata;
  parentMessageId?: number | null;
  failedSubmission?: boolean;
  failedSubmissionNoLlmAccess?: boolean;
  failedSubmissionNeedsReview?: boolean;
  failedSubmissionNotSaved?: boolean;
  failedSubmissionId?: string;
  failedSubmissionMessage?: string;
  orphanedFailedTurn?: OrphanedFailedTurn;
}

export interface SessionEntry extends Omit<ChatState, "sessionKey"> {
  key: string;
  status: SessionRuntimeStatus;
  submissionBaseStatus: SessionRuntimeStatus;
  activeTurnId: string | null;
  lastSeq: number;
  updatedAt: number;
  selectedBranches: Record<string, number>;
}

export interface ProviderState {
  selectedKey: string | null;
  sessions: Record<string, SessionEntry>;
  sidebarRefreshToken: number;
}

export interface SessionSnapshot {
  key: string;
  sessionId: string;
  title?: string;
  messages: MessageItem[];
  activeTurnId?: string | null;
  status?: SessionRuntimeStatus;
  serverStatus?: SessionRuntimeStatus;
  tools?: string[];
  capability?: string | null;
  workspaceMode?: WorkspaceMode | null;
  knowledgeBases?: string[];
  llmSelection?: LLMSelection | null;
  masteryPathId?: string | null;
  masterySessionMode?: string | null;
  noteDocumentId?: string | null;
  createTarget?: string | null;
  workspaceId?: string | null;
  personaSelection?: string;
  answerBy?: string | null;
  resourceSelection?: ResourceSelection;
  language?: string;
  selectedBranches?: Record<string, number>;
}

export type Action =
  | { type: "RESET_ACCOUNT" }
  | { type: "SET_TOOLS"; tools: string[] }
  | { type: "SET_CAPABILITY"; cap: string | null }
  | { type: "SET_KB"; kbs: string[] }
  | {
      type: "INITIALIZE_KB";
      key: string;
      workspaceId: string | null;
      kbs: string[];
    }
  | { type: "SET_LLM_SELECTION"; selection: LLMSelection | null }
  | { type: "SET_MASTERY_PATH_ID"; masteryPathId: string | null; key?: string }
  | { type: "SET_MASTERY_SESSION_MODE"; mode: string | null; key?: string }
  | { type: "SET_PERSONA_SELECTION"; persona: string }
  | { type: "SET_ANSWER_BY"; answerBy: string | null }
  | { type: "SET_RESOURCE_SELECTION"; selection: ResourceSelection }
  | { type: "SET_CREATE_TARGET"; createTarget: string | null }
  | { type: "SET_LANGUAGE"; lang: string }
  | {
      type: "ADD_USER_MSG";
      key: string;
      content: string;
      capability?: string | null;
      attachments?: MessageAttachment[];
      requestSnapshot?: MessageRequestSnapshot;
      parentMessageId?: number | null;
      failedSubmissionId?: string;
    }
  | {
      type: "SET_SUBMISSION_PERSISTENCE";
      key: string;
      submissionId: string;
      saved: boolean;
    }
  | { type: "POP_LAST_ASSISTANT"; key: string }
  | { type: "RESTORE_ASSISTANT"; key: string; message: MessageItem }
  | {
      type: "STREAM_START";
      key: string;
      startedAt: number;
      capability?: string | null;
    }
  | { type: "QUEUE_MESSAGE"; key: string; message: QueuedMessage }
  | { type: "OFFER_QUEUED"; key: string; ids: string[]; turnId: string }
  | { type: "DROP_QUEUED"; key: string; ids: string[] }
  | { type: "STREAM_TOUCH"; key: string }
  | { type: "STREAM_EVENT"; key: string; event: StreamEvent }
  | {
      type: "STREAM_END";
      key: string;
      status?: SessionRuntimeStatus;
      errorMessage?: string;
      turnId?: string | null;
      submissionFailed?: boolean;
      submissionNoLlmAccess?: boolean;
    }
  | {
      type: "BIND_SERVER_SESSION";
      key: string;
      sessionId: string;
      turnId?: string | null;
    }
  | ({ type: "LOAD_SESSION" } & SessionSnapshot)
  | ({ type: "REVALIDATE_SESSION" } & SessionSnapshot)
  | { type: "SELECT_SESSION"; key: string }
  | { type: "SET_SESSION_TITLE"; key: string; title: string }
  | {
      type: "RECONCILE_TURN";
      key: string;
      turnId?: string | null;
      userMessageId?: number | null;
      assistantMessageId?: number | null;
    }
  | {
      type: "SET_MESSAGE_TRACE";
      key: string;
      messageId: number;
      events: StreamEvent[];
      trace: MessageTraceMetadata;
    }
  | {
      type: "SETTLE_MESSAGE_TRACE";
      key: string;
      messageId: number;
      turnId: string | null;
    }
  | { type: "DELETE_TURN"; key: string; messageId: number }
  | {
      type: "DISCARD_FAILED_SUBMISSION";
      key: string;
      messageId: number;
      submissionId: string;
    }
  | {
      type: "NEW_SESSION";
      key: string;
      configuration?: SessionConfiguration;
    }
  | {
      type: "CONFIGURE_SESSION";
      key?: string;
      configuration: SessionConfiguration;
    }
  | {
      type: "ENSURE_DRAFT_SESSION";
      key: string;
      failedRecords?: FailedSubmissionRecord[];
    }
  | {
      type: "SET_SELECTED_BRANCH";
      key: string;
      parentKey: string;
      childId: number;
    }
  | {
      type: "REPLACE_SELECTED_BRANCHES";
      key: string;
      selectedBranches: Record<string, number>;
    }
  | { type: "BUMP_SIDEBAR_REFRESH" };

export interface ChatContextValue {
  state: ChatState;
  setTools: (tools: string[]) => void;
  setCapability: (cap: string | null) => void;
  setKBs: (kbs: string[]) => void;
  initializeKBs: (
    key: string,
    workspaceId: string | null,
    kbs: string[],
  ) => void;
  setLLMSelection: (selection: LLMSelection | null) => void;
  setMasteryPathId: (masteryPathId: string | null) => void;
  setMasterySessionMode: (mode: string | null) => void;
  setPersonaSelection: (persona: string) => void;
  setAnswerBy: (answerBy: string | null) => void;
  setResourceSelection: (selection: ResourceSelection) => void;
  setCreateTarget: (createTarget: string | null) => void;
  setLanguage: (lang: string) => void;
  sendMessage: (
    content: string,
    attachments?: OutgoingAttachment[],
    config?: Record<string, unknown>,
    notebookReferences?: NotebookReferencePayload[],
    historyReferences?: HistoryReferencePayload,
    options?: SendMessageOptions,
    questionNotebookReferences?: QuestionNotebookReferencePayload,
    persona?: string,
    memoryReferences?: MemoryReferencePayload,
  ) => void;
  queueMessage: (
    content: string,
    send: QueuedMessage["send"],
    steerable: boolean,
  ) => void;
  withdrawQueuedMessage: (id: string) => void;
  cancelStreamingTurn: () => void;
  submitUserReply: (
    reply:
      | string
      | {
          text?: string;
          answers?: Array<{ questionId: string; text: string }>;
        },
  ) => Promise<boolean>;
  regenerateLastMessage: () => void;
  resendLastMessage: () => void;
  deleteTurn: (messageId: number) => Promise<DeleteMessageResult>;
  discardFailedSubmission: (messageId: number) => boolean;
  editMessage: (messageId: number, newContent: string) => Promise<boolean>;
  retryFailedSubmission: (messageId: number) => Promise<boolean>;
  switchBranch: (parentMessageId: number | null, childId: number) => void;
  renameSessionTitle: (title: string) => Promise<void>;
  newSession: (configuration?: SessionConfiguration) => string;
  configureSession: (
    configuration: SessionConfiguration,
    sessionKey?: string,
  ) => void;
  loadSession: (
    sessionId: string,
    options?: { signal?: AbortSignal; revalidate?: boolean },
  ) => Promise<MessageItem[] | undefined>;
  showCachedSession: (sessionId: string) => boolean;
  loadMessageTrace: (sessionId: string, messageId: number) => Promise<void>;
  releaseMessageTrace: (sessionId: string, messageId: number) => void;
  selectedSessionId: string | null;
  sessionStatuses: Record<string, SessionStatusSnapshot>;
  sidebarRefreshToken: number;
}
