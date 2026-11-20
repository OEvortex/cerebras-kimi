/**
 * The /space hub's sections: what each resource is called, where it lives,
 * its icon and live count. Shared by the hub, the sidebar shelf, the ⌘K
 * palette and the page bar, so it carries no component code.
 */
import {
  BookOpen,
  Bookmark,
  Bot,
  Brain,
  ClipboardList,
  Ear,
  History,
  NotebookPen,
  Plug,
  Terminal,
  UserRound,
  Wand2,
  type LucideIcon,
} from "lucide-react";

import { getCliApps } from "@/lib/cli-apps-api";
import { listSessions } from "@/lib/session-api";
import { listNotebooks, listNotebookEntries } from "@/lib/notebook-api";
import { listKnowledgeBases } from "@/features/knowledge/api/catalog";
import { listSubagentConnections } from "@/lib/subagents-api";

export type Lang = { zh: string; en: string };

export type DashKey =
  | "agents"
  | "knowledge"
  | "memory"
  | "chat_history"
  | "notebooks"
  | "journal"
  | "question_bank"
  | "cli_apps"
  | "whisper";

export interface DashboardItem {
  key: DashKey;
  href: string;
  icon: LucideIcon;
  title: Lang;
  blurb: Lang;
  /**
   * Unit shown after the live count, e.g. "168 conversations". Omitted
   * together with ``load`` for a tile that has nothing to count.
   */
  unit?: Lang;
  /** Icon-tile accent — full class strings so Tailwind keeps them. */
  tile: string;
  /**
   * Live count for the tile. Optional: a surface with no countable rows (an
   * ephemeral room, say) renders as title + blurb instead of showing a
   * permanently-loading number.
   */
  load?: () => Promise<number>;
  /** GitHub handle of the contributor this surface came from. */
  credit?: string;
  /**
   * Turn capability this surface needs, when it is not served by this
   * repository. The tile is withheld unless the backend registry actually
   * holds the name, so a stock install never offers a room whose capability
   * was never installed (#963).
   */
  requiresCapability?: string;
}

export interface DashboardGroup {
  label: Lang;
  items: DashboardItem[];
}

export const DASHBOARD_GROUPS: DashboardGroup[] = [
  {
    label: { zh: "Conversations & Materials", en: "Conversations & Materials" },
    items: [
      {
        key: "chat_history",
        href: "/space/chat-history",
        icon: History,
        title: { zh: "Chat History", en: "Chat History" },
        blurb: {
          zh: "Review and reopen previous conversations.",
          en: "Review and reopen previous conversations.",
        },
        unit: { zh: "conversations", en: "conversations" },
        tile: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
        load: async () => (await listSessions(200, 0, { force: true })).length,
      },
      {
        key: "notebooks",
        href: "/notebooks",
        icon: Bookmark,
        title: { zh: "Favorites", en: "Favorites" },
        blurb: {
          zh: "Keep original conversations and sources, ready to use in your notes.",
          en: "Keep original conversations and sources, ready to use in your notes.",
        },
        unit: { zh: "collections", en: "collections" },
        tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        load: async () => (await listNotebooks()).length,
      },
      {
        key: "journal",
        href: "/space/journal",
        icon: NotebookPen,
        title: { zh: "Learning journal", en: "Learning journal" },
        blurb: {
          zh: "Inspect your mission, session handoff and confirmed records.",
          en: "Inspect your mission, session handoff and confirmed records.",
        },
        tile: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
      },
      {
        key: "question_bank",
        href: "/space/questions",
        icon: ClipboardList,
        title: { zh: "Question Bank", en: "Question Bank" },
        blurb: {
          zh: "Review and organize quiz questions across sessions.",
          en: "Review and organize quiz questions across sessions.",
        },
        unit: { zh: "questions", en: "questions" },
        tile: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        load: async () => (await listNotebookEntries({ limit: 1 })).total,
      },
      {
        key: "knowledge",
        href: "/knowledge-bases",
        icon: BookOpen,
        title: { zh: "Knowledge Center", en: "Knowledge Center" },
        blurb: {
          zh: "Manage knowledge bases and retrieval engines.",
          en: "Manage knowledge bases and retrieval engines.",
        },
        unit: { zh: "knowledge bases", en: "knowledge bases" },
        tile: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
        load: async () => (await listKnowledgeBases({ library: true })).length,
      },
    ],
  },
  {
    label: { zh: "More Projects", en: "More Projects" },
    items: [
      {
        key: "whisper",
        href: "/whisper",
        icon: Ear,
        title: { zh: "Whisper", en: "Whisper" },
        blurb: {
          zh: "Dual-seat practice room — the supervisor whispers to the trainee only.",
          en: "Dual-seat practice room — the supervisor whispers to the trainee only.",
        },
        tile: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
        credit: "alanguan73",
        // Served by the out-of-tree psych-academy plugin, not by this repo.
        requiresCapability: "whisper_visitor",
      },
    ],
  },
];

/**
 * Account-level: the agents, presets, playbooks, connectors and memory that
 * travel with the learner into every workspace. The sidebar gives these their
 * own shelf, apart from the workspace's materials above.
 */
export const PERSONALIZATION_GROUPS: DashboardGroup[] = [
  {
    label: { zh: "Personalization", en: "Personalization" },
    items: [
      {
        key: "agents",
        href: "/agents",
        icon: Bot,
        title: { zh: "My Agents", en: "My Agents" },
        blurb: {
          zh: "Connect local or remote agents and consult them from any chat.",
          en: "Connect local or remote agents and consult them from any chat.",
        },
        unit: { zh: "agents", en: "agents" },
        tile: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
        load: async () => (await listSubagentConnections()).length,
      },
      {
        key: "cli_apps",
        href: "/space/cli-apps",
        icon: Terminal,
        title: { zh: "CLI Apps", en: "CLI Apps" },
        blurb: {
          zh: "Command-line tools from the CLI-Anything catalog, callable from chat.",
          en: "Command-line tools from the CLI-Anything catalog, callable from chat.",
        },
        unit: { zh: "apps", en: "apps" },
        tile: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
        // What this reader can actually use, not what the deployment installed:
        // an app they were not granted is visible on the page but is not theirs.
        load: async () =>
          (await getCliApps()).apps.filter((app) => app.granted && app.enabled)
            .length,
      },
      {
        key: "memory",
        href: "/memory",
        icon: Brain,
        title: { zh: "Memory", en: "Memory" },
        blurb: {
          zh: "Review what your tutor remembers about you.",
          en: "Review what your tutor remembers about you.",
        },
        tile: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      },
    ],
  },
];

export const ALL_ITEMS = [
  ...DASHBOARD_GROUPS,
  ...PERSONALIZATION_GROUPS,
].flatMap((g) => g.items);

/**
 * The groups to render, given what the backend can actually serve.
 *
 * `isAvailable` is null while the probe is in flight: gated tiles stay hidden
 * until then, so a surface whose capability was never installed does not flash
 * into view and out again — an ungated tile is never affected. A group left
 * with no tiles is dropped along with its heading, or "More Projects" would
 * render as a title over nothing (#963).
 */
export function visibleGroups(
  groups: DashboardGroup[],
  isAvailable: ((name: string) => boolean) | null,
): DashboardGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          !item.requiresCapability ||
          (isAvailable?.(item.requiresCapability) ?? false),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
