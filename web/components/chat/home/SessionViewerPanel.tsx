"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import dynamic from "@/shared/router/dynamic";
import ViewerLauncher, {
  type LauncherClosedTab,
  type LauncherThread,
} from "@/components/chat/home/ViewerLauncher";
import ConsultationTabBody from "@/components/chat/home/ConsultationTabBody";
import QuizFollowupTabBody from "@/components/quiz/QuizFollowupTabBody";
import {
  type QuizFollowupTabContext,
  useOptionalQuizFollowupController,
} from "@/context/QuizFollowupContext";
import type { GeogebraTabPayload } from "@/context/GeogebraTabContext";
import type { MessageAttachment } from "@/features/chat/ChatStateAdapter";
import type { StreamEvent } from "@/features/chat/model/protocol";
import { usePartnerGroups } from "@/hooks/usePartnerGroups";
import { usePartnerRoster } from "@/hooks/usePartnerRoster";
import { normalizeSelectedText } from "@/lib/selection-text";
import { listSessionThreads, type SessionSummary } from "@/lib/session-api";
import { subscribeSessionChanges } from "@/lib/session-events";
import { isPlaceholderSessionTitle } from "@/lib/session-title";
import { SHORTCUTS } from "@/lib/shortcuts";
import {
  DITO,
  responderFromPreferences,
  sameResponder,
  sideChatKey,
  type SideChatResponder,
} from "@/lib/side-chat";
import { browserStorage } from "@/shared/storage";

import {
  NO_AGENTS,
  RECENTLY_CLOSED_LIMIT,
  RESPONDER_ICONS,
  STASHED_CONVERSATIONS,
  VIEWER_WIDTH_DEFAULT,
  VIEWER_WIDTH_KEY,
  VIEWER_WIDTH_VAR,
  type PersistedSideChatTab,
  type PersistedViewerTabs,
  type SessionViewerPanelHandle,
  type SessionViewerPanelProps,
  type SideChatOpenOptions,
  type StashedTabs,
  type ViewerTab,
} from "./viewer/types";
import {
  attachmentToPreviewSource,
  clampViewerWidth,
  fileTabIdFor,
  geogebraTabIdFor,
  hostnameFor,
  markdownNoteTabId,
  newTabId,
  parsePersistedViewerTabs,
  quizFollowupTabIdFor,
  readStoredViewerWidth,
  sideChatTabIdFor,
  subagentTabIdFor,
  tabIcon,
  viewerTabsStorageKey,
  webTabIdFor,
} from "./viewer/helpers";
import { ViewerTabBar } from "./viewer/ViewerTabBar";
import {
  ActivityHome,
  FileTabActions,
  FileTabBody,
  GeogebraTabBody,
  WebTabBody,
} from "./viewer/ViewerTabBodies";

export type {
  SessionViewerPanelHandle,
  SideChatOpenOptions,
  ViewerConversation,
  SessionViewerPanelProps,
} from "./viewer/types";

const ChatMarkdownNoteTabBody = dynamic(
  () => import("@/components/chat/home/ChatMarkdownNoteTab"),
  { ssr: false },
);

