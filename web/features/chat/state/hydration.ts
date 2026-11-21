import type { LLMSelection } from "@/features/chat/model/protocol";
import type { SessionMessage } from "@/lib/session-api";
import { normalizeMarkdownForDisplay } from "@/lib/markdown-display";
import { normalizeMessageContent } from "@/lib/message-content";
import { hasOpenUILang } from "@/lib/openui/lang";
import { hasLegacyOgui } from "@/lib/openui/legacy-ogui";
import {
  dropUnvalidatedReasoningEffort,
  normalizeReasoningEffort,
} from "@/lib/reasoning-effort";
import {
  readLastKnownLLMOptions,
  sameLLMSelection,
  type LLMOption,
} from "@/lib/llm-options";
import {
  normalizeReadingMaterialId,
  normalizeReadingMaterialRevision,
} from "@/lib/reading-turn-state";
import { normalizeBookReferences } from "@/lib/book-references";
import { normalizeWorkspaceMode } from "@/lib/workspace-mode";
import { normalizeReadingReferences } from "@/lib/reading-references";
import type {
  MemoryReferencePayload,
  MessageAttachment,
  MessageItem,
  MessageRequestSnapshot,
  NotebookReferencePayload,
  QuestionNotebookReferencePayload,
  ReadingSelectionSnapshot,
} from "./types";

export function hydrateMessageAttachments(
  attachments: SessionMessage["attachments"],
): MessageAttachment[] {
  return Array.isArray(attachments)
    ? attachments.map((item) => ({
        type: item.type,
        filename: item.filename,
        base64: item.base64,
        url: item.url,
        mime_type: item.mime_type,
        id: item.id,
        extracted_text: item.extracted_text,
        generated: item.generated,
        size_bytes: item.size_bytes,
        origin: item.origin,
        workspace_id: item.workspace_id,
        workspace_item_id: item.workspace_item_id,
        relative_path: item.relative_path,
        sha256: item.sha256,
        title: item.title,
        caption: item.caption,
      }))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

export function asLLMSelection(value: unknown): LLMSelection | null {
  const record = asRecord(value);
  const profileId =
    typeof record?.profile_id === "string" ? record.profile_id.trim() : "";
  const modelId =
    typeof record?.model_id === "string" ? record.model_id.trim() : "";
  if (!profileId || !modelId) return null;
  const reasoningEffort = normalizeReasoningEffort(record?.reasoning_effort);
  return reasoningEffort
    ? { profile_id: profileId, model_id: modelId, reasoning_effort: reasoningEffort }
    : { profile_id: profileId, model_id: modelId };
}

export function sanitizeOutgoingLLMSelection(
  selection: LLMSelection | null,
  options: LLMOption[] = readLastKnownLLMOptions(),
): LLMSelection | null {
  if (!selection?.reasoning_effort) return selection;
  const option =
    options.find((candidate) => sameLLMSelection(candidate, selection)) ?? null;
  return dropUnvalidatedReasoningEffort(selection, option);
}

export function normalizeSelectedBranches(
  value: unknown,
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isInteger(n) && n > 0) result[k] = n;
  }
  return result;
}

function asMemoryReferences(value: unknown): MemoryReferencePayload {
  return asStringArray(value).filter(
    (item): item is "summary" | "profile" =>
      item === "summary" || item === "profile",
  );
}

function asNotebookReferences(value: unknown): NotebookReferencePayload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const ref = asRecord(item);
    const notebookId =
      typeof ref?.notebook_id === "string" ? ref.notebook_id : "";
    const recordIds = asStringArray(ref?.record_ids);
    return notebookId && recordIds.length
      ? [{ notebook_id: notebookId, record_ids: recordIds }]
      : [];
  });
}

function asQuestionReferences(
  value: unknown,
): QuestionNotebookReferencePayload {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "number" ? item : Number(item)))
        .filter((item) => Number.isInteger(item))
    : [];
}

function asReadingSelection(
  value: unknown,
): ReadingSelectionSnapshot | undefined {
  const record = asRecord(value);
  const quote = typeof record?.quote === "string" ? record.quote.trim() : "";
  if (!quote) return undefined;
  const locator = Number(record?.locator);
  return {
    quote,
    locator: Number.isSafeInteger(locator) && locator > 0 ? locator : 0,
  };
}

