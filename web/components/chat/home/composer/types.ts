import type { ReactNode, RefObject } from "react";
import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import type { SelectedRecord } from "@/lib/notebook-selection-types";
import type { LLMSelection } from "@/features/chat/model/protocol";
import type { LLMOption } from "@/lib/llm-options";
import type { SpaceMemoryFile } from "@/lib/space-items";
import type { SelectedBookReference } from "@/lib/book-references";
import type { SelectedReadingReference } from "@/lib/reading-references";
import type { ComposerResourceCatalog } from "@/hooks/useComposerResources";
import type { ResourceSelection } from "@/features/chat/ChatStateAdapter";
import type { CapabilityDef } from "@/features/capabilities/presentation";
import type { AttachmentProcessingItem } from "@/features/chat/selectors/attachment-processing";
import type { ContextBudget } from "../ContextBudgetChip";

export type SpaceSelectionCounts = {
  attachments: number;
  knowledge: number;
  chatHistory: number;
  myAgents: number;
  books: number;
  reading: number;
  notebooks: number;
  questionBank: number;
  persona: number;
  memory: number;
};

export interface PendingAttachment {
  type: string;
  filename: string;
  base64?: string;
  previewUrl?: string;
  size?: number;
  mimeType?: string;
  text?: string;
}

export interface KnowledgeBase {
  name: string;
}

/**
 * The composer's primary action is a single control that spans the whole
 * turn — send, working, stop — rather than two buttons that swap places at
 * the moment of the click. These are its four states; only the skin changes.
 */
export type SendState = "idle" | "blocked" | "ready" | "streaming";

/**
 * `idle` keeps a legible glyph on a hairline ring instead of fading the whole
 * button down: a translucent arrow on an equally translucent fill left the
 * arrow invisible in every theme. Readiness is carried by colour (neutral →
 * primary), not by opacity.
 *
 * Translucency goes through `color-mix` rather than Tailwind's `/NN` opacity
 * modifier. Tailwind 3 can only apply that modifier to colours it can split
 * into channels, so `bg-[var(--primary)]/90` — where the variable holds a hex
 * literal — compiles to nothing at all. `hover:ring-[5px]` and the lift carry
 * the hover state here; the fill deliberately doesn't shift, which also keeps
 * it from having to mix in a direction that reads right on all four themes.
 */
export const SEND_STATE_CLASS: Record<SendState, string> = {
  idle: "cursor-default text-[var(--muted-foreground)] ring-1 ring-inset ring-[var(--border)]",
  // The glyph goes to `--foreground`, not `--primary-foreground`: this fill is
  // a wash of `--muted-foreground` and therefore sits near the background, so
  // only the foreground colour is guaranteed to read against it on all four
  // themes. (Inherited as `--primary-foreground`, which was white on pale grey
  // — invisible — but never showed because the old `/30` compiled to nothing.)
  blocked:
    "bg-[color-mix(in_srgb,var(--muted-foreground)_30%,transparent)] text-[var(--foreground)] hover:bg-[color-mix(in_srgb,var(--muted-foreground)_45%,transparent)]",
  ready:
    "bg-[var(--primary)] text-[var(--primary-foreground)] ring-[3px] ring-[color-mix(in_srgb,var(--primary)_18%,transparent)] hover:-translate-y-px hover:ring-[5px]",
  streaming: "bg-[var(--primary)] text-[var(--primary-foreground)]",
};

