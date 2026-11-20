import {
  BookMarked,
  BookOpen,
  Bot,
  Brain,
  ClipboardList,
  Database,
  MessageSquare,
  Paperclip,
  PencilRuler,
  UserRound,
} from "lucide-react";
import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import type { SelectedRecord } from "@/lib/notebook-selection-types";
import type { SpaceMemoryFile } from "@/lib/space-items";
import type { SelectedBookReference } from "@/lib/book-references";
import type { SelectedReadingReference } from "@/lib/reading-references";
import type { ResourceSelection } from "@/features/chat/ChatStateAdapter";
import type { CapabilityDef } from "@/features/capabilities/presentation";
import { knowledgeBaseRef } from "@/lib/knowledge-helpers";
import { isQuoteAttachment } from "@/lib/quote-attachments";
import { CREATE_KINDS, isCreationKind } from "@/lib/creations";
import type { PartnerInfo } from "@/lib/partners-api";
import type { PartnerGroup } from "@/lib/partner-groups-api";
import type { ComposerResourceItem } from "../ComposerResources";
import KnowledgeSelector from "../KnowledgeSelector";
import type { TrayCreate, TrayMode } from "../ComposerTray";
import type { AnswerModeProps, PartnerLinkProps } from "../AnswerModeMenu";
import type { LeadToken } from "../ComposerLead";
import { modeIcon } from "../ComposerIcons";
import type { ContextTreeItem } from "../ContextReferenceTree";
import type {
  KnowledgeBase,
  PendingAttachment,
  SpaceSelectionCounts,
} from "./types";


export function buildSpaceSelectionCounts(params: {
  attachments: PendingAttachment[];
  selectedKnowledgeBases: string[];
  selectedHistorySessions: SelectedHistorySession[];
  selectedAgentSessions: SelectedHistorySession[];
  selectedBookReferences: SelectedBookReference[];
  selectedReadingReferences: SelectedReadingReference[];
  selectedNotebookRecords: SelectedRecord[];
  selectedQuestionEntries: SelectedQuestionEntry[];
  selectedPersona: string | null;
  selectedMemoryFiles: SpaceMemoryFile[];
}): SpaceSelectionCounts {
  return {
    attachments: params.attachments.length,
    knowledge: params.selectedKnowledgeBases.length,
    chatHistory: params.selectedHistorySessions.length,
    myAgents: params.selectedAgentSessions.length,
    books: params.selectedBookReferences.reduce(
      (total, ref) => total + ref.pages.length,
      0,
    ),
    reading: params.selectedReadingReferences.reduce(
      (total, reference) => total + reference.units.length,
      0,
    ),
    notebooks: params.selectedNotebookRecords.length,
    questionBank: params.selectedQuestionEntries.length,
    persona: params.selectedPersona ? 1 : 0,
    memory: params.selectedMemoryFiles.length,
  };
}