function hydrateRequestSnapshot(
  message: SessionMessage,
  content: string,
  attachments: MessageAttachment[],
): MessageRequestSnapshot | undefined {
  const metadata = asRecord(message.metadata);
  const stored = asRecord(
    metadata?.request_snapshot ?? metadata?.requestSnapshot,
  );
  if (!stored) return undefined;

  const snapshot: MessageRequestSnapshot = {
    content: typeof stored.content === "string" ? stored.content : content,
    capability:
      typeof stored.capability === "string"
        ? stored.capability
        : message.capability || "",
    workspaceMode: normalizeWorkspaceMode(
      stored.workspaceMode ?? stored.workspace_mode,
      stored.capability ?? message.capability,
    ),
    enabledTools: asStringArray(stored.enabledTools),
    knowledgeBases: asStringArray(stored.knowledgeBases),
    language: "en",
    ...(attachments.length ? { attachments } : {}),
  };

  const config = {
    ...(asRecord(stored.config) ?? {}),
    ...(typeof stored.consultPartnerId === "string"
      ? { consult_partner_id: stored.consultPartnerId }
      : {}),
    ...(typeof stored.partnerDiscussionGroupId === "string"
      ? { partner_discussion_group_id: stored.partnerDiscussionGroupId }
      : {}),
    ...(typeof stored.answerBy === "string" ? { answer_by: stored.answerBy } : {}),
  };
  const notebookReferences = asNotebookReferences(stored.notebookReferences);
  const historyReferences = asStringArray(stored.historyReferences);
  const questionNotebookReferences = asQuestionReferences(
    stored.questionNotebookReferences,
  );
  const persona =
    typeof stored.persona === "string" && stored.persona.length > 0
      ? stored.persona
      : "";
  const memoryReferences = asMemoryReferences(stored.memoryReferences);
  const bookReferences = normalizeBookReferences(stored.bookReferences);
  const readingReferences = normalizeReadingReferences(
    stored.readingReferences,
  );
  const llmSelection = asLLMSelection(stored.llmSelection);
  const masteryPathId =
    typeof (stored.masteryPathId ?? stored.mastery_path_id) === "string"
      ? String(stored.masteryPathId ?? stored.mastery_path_id).trim()
      : "";
  const readingMaterialId = normalizeReadingMaterialId(
    stored.readingMaterialId ?? stored.reading_material_id,
  );
  const readingMaterialRevision = normalizeReadingMaterialRevision(
    stored.readingMaterialRevision ?? stored.reading_material_revision,
  );
  const timedMediaId =
    typeof (stored.timedMediaId ?? stored.timed_media_id) === "string"
      ? String(stored.timedMediaId ?? stored.timed_media_id).trim()
      : "";
  const readingSelection = asReadingSelection(stored.readingSelection);

  if (config && Object.keys(config).length) snapshot.config = config;
  if (notebookReferences.length) {
    snapshot.notebookReferences = notebookReferences;
  }
  if (historyReferences.length) snapshot.historyReferences = historyReferences;
  if (questionNotebookReferences.length) {
    snapshot.questionNotebookReferences = questionNotebookReferences;
  }
  if (bookReferences.length) snapshot.bookReferences = bookReferences;
  if (readingReferences.length) {
    snapshot.readingReferences = readingReferences;
  }
  if (persona) snapshot.persona = persona;
  if (memoryReferences.length) snapshot.memoryReferences = memoryReferences;
  if (llmSelection) snapshot.llmSelection = llmSelection;
  if (masteryPathId) snapshot.masteryPathId = masteryPathId;
  const noteGeneration = asRecord(stored.noteGeneration ?? stored.note_generation);
  if (typeof noteGeneration?.block_id === "string" && noteGeneration.block_id) {
    snapshot.noteGeneration = {
      block_id: noteGeneration.block_id,
      kind: typeof noteGeneration.kind === "string" ? noteGeneration.kind : "",
    };
  }
  const masteryAnswer = asRecord(stored.masteryAnswer);
  if (
    typeof masteryAnswer?.question_id === "string" &&
    typeof masteryAnswer.text === "string"
  ) {
    snapshot.masteryAnswer = {
      question_id: masteryAnswer.question_id,
      text: masteryAnswer.text,
    };
  }
  const masterySkip = asRecord(stored.masterySkip);
  if (typeof masterySkip?.question_id === "string") {
    snapshot.masterySkip = { question_id: masterySkip.question_id };
  }
  if (readingMaterialId) {
    snapshot.readingMaterialId = readingMaterialId;
    if (readingMaterialRevision) {
      snapshot.readingMaterialRevision = readingMaterialRevision;
    }
  }
  if (timedMediaId) snapshot.timedMediaId = timedMediaId;
  if (readingSelection) snapshot.readingSelection = readingSelection;
  if (stored.capabilityOnce === true) snapshot.capabilityOnce = true;
  return snapshot;
}

export function hydrateSessionMessages(
  messages: SessionMessage[],
): MessageItem[] {
  return messages
    .filter((message) => message.role !== "system")
    .filter(
      (message) =>
        normalizeMessageContent(message.content as unknown).trim() !== "" ||
        (message.attachments?.length ?? 0) > 0 ||
        (Array.isArray(message.events) && message.events.length > 0),
    )
    .map((message) => {
      const raw = normalizeMessageContent(message.content as unknown);
      const attachments = hydrateMessageAttachments(message.attachments);
      const requestSnapshot = hydrateRequestSnapshot(
        message,
        raw,
        attachments,
      );
      return {
        id: message.id,
        role: message.role,
        content:
          message.role === "assistant" &&
          !hasOpenUILang(raw) &&
          !hasLegacyOgui(raw)
            ? normalizeMarkdownForDisplay(raw)
            : raw,
        capability: message.capability || "",
        events: Array.isArray(message.events) ? message.events : [],
        attachments,
        trace: message.trace,
        parentMessageId:
          message.parent_message_id === undefined
            ? null
            : message.parent_message_id,
        ...(requestSnapshot ? { requestSnapshot } : {}),
        ...(typeof message.metadata?.client_submission_id === "string"
          ? { failedSubmissionId: message.metadata.client_submission_id }
          : {}),
        ...(message.role === "user" && message.metadata?.orphaned_failed_turn
          ? { orphanedFailedTurn: message.metadata.orphaned_failed_turn }
          : {}),
      };
    });
}