export interface ChatComposerProps {
  taskSessionId?: string | null;
  draftTaskIds?: string[];
  onDraftTaskIdsChange?: (ids: string[]) => void;
  onTasksLinked?: () => void;
  composerRef: RefObject<HTMLDivElement | null>;
  capMenuRef: RefObject<HTMLDivElement | null>;
  capBtnRef: RefObject<HTMLButtonElement | null>;
  spaceMenuRef: RefObject<HTMLDivElement | null>;
  spaceBtnRef: RefObject<HTMLButtonElement | null>;
  dragCounter: RefObject<number>;
  dragging: boolean;
  capMenuOpen: boolean;
  /* The conversation's workspace, for task links. Choosing it is the
     shell's job (the sidebar and the location chip), not the composer's. */
  workspaceId?: string;
  spaceMenuOpen: boolean;
  hasMessages: boolean;
  attachments: PendingAttachment[];
  attachmentError: string | null;
  attachmentProcessing?: AttachmentProcessingItem[];
  activeCap: CapabilityDef;
  knowledgeBases: KnowledgeBase[];
  /** Connected local subagents (Claude Code / Codex) selectable for this turn. */
  connectedAgents?: { name: string; kind?: string }[];
  /** The connected agent selected for this turn, if any (single-select). */
  selectedPartner?: string | null;
  onSelectPartner?: (id: string | null) => void;
  selectedPartnerGroup?: string | null;
  onSelectPartnerGroup?: (id: string | null) => void;
  /** Who answers instead of DeepTutor: `partner:<id>`, `subagent:<name>`, or null. */
  answerBy?: string | null;
  onAnswerByChange?: (value: string | null) => void;
  selectedAgent?: string | null;
  onSelectAgent?: (name: string | null) => void;
  /** Max times DeepTutor may consult the selected agent this turn. */
  subagentBudget?: number | null;
  onSubagentBudgetChange?: (budget: number) => void;
  llmOptions: LLMOption[];
  activeLLMDefault: LLMSelection | null;
  llmSelection: LLMSelection | null;
  llmOptionsLoading: boolean;
  llmOptionsError: boolean;
  onRefreshLLMOptions?: () => void;
  /**
   * Context-window breakdown measured on the last turn that reported one.
   * Omitted by surfaces that don't track it (quiz follow-up) and null until
   * the first turn completes — the chip is skipped entirely in both cases.
   */
  contextBudget?: ContextBudget | null;
  selectedNotebookRecords: SelectedRecord[];
  selectedBookReferences: SelectedBookReference[];
  selectedReadingReferences?: SelectedReadingReference[];
  selectedHistorySessions: SelectedHistorySession[];
  selectedAgentSessions: SelectedHistorySession[];
  selectedQuestionEntries: SelectedQuestionEntry[];
  notebookReferenceGroups: Array<{
    notebookId: string;
    notebookName: string;
    count: number;
  }>;
  selectedPersona: string | null;
  selectedMemoryFiles: SpaceMemoryFile[];
  selectedKnowledgeBases: string[];
  isStreaming: boolean;
  /** The live turn is paused on an ask_user card and needs an answer. */
  awaitingUserReply?: boolean;
  isVisualizeMode: boolean;
  /**
   * True when the active capability (e.g. Quiz / Visualize / Research)
   * requires explicit configuration before sending. When true, `canSend`
   * is gated on `capabilityConfigConfirmed`.
   */
  capabilityNeedsConfig: boolean;
  capabilityConfigConfirmed: boolean;
  /**
   * Called when the user clicks the send button while config is required
   * but not yet confirmed. The page uses this to surface the config card
   * (open the Activity panel, scroll to it, etc.).
   */
  onRequestConfigConfirm: () => void;
  capabilities: CapabilityDef[];
  customizable?: boolean;
  onSetCapMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  onSetSpaceMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  onToggleKB: (name: string) => void;
  onSelectLLM: (selection: LLMSelection | null) => void;
  onSelectNotebookPicker: () => void;
  onSelectBookPicker: () => void;
  onSelectReadingPicker?: () => void;
  onSelectHistoryPicker: () => void;
  onSelectAgentsPicker: () => void;
  onSelectQuestionBankPicker: () => void;
  onSelectPersonaPicker: () => void;
  onSelectMemoryPicker: () => void;
  onClearPersona: () => void;
  /**
   * Session-persona wiring (main chat only). When `onPersonaSelectionChange`
   * is provided, the tray's answer list offers response styles and the
   * composer accepts `/persona`, which opens that list. The quiz follow-up
   * surface omits these and keeps its per-turn persona picker flow.
   */
  personaSelection?: string;
  onPersonaSelectionChange?: (persona: string) => void;
  personaSelectorOpen?: boolean;
  onPersonaSelectorOpenChange?: (open: boolean) => void;
  /**
   * Skill / MCP narrowing for this conversation. Supplied together: the
   * catalog is what may be picked (already clipped to what the workspace
   * allows) and the selection is what was picked, where empty means the
   * conversation inherits everything. Surfaces without a rail omit all three
   * and keep inheriting, exactly as before the pickers existed.
   */
  resourceCatalog?: ComposerResourceCatalog;
  resourceSelection?: ResourceSelection;
  onResourceSelectionChange?: (selection: ResourceSelection) => void;
  /** Create mode: the artifact kind this conversation is authoring, or null.
   *  Rendered (and its tray entry shown) only when a parent supplies both. */
  createTarget?: string | null;
  onCreateTargetChange?: (value: string | null) => void;
  /** Hide the My Agents reference entry (e.g. the quiz follow-up surface). */
  agentsAvailable?: boolean;
  onToggleMemoryFile: (file: SpaceMemoryFile) => void;
  onSend: (content: string) => void;
  onRemoveAttachment: (index: number) => void;
  onPreviewAttachment?: (index: number) => void;
  onRemoveHistory: (sessionId: string) => void;
  onRemoveAgent: (sessionId: string) => void;
  onRemoveBookReference: (bookId: string) => void;
  onRemoveReadingReference?: (materialId: string) => void;
  onRemoveNotebook: (notebookId: string) => void;
  onRemoveQuestion: (entryId: number) => void;
  onDragEnter: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onAddFiles: (files: File[]) => void;
  onSelectCapability: (value: string) => void;
  onCancelStreaming: () => void;
  /**
   * Optional ref the composer writes its ``prefillInput`` function into
   * once mounted, so the message-list side (specifically
   * ``AskUserOptions`` chips) can drop a string into the textarea
   * without owning the composer's imperative handle directly.
   */
  prefillInputRef?: React.MutableRefObject<((text: string) => void) | null>;
  /** Receives a function that puts the caret in the textarea. */
  focusInputRef?: React.MutableRefObject<(() => void) | null>;
  /** Let a message be sent while a turn runs; the surface queues it. */
  queueWhileStreaming?: boolean;
  /** Shown just above the input, under any attachments (the queue). */
  inputFooter?: ReactNode;
  /** Override the composer placeholder (e.g. quiz follow-up). */
  inputPlaceholder?: string;
  /** A line Tab accepts while the composer is empty. See ComposerInput. */
  inputPlaceholderCompletion?: string;
  /**
   * Surface-owned context shown inside the box, above the text — the reading
   * companion's quoted passage. Inside rather than above, so it reads as part
   * of the message being written instead of a card floating over it.
   */
  inputHeader?: ReactNode;
  /**
   * Hide the capability chip. A surface that only ever runs one capability
   * — and names it in its own chrome — gains nothing from a picker that
   * cannot pick anything.
   */
  showCapabilityChip?: boolean;
  /**
   * The composer sits at the foot of a narrow pane (a side chat) rather than
   * in the middle of an empty page: it stays one line tall from the start and
   * its lists always open upward, into the pane, never off its bottom edge.
   */
  docked?: boolean;
  /** A surface's own control at the far end of the tray (who answers). */
  trayEnd?: ReactNode;
}