export function buildContextTreeItems(params: {
  attachments: PendingAttachment[];
  selectedKnowledgeBases: string[];
  knowledgeBases: KnowledgeBase[];
  selectedBookReferences: SelectedBookReference[];
  selectedReadingReferences: SelectedReadingReference[];
  notebookReferenceGroups: Array<{
    notebookId: string;
    notebookName: string;
    count: number;
  }>;
  selectedHistorySessions: SelectedHistorySession[];
  selectedAgentSessions: SelectedHistorySession[];
  selectedQuestionEntries: SelectedQuestionEntry[];
  selectedPersona: string | null;
  selectedMemoryFiles: SpaceMemoryFile[];
  onPreviewAttachment?: (index: number) => void;
  onRemoveAttachment: (index: number) => void;
  onToggleKB: (name: string) => void;
  onRemoveBookReference: (bookId: string) => void;
  onRemoveReadingReference?: (materialId: string) => void;
  onRemoveNotebook: (notebookId: string) => void;
  onRemoveHistory: (sessionId: string) => void;
  onRemoveAgent: (sessionId: string) => void;
  onRemoveQuestion: (entryId: number) => void;
  onClearPersona: () => void;
  onToggleMemoryFile: (file: SpaceMemoryFile) => void;
}): ContextTreeItem[] {
  return [
    // Quotes are drawn as passages above the input, not listed as files.
    ...params.attachments.flatMap((file, index): ContextTreeItem[] =>
      isQuoteAttachment(file)
        ? []
        : [
            {
              key: `file-${index}`,
              icon: Paperclip,
              kind: "Attach files",
              label: file.filename,
              thumbnailUrl: file.type === "image" ? file.previewUrl : undefined,
              onClick: () => params.onPreviewAttachment?.(index),
              onRemove: () => params.onRemoveAttachment(index),
            },
          ],
    ),
    ...params.selectedKnowledgeBases.map(
      (id): ContextTreeItem => ({
        key: `kb-${id}`,
        icon: Database,
        kind: "Knowledge",
        label:
          params.knowledgeBases.find((kb) => knowledgeBaseRef(kb) === id)?.name ||
          id,
        onRemove: () => params.onToggleKB(id),
      }),
    ),
    ...params.selectedBookReferences.map(
      (book): ContextTreeItem => ({
        key: `book-${book.bookId}`,
        icon: BookOpen,
        kind: "Book",
        label: `${book.bookTitle} (${book.pages.length})`,
        onRemove: () => params.onRemoveBookReference(book.bookId),
      }),
    ),
    ...params.selectedReadingReferences.map(
      (material): ContextTreeItem => ({
        key: `reading-${material.materialId}-r${material.revision}`,
        icon: BookMarked,
        kind: "Reading",
        label: `${material.materialTitle} (${material.units.length})`,
        onRemove: params.onRemoveReadingReference
          ? () => params.onRemoveReadingReference?.(material.materialId)
          : undefined,
      }),
    ),
    ...params.notebookReferenceGroups.map(
      (group): ContextTreeItem => ({
        key: `nb-${group.notebookId}`,
        icon: BookOpen,
        kind: "Favorites",
        label: `${group.notebookName} (${group.count})`,
        onRemove: () => params.onRemoveNotebook(group.notebookId),
      }),
    ),
    ...params.selectedHistorySessions.map(
      (session): ContextTreeItem => ({
        key: `hist-${session.sessionId}`,
        icon: MessageSquare,
        kind: "Chat History",
        label: session.title,
        onRemove: () => params.onRemoveHistory(session.sessionId),
      }),
    ),
    ...params.selectedAgentSessions.map(
      (session): ContextTreeItem => ({
        key: `agent-${session.sessionId}`,
        icon: Bot,
        kind: "Subagents",
        label: session.title,
        onRemove: () => params.onRemoveAgent(session.sessionId),
      }),
    ),
    ...params.selectedQuestionEntries.map(
      (entry): ContextTreeItem => ({
        key: `q-${entry.id}`,
        icon: ClipboardList,
        kind: "Question Bank",
        label: entry.question,
        onRemove: () => params.onRemoveQuestion(entry.id),
      }),
    ),
    ...(params.selectedPersona
      ? [
          {
            key: "persona",
            icon: UserRound,
            kind: "Persona",
            label: params.selectedPersona,
            onRemove: params.onClearPersona,
          } satisfies ContextTreeItem,
        ]
      : []),
    ...params.selectedMemoryFiles.map(
      (file): ContextTreeItem => ({
        key: `mem-${file}`,
        icon: Brain,
        kind: "Memory",
        label: file === "summary" ? "Summary" : "Profile",
        onRemove: () => params.onToggleMemoryFile(file),
      }),
    ),
  ];
}

export function buildKnowledgeResourceItems(params: {
  knowledgeBases: KnowledgeBase[];
  selectedKnowledgeBases: string[];
  onToggleKB?: (name: string) => void;
}): ComposerResourceItem[] {
  const { knowledgeBases, selectedKnowledgeBases, onToggleKB } = params;
  // The panel holds materials only; skills, connectors and how to answer live
  // in the tray under the box. Omitted catalogs stay hidden.
  const resourceItems: ComposerResourceItem[] = [];
  if (onToggleKB) {
    resourceItems.push({
      key: "knowledge",
      group: "Reference materials",
      summary: selectedKnowledgeBases.length
        ? `${selectedKnowledgeBases.length} ${"selected"}`
        : knowledgeBases.length > 0
          ? "Default"
          : "No KB",
      onClear: selectedKnowledgeBases.length
        ? () => [...selectedKnowledgeBases].forEach(onToggleKB)
        : undefined,
      label: "Knowledge",
      icon: Database,
      count: selectedKnowledgeBases.length,
      node: (
        <KnowledgeSelector
          knowledgeBases={knowledgeBases}
          selected={selectedKnowledgeBases}
          onToggle={onToggleKB}
          embedded
        />
      ),
    });
  }
  return resourceItems;
}