function SessionViewerPanelInner(
  {
    open,
    sessionId,
    sessionKey,
    reboundFromKey = null,
    conversation = null,
    workspaceId = null,
    threads: providedThreads,
    onClose,
    onAutoOpen,
    activity,
    configSection,
    taskDraftIds,
    onTaskDraftChange,
    resourceCatalog,
    agents = NO_AGENTS,
  }: SessionViewerPanelProps,
  ref: React.Ref<SessionViewerPanelHandle>,
) {
  
  const followups = useOptionalQuizFollowupController();
  const [tabs, setTabs] = useState<ViewerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [closedTabs, setClosedTabs] = useState<ViewerTab[]>([]);
  const [hydratedTabsKey, setHydratedTabsKey] = useState<string | null>(null);

  const widthRef = useRef(VIEWER_WIDTH_DEFAULT);
  useEffect(() => {
    widthRef.current = readStoredViewerWidth();
    document.documentElement.style.setProperty(
      VIEWER_WIDTH_VAR,
      `${widthRef.current}px`,
    );
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    document.documentElement.dataset.viewerResizing = "true";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const inset =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--viewer-inset",
        ),
      ) || 0;
    let rafId = 0;
    let pendingX = e.clientX;
    const apply = () => {
      rafId = 0;
      const w = clampViewerWidth(window.innerWidth - inset - pendingX);
      widthRef.current = w;
      document.documentElement.style.setProperty(VIEWER_WIDTH_VAR, `${w}px`);
    };
    const onMove = (ev: PointerEvent) => {
      pendingX = ev.clientX;
      if (!rafId) rafId = requestAnimationFrame(apply);
    };
    const onUp = () => {
      if (rafId) cancelAnimationFrame(rafId);
      delete document.documentElement.dataset.viewerResizing;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      browserStorage.writeRaw(
        "local",
        VIEWER_WIDTH_KEY,
        String(widthRef.current),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const tabsKey = sessionKey ?? sessionId ?? "draft";
  const [stash, setStash] = useState<ReadonlyMap<string, StashedTabs>>(
    () => new Map(),
  );
  const [trackedKey, setTrackedKey] = useState(tabsKey);
  if (trackedKey !== tabsKey) {
    setTrackedKey(tabsKey);
    if (reboundFromKey !== trackedKey) {
      const restored = stash.get(tabsKey);
      const next = new Map(stash);
      next.delete(trackedKey);
      next.delete(tabsKey);
      next.set(trackedKey, { tabs, activeTabId, closedTabs });
      for (const key of next.keys()) {
        if (next.size <= STASHED_CONVERSATIONS) break;
        next.delete(key);
      }
      setStash(next);
      setTabs(restored?.tabs ?? []);
      setActiveTabId(restored?.activeTabId ?? null);
      setClosedTabs(restored?.closedTabs ?? []);
    }
  }

  useEffect(() => {
    if (hydratedTabsKey === tabsKey) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHydratedTabsKey(tabsKey);
    if (tabs.length > 0 || activeTabId !== null) return;
    const raw = browserStorage.readRaw("local", viewerTabsStorageKey(tabsKey));
    if (!raw) return;
    const restored = parsePersistedViewerTabs(raw, sessionId ?? null);
    if (!restored) return;
    setTabs(restored.tabs);
    setActiveTabId(restored.activeTabId);
  }, [activeTabId, hydratedTabsKey, sessionId, tabs.length, tabsKey]);

  useEffect(() => {
    if (reboundFromKey && reboundFromKey !== tabsKey) {
      browserStorage.removeRaw("local", viewerTabsStorageKey(reboundFromKey));
    }
  }, [reboundFromKey, tabsKey]);

  const openFileTab = useCallback(
    (a: MessageAttachment) => {
      setTabs((prev) => {
        const id = fileTabIdFor(a, prev.length);
        if (prev.some((tab) => tab.id === id)) {
          setActiveTabId(id);
          return prev;
        }
        const next: ViewerTab = {
          kind: "file",
          id,
          label: a.filename || "Attachment",
          source: attachmentToPreviewSource(a),
        };
        setActiveTabId(id);
        return [...prev, next];
      });
      onAutoOpen();
    },
    [onAutoOpen],
  );

  const openWebTab = useCallback(
    (url: string) => {
      setTabs((prev) => {
        const id = webTabIdFor(url);
        if (prev.some((tab) => tab.id === id)) {
          setActiveTabId(id);
          return prev;
        }
        const next: ViewerTab = {
          kind: "web",
          id,
          label: hostnameFor(url),
          url,
        };
        setActiveTabId(id);
        return [...prev, next];
      });
      onAutoOpen();
    },
    [onAutoOpen],
  );

  const openNewTab = useCallback(() => {
    setTabs((prev) =>
      prev.some((tab) => tab.id === newTabId)
        ? prev
        : [...prev, { kind: "new", id: newTabId, label: "New tab" }],
    );
    setActiveTabId(newTabId);
  }, []);

  const openFromNewTab = useCallback((openTarget: () => void) => {
    setTabs((prev) => prev.filter((tab) => tab.id !== newTabId));
    openTarget();
  }, []);

  const openMarkdownNoteTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === markdownNoteTabId)) {
        setActiveTabId(markdownNoteTabId);
        return prev;
      }
      const next: ViewerTab = {
        kind: "markdown-note",
        id: markdownNoteTabId,
        label: "Note",
      };
      setActiveTabId(markdownNoteTabId);
      return [...prev, next];
    });
    onAutoOpen();
  }, [onAutoOpen]);

  const openQuizFollowupTab = useCallback(
    (context: QuizFollowupTabContext) => {
      setTabs((prev) => {
        const id = quizFollowupTabIdFor(context.questionKey);
        const existingIdx = prev.findIndex((tab) => tab.id === id);
        const tab: ViewerTab = {
          kind: "quiz-followup",
          id,
          label: context.tabLabel,
          context,
        };
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = tab;
          setActiveTabId(id);
          return next;
        }
        setActiveTabId(id);
        return [...prev, tab];
      });
      onAutoOpen();
    },
    [onAutoOpen],
  );

  const { partners } = usePartnerRoster(open);
  const { groups } = usePartnerGroups(open);
  const named = useCallback(
    (responder: SideChatResponder): SideChatResponder => {
      if (responder.kind === "partner") {
        const partner = partners.find((p) => p.partner_id === responder.id);
        return partner ? { ...responder, name: partner.name } : responder;
      }
      if (responder.kind === "partner_group") {
        const group = groups.find((g) => g.group_id === responder.id);
        return group ? { ...responder, name: group.name } : responder;
      }
      return responder;
    },
    [groups, partners],
  );
  const responderLabel = useCallback(
    (responder: SideChatResponder) =>
      responder.kind === "dito" ? "Dito" : responder.name,
    [],
  );

  const putSideChatTab = useCallback(
    (
      questionKey: string,
      responder: SideChatResponder,
      language: string,
      followupSessionId: string | null = null,
      seedQuote?: { id: number; text: string },
      sourceMessageId: number | string | null = null,
    ) => {
      const id = sideChatTabIdFor(questionKey);
      const label = responderLabel(responder);
      const context: QuizFollowupTabContext = {
        questionKey,
        question: {
          question_id: questionKey,
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
        followupSessionId,
        language,
        tabLabel: label,
        sideChat: {
          parentSessionId: sessionId ?? null,
          leafMessageId: conversation?.leafMessageId ?? null,
          sourceMessageId,
          parentTitle: conversation?.title,
          responder,
        },
        ...(seedQuote ? { seedQuote } : {}),
      };
      setTabs((prev) => {
        const tab: ViewerTab = { kind: "side-chat", id, label, context };
        const existingIdx = prev.findIndex(
          (openTab) =>
            openTab.id === id ||
            (followupSessionId !== null &&
              openTab.kind === "side-chat" &&
              openTab.context.followupSessionId === followupSessionId),
        );
        if (existingIdx < 0) return [...prev, tab];
        const next = [...prev];
        next[existingIdx] = tab;
        return next;
      });
      setActiveTabId(id);
      onAutoOpen();
    },
    [conversation, onAutoOpen, responderLabel, sessionId],
  );

  const seedCounter = useRef(0);
  const openSideChatTab = useCallback(
    ({ responder = DITO, quote, sourceMessageId }: SideChatOpenOptions = {}) => {
      const text = quote ? normalizeSelectedText(quote) : "";
      const seedQuote = text ? { id: ++seedCounter.current, text } : undefined;
      const sideChats = tabs.filter(
        (tab): tab is Extract<ViewerTab, { kind: "side-chat" }> =>
          tab.kind === "side-chat" &&
          Boolean(tab.context.sideChat) &&
          sameResponder(tab.context.sideChat!.responder, responder),
      );
      const target = text
        ? (sideChats.find((tab) => tab.id === activeTabId) ?? sideChats.at(-1))
        : sideChats.find(
            (tab) =>
              !tab.context.followupSessionId &&
              (followups?.getThread(tab.context.questionKey).messages.length ?? 0) ===
                0,
          );
      if (target) {
        const existingSource = target.context.sideChat?.sourceMessageId ?? null;
        const nextSource = seedQuote
          ? (sourceMessageId ?? null)
          : sourceMessageId === undefined
            ? existingSource
            : sourceMessageId;
        if (seedQuote || nextSource !== existingSource) {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === target.id && tab.kind === "side-chat"
                ? {
                    ...tab,
                    context: {
                      ...tab.context,
                      ...(seedQuote ? { seedQuote } : {}),
                      sideChat: tab.context.sideChat
                        ? { ...tab.context.sideChat, sourceMessageId: nextSource }
                        : tab.context.sideChat,
                    },
                  }
                : tab,
            ),
          );
        }
        setActiveTabId(target.id);
        onAutoOpen();
        return;
      }
      putSideChatTab(
        sideChatKey(sessionId ?? null),
        responder,
        conversation?.language ?? "en",
        null,
        seedQuote,
        sourceMessageId ?? null,
      );
    },
    [
      activeTabId,
      conversation,
      followups,
      onAutoOpen,
      putSideChatTab,
      sessionId,
      tabs,
    ],
  );

  const setSideChatResponder = useCallback(
    (tabId: string, responder: SideChatResponder) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && tab.kind === "side-chat" && tab.context.sideChat
            ? {
                ...tab,
                label: responderLabel(responder),
                context: {
                  ...tab.context,
                  tabLabel: responderLabel(responder),
                  sideChat: { ...tab.context.sideChat, responder },
                },
              }
            : tab,
        ),
      );
    },
    [responderLabel],
  );

  const openSideChatThread = useCallback(
    (thread: SessionSummary) => {
      if (!sessionId) return;
      const prefs = thread.preferences ?? {};
      const live = followups
        ? Object.entries(followups.getAllThreads()).find(
            ([, state]) => state.sessionId === thread.session_id,
          )?.[0]
        : undefined;
      putSideChatTab(
        live ?? `thread:${thread.session_id}`,
        named(responderFromPreferences(prefs)),
        conversation?.language ?? prefs.language ?? "en",
        thread.session_id,
        undefined,
        prefs.tutor_source_message_id || null,
      );
    },
    [conversation, followups, named, putSideChatTab, sessionId],
  );

  const openGeogebraBoard = useCallback(() => {
    const id = geogebraTabIdFor(`board-${Date.now().toString(36)}`);
    setTabs((prev) => [
      ...prev,
      {
        kind: "geogebra",
        id,
        label: "GeoGebra board",
        script: "",
        editable: true,
      },
    ]);
    setActiveTabId(id);
    onAutoOpen();
  }, [onAutoOpen]);

  const openGeogebraTab = useCallback(
    (payload: GeogebraTabPayload) => {
      setTabs((prev) => {
        const id = geogebraTabIdFor(payload.id);
        const existingIdx = prev.findIndex((tab) => tab.id === id);
        const tab: ViewerTab = {
          kind: "geogebra",
          id,
          label: payload.title || "GeoGebra",
          script: payload.script,
        };
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = tab;
          setActiveTabId(id);
          return next;
        }
        setActiveTabId(id);
        return [...prev, tab];
      });
      onAutoOpen();
    },
    [onAutoOpen],
  );

  const subagentSeenRef = useRef<Set<string>>(new Set());
  const openSubagentTab = useCallback(
    (callId: string, label: string, events: StreamEvent[], focus = false) => {
      const id = subagentTabIdFor(callId);
      const isNew = !subagentSeenRef.current.has(callId);
      subagentSeenRef.current.add(callId);
      setTabs((prev) => {
        const existingIdx = prev.findIndex((tab) => tab.id === id);
        const tab: ViewerTab = { kind: "subagent", id, label, callId, events };
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = tab;
          return next;
        }
        return [...prev, tab];
      });
      if (isNew || focus) {
        setActiveTabId(id);
        onAutoOpen();
      }
    },
    [onAutoOpen],
  );

  const focusActivityHome = useCallback(() => {
    setActiveTabId(null);
    onAutoOpen();
  }, [onAutoOpen]);

  const closeTab = useCallback(
    (id: string, options?: { remember?: boolean }) => {
      setTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.id === id);
        if (idx === -1) return prev;
        const closed = prev[idx];
        if (closed.kind !== "new" && options?.remember !== false) {
          setClosedTabs((recent) =>
            [closed, ...recent.filter((tab) => tab.id !== id)].slice(
              0,
              RECENTLY_CLOSED_LIMIT,
            ),
          );
        }
        const next = prev.filter((tab) => tab.id !== id);
        if (activeTabId === id) {
          setActiveTabId(
            next.length === 0
              ? null
              : (next[Math.max(0, idx - 1)] ?? next[0]).id,
          );
        }
        return next;
      });
    },
    [activeTabId],
  );

  const bindSideChatThread = useCallback(
    (tabId: string, threadSessionId: string) => {
      setTabs((prev) => {
        let changed = false;
        const next = prev.map((tab) => {
          if (
            tab.id !== tabId ||
            tab.kind !== "side-chat" ||
            tab.context.followupSessionId
          ) {
            return tab;
          }
          changed = true;
          return {
            ...tab,
            context: { ...tab.context, followupSessionId: threadSessionId },
          };
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  const closeSideChatThread = useCallback(
    (threadSessionId: string) => {
      setClosedTabs((recent) =>
        recent.filter(
          (tab) =>
            !(
              tab.kind === "side-chat" &&
              tab.context.followupSessionId === threadSessionId
            ),
        ),
      );
      const tab = tabs.find(
        (openTab) =>
          openTab.kind === "side-chat" &&
          openTab.context.followupSessionId === threadSessionId,
      );
      if (tab) closeTab(tab.id, { remember: false });
    },
    [closeTab, tabs],
  );

  const clearSideChatSource = useCallback(
    (threadSessionId: string, sourceMessageId: number | string | null) => {
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.kind !== "side-chat" || !tab.context.sideChat) return tab;
          const liveSessionId =
            followups?.getThread(tab.context.questionKey).sessionId ?? null;
          if (
            tab.context.followupSessionId !== threadSessionId &&
            liveSessionId !== threadSessionId
          ) {
            return tab;
          }
          const side = tab.context.sideChat;
          if (String(side.sourceMessageId ?? "") !== String(sourceMessageId ?? "")) {
            return tab;
          }
          return {
            ...tab,
            context: {
              ...tab.context,
              sideChat: { ...side, sourceMessageId: null },
            },
          };
        }),
      );
    },
    [followups],
  );

  useImperativeHandle(
    ref,
    () => ({
      openFileTab,
      openWebTab,
      openMarkdownNoteTab,
      openQuizFollowupTab,
      openSideChatTab,
      openSideChatThread,
      closeSideChatThread,
      clearSideChatSource,
      openGeogebraTab,
      openSubagentTab,
      focusActivityHome,
    }),
    [
      openFileTab,
      openWebTab,
      openMarkdownNoteTab,
      openQuizFollowupTab,
      openSideChatTab,
      openSideChatThread,
      closeSideChatThread,
      clearSideChatSource,
      openGeogebraTab,
      openSubagentTab,
      focusActivityHome,
    ],
  );

  const reopenClosedTab = useCallback(
    (id: string) => {
      const closed = closedTabs.find((tab) => tab.id === id);
      if (!closed) return;
      setClosedTabs((recent) => recent.filter((tab) => tab.id !== id));
      setTabs((prev) =>
        prev.some((tab) => tab.id === id)
          ? prev.filter((tab) => tab.id !== newTabId)
          : [...prev.filter((tab) => tab.id !== newTabId), closed],
      );
      setActiveTabId(id);
    },
    [closedTabs],
  );

  const launcherOpen =
    tabs.some((tab) => tab.id === newTabId) && activeTabId === newTabId;
  const [launcherThreadRows, setLauncherThreadRows] = useState<{
    sessionId: string;
    rows: SessionSummary[];
  }>({
    sessionId: "",
    rows: [],
  });
  const [threadsRevision, setThreadsRevision] = useState(0);
  useEffect(
    () => subscribeSessionChanges(() => setThreadsRevision((n) => n + 1)),
    [],
  );

  useEffect(() => {
    if (hydratedTabsKey !== tabsKey) return;
    const persistable: PersistedSideChatTab[] = [];
    for (const tab of tabs) {
      if (tab.kind !== "side-chat" || !tab.context.sideChat) continue;
      const followupSessionId =
        tab.context.followupSessionId ||
        followups?.getThread(tab.context.questionKey).sessionId ||
        null;
      if (!followupSessionId) continue;
      persistable.push({
        id: tab.id,
        label: tab.label,
        questionKey: tab.context.questionKey,
        followupSessionId,
        language: tab.context.language,
        sideChat: {
          parentSessionId: tab.context.sideChat.parentSessionId,
          leafMessageId: tab.context.sideChat.leafMessageId,
          sourceMessageId: tab.context.sideChat.sourceMessageId ?? null,
          parentTitle: tab.context.sideChat.parentTitle,
          responder: tab.context.sideChat.responder,
        },
      });
    }
    const key = viewerTabsStorageKey(tabsKey);
    if (persistable.length === 0) {
      browserStorage.removeRaw("local", key);
      return;
    }
    const payload: PersistedViewerTabs = {
      version: 1,
      tabs: persistable,
      activeTabId: persistable.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : null,
    };
    browserStorage.writeRaw("local", key, JSON.stringify(payload));
  }, [
    activeTabId,
    followups,
    hydratedTabsKey,
    tabs,
    tabsKey,
    threadsRevision,
  ]);

  useEffect(() => {
    if (providedThreads !== undefined || !launcherOpen || !sessionId) return;
    const controller = new AbortController();
    listSessionThreads(sessionId, workspaceId ?? undefined, controller.signal)
      .then((rows) => setLauncherThreadRows({ sessionId, rows }))
      .catch(() => {});
    return () => controller.abort();
  }, [launcherOpen, providedThreads, sessionId, threadsRevision, workspaceId]);

  const openThreadSessionIds = new Set(
    tabs.flatMap((tab) =>
      tab.kind === "side-chat"
        ? [
            followups?.getThread(tab.context.questionKey).sessionId ??
              tab.context.followupSessionId,
          ].filter((value): value is string => Boolean(value))
        : [],
    ),
  );
  const threadRows =
    providedThreads ??
    (launcherThreadRows.sessionId === sessionId ? launcherThreadRows.rows : []);
  const launcherThreads: LauncherThread[] = threadRows
    .filter((row) => !openThreadSessionIds.has(row.session_id))
    .slice(0, 6)
    .map((row) => {
      const responder = named(responderFromPreferences(row.preferences));
      return {
        id: row.session_id,
        title: isPlaceholderSessionTitle(row.title) ? "Side chat" : row.title,
        detail: `With ${responderLabel(responder)}`,
        icon: RESPONDER_ICONS[responder.kind],
        updatedAt: row.updated_at,
      };
    });
  const threadIds = new Set(threadRows.map((row) => row.session_id));
  const launcherClosedTabs: LauncherClosedTab[] = closedTabs
    .filter((tab) => !tabs.some((openTab) => openTab.id === tab.id))
    .filter(
      (tab) =>
        tab.kind !== "side-chat" ||
        !threadIds.has(
          followups?.getThread(tab.context.questionKey).sessionId ??
            tab.context.followupSessionId ??
            "",
        ),
    )
    .map((tab) => ({ id: tab.id, label: tab.label, icon: tabIcon(tab) }));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const visible = open && entered;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const openLocalFile = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      openFileTab({
        type: file.type.startsWith("image/") ? "image" : "file",
        filename: file.name,
        mime_type: file.type,
        url,
      });
    },
    [openFileTab],
  );

  return (
    <div
      role="dialog"
      aria-hidden={!visible}
      data-open={visible ? "true" : "false"}
      className="dt-viewer-panel fixed right-0 top-0 z-[30] flex h-dvh flex-col bg-[var(--card)] max-md:!w-full md:max-w-[92vw]"
      style={{
        width: `var(${VIEWER_WIDTH_VAR}, ${VIEWER_WIDTH_DEFAULT}px)`,
        willChange: "transform",
      }}
    >
      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={"Resize viewer"}
        className="group/resize absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize max-md:hidden"
      >
        <span className="absolute left-[3px] top-1/2 h-10 w-[3px] -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover/resize:bg-[color-mix(in_srgb,var(--muted-foreground)_35%,transparent)]" />
      </div>
      <ViewerTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        homeActive={activeTab === null}
        onSelectHome={() => setActiveTabId(null)}
        onSelect={setActiveTabId}
        onCloseTab={closeTab}
        onNewTab={openNewTab}
        onClosePanel={onClose}
        agents={agents}
        actions={
          activeTab?.kind === "file" ? (
            <FileTabActions source={activeTab.source} />
          ) : null
        }
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--card)]">
        {activeTab?.kind === "file" ? (
          <FileTabBody source={activeTab.source} />
        ) : activeTab?.kind === "web" ? (
          <WebTabBody key={activeTab.url} url={activeTab.url} />
        ) : activeTab?.kind === "markdown-note" ? (
          <ChatMarkdownNoteTabBody
            key={`${activeTab.id}:${sessionId ?? "pending"}`}
            sessionId={sessionId}
          />
        ) : activeTab?.kind === "quiz-followup" ? (
          <QuizFollowupTabBody
            key={activeTab.context.questionKey}
            context={activeTab.context}
            resourceCatalog={resourceCatalog}
          />
        ) : activeTab?.kind === "side-chat" ? (
          <QuizFollowupTabBody
            key={activeTab.context.questionKey}
            context={activeTab.context}
            resourceCatalog={resourceCatalog}
            agents={agents}
            onResponderChange={(responder) =>
              setSideChatResponder(activeTab.id, responder)
            }
            onThreadSessionBound={(threadSessionId) =>
              bindSideChatThread(activeTab.id, threadSessionId)
            }
          />
        ) : activeTab?.kind === "geogebra" ? (
          <GeogebraTabBody
            key={activeTab.id}
            script={activeTab.script}
            editable={activeTab.editable}
          />
        ) : activeTab?.kind === "new" ? (
          <ViewerLauncher
            onOpenUrl={(url) => openFromNewTab(() => openWebTab(url))}
            onOpenLocalFile={(file) => openFromNewTab(() => openLocalFile(file))}
            onOpenMarkdownNote={() => openFromNewTab(openMarkdownNoteTab)}
            onOpenGeogebraBoard={() => openFromNewTab(openGeogebraBoard)}
            onOpenSideChat={(responder) =>
              openFromNewTab(() => openSideChatTab({ responder }))
            }
            sideChatAboutConversation={Boolean(sessionId && conversation)}
            sideChatAgents={agents}
            sideChatShortcut={SHORTCUTS.sideChat}
            threads={launcherThreads}
            onOpenThread={(id) => {
              const row = threadRows.find((thread) => thread.session_id === id);
              if (row) openFromNewTab(() => openSideChatThread(row));
            }}
            closedTabs={launcherClosedTabs}
            onReopenTab={reopenClosedTab}
          />
        ) : activeTab?.kind === "subagent" ? (
          <ConsultationTabBody
            key={activeTab.id}
            tabEvents={activeTab.events}
            sessionId={sessionId}
          />
        ) : (
          <ActivityHome
            sessionId={sessionId}
            taskDraftIds={taskDraftIds}
            onTaskDraftChange={onTaskDraftChange}
            activity={activity}
            open={visible}
            configSection={configSection}
            onOpenAttachment={openFileTab}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

const ScopedViewerPanel = forwardRef(SessionViewerPanelInner);
const SessionViewerPanel = memo(
  forwardRef<SessionViewerPanelHandle, SessionViewerPanelProps>(
    function SessionViewerPanel(props, ref) {
      return (
        <ScopedViewerPanel
          key="single-user"
          ref={ref}
          {...props}
        />
      );
    },
  ),
);
export default SessionViewerPanel;
