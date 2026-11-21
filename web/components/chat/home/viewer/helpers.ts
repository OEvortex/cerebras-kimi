import {
  Bot,
  Compass,
  Globe,
  MessageSquarePlus,
  NotebookPen,
  Paperclip,
  Plus,
  type LucideIcon,
} from "lucide-react";
import type { FilePreviewSource } from "@/components/chat/preview/previewerFor";
import type { MessageAttachment } from "@/features/chat/ChatStateAdapter";
import { browserStorage } from "@/shared/storage";
import {
  RESPONDER_ICONS,
  VIEWER_TABS_STORAGE_PREFIX,
  VIEWER_WIDTH_DEFAULT,
  VIEWER_WIDTH_KEY,
  VIEWER_WIDTH_MAX,
  VIEWER_WIDTH_MIN,
  type PersistedSideChatTab,
  type PersistedViewerTabs,
  type ViewerTab,
} from "./types";

export function clampViewerWidth(px: number): number {
  const ceiling =
    typeof window !== "undefined"
      ? Math.max(
          VIEWER_WIDTH_MIN,
          Math.min(VIEWER_WIDTH_MAX, window.innerWidth * 0.7),
        )
      : VIEWER_WIDTH_MAX;
  return Math.round(Math.max(VIEWER_WIDTH_MIN, Math.min(px, ceiling)));
}

export function readStoredViewerWidth(): number {
  if (typeof window === "undefined") return VIEWER_WIDTH_DEFAULT;
  const raw = browserStorage.readRaw("local", VIEWER_WIDTH_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed)
    ? clampViewerWidth(parsed)
    : VIEWER_WIDTH_DEFAULT;
}

export function fileTabIdFor(a: MessageAttachment, fallback: number): string {
  return `file:${a.id ?? a.filename ?? `idx-${fallback}`}`;
}

export function webTabIdFor(url: string): string {
  return `web:${url}`;
}

export const markdownNoteTabId = "markdown-note";
export const newTabId = "new-tab";

export function quizFollowupTabIdFor(questionKey: string): string {
  return `quiz-followup:${questionKey}`;
}

export function sideChatTabIdFor(questionKey: string): string {
  return `side-chat:${questionKey}`;
}

export function geogebraTabIdFor(payloadId: string): string {
  return `geogebra:${payloadId}`;
}

export function subagentTabIdFor(callId: string): string {
  return `subagent:${callId}`;
}

export function viewerTabsStorageKey(tabsKey: string): string {
  return `${VIEWER_TABS_STORAGE_PREFIX}single-user:${encodeURIComponent(tabsKey)}`;
}

function sideChatTabFromPersisted(tab: PersistedSideChatTab): ViewerTab {
  return {
    kind: "side-chat",
    id: tab.id,
    label: tab.label,
    context: {
      questionKey: tab.questionKey,
      question: {
        question_id: tab.questionKey,
        question: "",
        question_type: "concept",
        correct_answer: "",
        explanation: "",
      },
      userAnswer: "",
      isCorrect: null,
      answerImages: [],
      aiJudgment: "",
      parentQuizSessionId: null,
      notebookEntryId: null,
      followupSessionId: tab.followupSessionId,
      language: tab.language,
      tabLabel: tab.label,
      sideChat: tab.sideChat,
    },
  };
}

export function parsePersistedViewerTabs(
  raw: string,
  parentSessionId: string | null,
): { tabs: ViewerTab[]; activeTabId: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<PersistedViewerTabs>;
  if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) return null;

  const seen = new Set<string>();
  const tabs: ViewerTab[] = [];
  for (const item of parsed.tabs.slice(0, 24)) {
    if (!item || typeof item !== "object") continue;
    const tab = item as Partial<PersistedSideChatTab>;
    const side = tab.sideChat;
    if (
      typeof tab.id !== "string" ||
      !tab.id ||
      (typeof tab.followupSessionId === "string" && !tab.followupSessionId) ||
      (typeof tab.label === "string" && tab.label.length > 300) ||
      typeof tab.label !== "string" ||
      typeof tab.questionKey !== "string" ||
      typeof tab.followupSessionId !== "string" ||
      typeof tab.language !== "string" ||
      !side ||
      typeof side !== "object" ||
      seen.has(tab.followupSessionId)
    ) {
      continue;
    }
    if ((side.parentSessionId ?? null) !== (parentSessionId ?? null)) continue;
    if (
      side.leafMessageId != null &&
      (!Number.isSafeInteger(side.leafMessageId) || side.leafMessageId < 0)
    ) {
      continue;
    }
    if (side.parentTitle != null && typeof side.parentTitle !== "string") {
      continue;
    }
    const responder = side.responder;
    if (
      !responder ||
      typeof responder !== "object" ||
      !["dito", "partner", "partner_group", "subagent"].includes(responder.kind)
    ) {
      continue;
    }
    if (
      responder.kind !== "dito" &&
      (typeof responder.id !== "string" ||
        !responder.id ||
        typeof responder.name !== "string")
    ) {
      continue;
    }
    seen.add(tab.followupSessionId);
    tabs.push(sideChatTabFromPersisted(tab as PersistedSideChatTab));
  }
  if (tabs.length === 0) return null;
  return {
    tabs,
    activeTabId:
      typeof parsed.activeTabId === "string" &&
      tabs.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : null,
  };
}

export function tabIcon(tab: ViewerTab): LucideIcon {
  switch (tab.kind) {
    case "web":
      return Globe;
    case "markdown-note":
      return NotebookPen;
    case "side-chat":
      return RESPONDER_ICONS[tab.context.sideChat?.responder.kind ?? "dito"];
    case "quiz-followup":
      return MessageSquarePlus;
    case "geogebra":
      return Compass;
    case "subagent":
      return Bot;
    case "new":
      return Plus;
    default:
      return Paperclip;
  }
}

export function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 32);
  }
}

export function attachmentToPreviewSource(
  a: MessageAttachment,
): FilePreviewSource {
  return {
    filename: a.filename || "",
    mimeType: a.mime_type,
    type: a.type,
    url: a.url,
    base64: a.base64,
    extractedText: a.extracted_text,
    id: a.id,
  };
}