export function buildTrayConfig(params: {
  capabilityLabel: (cap: CapabilityDef) => string;
  modeInTray: boolean;
  activeCap: CapabilityDef;
  capabilities: CapabilityDef[];
  onSelectCapability: (value: string) => void;
  createTarget: string | null;
  onCreateTargetChange?: (value: string | null) => void;
  resourceSelection?: ResourceSelection;
  onResourceSelectionChange?: (selection: ResourceSelection) => void;
  onPersonaSelectionChange?: (persona: string) => void;
  personaSelectorOpen?: boolean;
  onPersonaSelectorOpenChange?: (open: boolean) => void;
  answerBy: string | null;
  onAnswerByChange?: (value: string | null) => void;
  connectedAgents: { name: string; kind?: string }[];
  selectedAgent: string | null;
  onSelectAgent?: (name: string | null) => void;
  subagentBudget: number | null;
  onSubagentBudgetChange?: (budget: number) => void;
  partners: PartnerInfo[];
  partnersLoading: boolean;
  partnerLoadError: boolean;
  selectedPartner: string | null;
  onSelectPartner?: (id: string | null) => void;
  partnerGroups: PartnerGroup[];
  groupsLoading: boolean;
  groupLoadError: boolean;
  selectedPartnerGroup: string | null;
  onSelectPartnerGroup?: (id: string | null) => void;
}) {
  const { capabilityLabel } = params;

  // The mode, skills and connectors from the tray open the message itself
  // instead of joining the attachments: they say how to answer, not what to
  // read. The mode goes first, the way a command would.
  const modeToken: LeadToken[] =
    params.modeInTray && params.activeCap.value
      ? [
          {
            key: `mode:${params.activeCap.value}`,
            icon: modeIcon(params.activeCap),
            kind: "Mode",
            label: capabilityLabel(params.activeCap),
            onRemove: () => params.onSelectCapability(""),
          },
        ]
      : [];

  const trayMode: TrayMode | undefined = params.modeInTray
    ? {
        capabilities: params.capabilities,
        value: params.activeCap.value,
        onChange: params.onSelectCapability,
      }
    : undefined;

  // Create mode's own chip reads "Create Skill" / "Create Persona" and comes
  // before even the mode token: picking a kind already forced the mode back
  // to plain chat (see `trayCreate.onChange`), so the two never coexist, but
  // this keeps the ordering right the instant a mode is chosen afterwards —
  // which itself clears create mode (`onSelectCapability` in the parent).
  const createKindDef = isCreationKind(params.createTarget)
    ? CREATE_KINDS[params.createTarget]
    : null;
  const createToken: LeadToken[] =
    params.onCreateTargetChange && createKindDef
      ? [
          {
            key: `create:${createKindDef.kind}`,
            icon: PencilRuler,
            kind: "Create",
            prefix: "Create",
            label: (createKindDef.labelKey),
            onRemove: () => params.onCreateTargetChange?.(null),
          },
        ]
      : [];

  const trayCreate: TrayCreate | undefined = params.onCreateTargetChange
    ? {
        value: params.createTarget,
        onChange: (kind) => {
          params.onCreateTargetChange?.(kind);
          // Create mode only makes sense on the plain chat loop.
          if (kind) params.onSelectCapability("");
        },
      }
    : undefined;

  const leadTokens: LeadToken[] = [
    ...createToken,
    ...modeToken,
    ...(params.resourceSelection && params.onResourceSelectionChange ? [] : []),
  ];

  const answerMode: AnswerModeProps | undefined =
    params.onPersonaSelectionChange || params.onAnswerByChange
      ? {
          answerers: params.onAnswerByChange
            ? {
                value: params.answerBy,
                onChange: params.onAnswerByChange,
                partners: params.partners,
                agents: params.connectedAgents,
                loading: params.partnersLoading,
                error: params.partnerLoadError,
              }
            : undefined,
          // `/persona` opens this list; only when the parent can hear it close.
          open: params.onPersonaSelectorOpenChange
            ? Boolean(params.personaSelectorOpen)
            : undefined,
          onOpenChange: params.onPersonaSelectorOpenChange,
        }
      : undefined;

  // Working with partners: DeepTutor still answers, having asked them first.
  const partnerLinks: PartnerLinkProps | undefined =
    params.onSelectAgent || params.onSelectPartner || params.onSelectPartnerGroup
      ? {
          agents:
            params.onSelectAgent && params.connectedAgents.length
              ? {
                  options: params.connectedAgents,
                  selected: params.selectedAgent,
                  onSelect: params.onSelectAgent,
                  budget: params.subagentBudget,
                  onBudgetChange: params.onSubagentBudgetChange,
                }
              : undefined,
          partners: params.onSelectPartner
            ? {
                options: params.partners,
                selected: params.selectedPartner,
                onSelect: params.onSelectPartner,
                loading: params.partnersLoading,
                error: params.partnerLoadError,
              }
            : undefined,
          groups: params.onSelectPartnerGroup
            ? {
                options: params.partnerGroups,
                selected: params.selectedPartnerGroup,
                onSelect: params.onSelectPartnerGroup,
                loading: params.groupsLoading,
                error: params.groupLoadError,
              }
            : undefined,
        }
      : undefined;

  return {
    createKindDef,
    leadTokens,
    trayMode,
    trayCreate,
    answerMode,
    partnerLinks,
  };
}
