import React from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { READING_HOME } from "@/lib/learning-routes";
import {
  AgentsLayoutWrapper,
  CoWriterLayoutWrapper,
  LearningLayoutWrapper,
  MasteryLayoutWrapper,
  MasterySessionsLayoutWrapper,
  MemoryLayoutWrapper,
  ReadingLayoutWrapper,
  RootShell,
  SettingsGroupLayoutWrapper,
  SettingsLayoutWrapper,
  SpaceLayoutWrapper,
  UtilityLayoutWrapper,
  WorkspaceLayoutWrapper,
} from "./router/layouts";
import { LazyRoute, lazyPage } from "./router/lazy";
import { createRedirectRoutes } from "./router/redirects";

const LazySettingsPageContent = React.lazy(
  () => import("@/components/settings/SettingsPageContent"),
);
const LazyReadingFolderPage = React.lazy(() =>
  import("@/components/reading/library/ReadingFolder").then((m) => ({
    default: m.ReadingFolderPage,
  })),
);
const LazyLegacyWatchingSession = React.lazy(
  () => import("@/components/reading/workspace/LegacyWatchingSession"),
);

const rootRoute = createRootRoute({
  component: RootShell,
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">404</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Page not found
        </p>
      </div>
    </div>
  ),
});

// (settings) group
const settingsGroupLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "settings-group",
  component: SettingsGroupLayoutWrapper,
});
const settingsLayoutRoute = createRoute({
  getParentRoute: () => settingsGroupLayoutRoute,
  path: "/settings",
  component: SettingsLayoutWrapper,
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(settings)/settings/page")),
});
const settingsSectionRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: "/$section",
  component: function SettingsSectionRouteComponent() {
    const { section } = settingsSectionRoute.useParams();
    return (
      <LazyRoute>
        <LazySettingsPageContent section={section} />
      </LazyRoute>
    );
  },
});

// (utility) group
const utilityLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "utility",
  component: UtilityLayoutWrapper,
});
const agentsLayoutRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/agents",
  component: AgentsLayoutWrapper,
});
const agentsIndexRoute = createRoute({
  getParentRoute: () => agentsLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(utility)/agents/page")),
});
const avatarPreviewRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/avatar-preview",
  component: lazyPage(() => import("@/app/(utility)/avatar-preview/page")),
});
const knowledgeBasesIndexRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/knowledge-bases",
  component: lazyPage(() => import("@/app/(utility)/knowledge-bases/page")),
});
const knowledgeBasesDetailRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/knowledge-bases/$kbName",
  component: lazyPage(
    () => import("@/app/(utility)/knowledge-bases/[kbName]/page"),
  ),
});

const memoryLayoutRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/memory",
  component: MemoryLayoutWrapper,
});
const memoryIndexRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(utility)/memory/page")),
});
const memoryGraphRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/graph",
  component: lazyPage(() => import("@/app/(utility)/memory/graph/page")),
});
const memoryL1Route = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/l1",
  component: lazyPage(() => import("@/app/(utility)/memory/l1/page")),
});
const memoryL2IndexRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/l2",
  component: lazyPage(() => import("@/app/(utility)/memory/l2/page")),
});
const memoryL2SurfaceRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/l2/$surface",
  component: lazyPage(
    () => import("@/app/(utility)/memory/l2/[surface]/page"),
  ),
});
const memoryL3IndexRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/l3",
  component: lazyPage(() => import("@/app/(utility)/memory/l3/page")),
});
const memoryL3SlotRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/l3/$slot",
  component: lazyPage(() => import("@/app/(utility)/memory/l3/[slot]/page")),
});
const memoryResolveRoute = createRoute({
  getParentRoute: () => memoryLayoutRoute,
  path: "/resolve",
  component: lazyPage(() => import("@/app/(utility)/memory/resolve/page")),
});

const notebooksIndexRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/notebooks",
  component: lazyPage(() => import("@/app/(utility)/notebooks/page")),
});
const notebooksDetailRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/notebooks/$notebookId",
  component: lazyPage(
    () => import("@/app/(utility)/notebooks/[notebookId]/page"),
  ),
});
const personalizationRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/personalization",
  component: lazyPage(() => import("@/app/(utility)/personalization/page")),
});
const settingsProgressRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/settings/progress",
  component: lazyPage(() => import("@/app/(utility)/settings/progress/page")),
});

const spaceLayoutRoute = createRoute({
  getParentRoute: () => utilityLayoutRoute,
  path: "/space",
  component: SpaceLayoutWrapper,
});
const spaceIndexRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(utility)/space/page")),
});
const spaceChatHistoryRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/chat-history",
  component: lazyPage(() => import("@/app/(utility)/space/chat-history/page")),
});
const spaceCliAppsRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/cli-apps",
  component: lazyPage(() => import("@/app/(utility)/space/cli-apps/page")),
});
const spaceJournalRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/journal",
  component: lazyPage(() => import("@/app/(utility)/space/journal/page")),
});
const spaceQuestionsRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/questions",
  component: lazyPage(() => import("@/app/(utility)/space/questions/page")),
});

// (workspace) group
const workspaceLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "workspace",
  component: WorkspaceLayoutWrapper,
});
const calendarRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/calendar",
  component: lazyPage(() => import("@/app/(workspace)/calendar/page")),
});
const chatIndexRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/chat",
  component: lazyPage(() => import("@/app/(workspace)/chat/page")),
});
const chatSessionRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/chat/$sessionId",
  component: lazyPage(() => import("@/app/(workspace)/chat/[sessionId]/page")),
});

const coWriterLayoutRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/co-writer",
  component: CoWriterLayoutWrapper,
});
const coWriterIndexRoute = createRoute({
  getParentRoute: () => coWriterLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(workspace)/co-writer/page")),
});
const coWriterDocRoute = createRoute({
  getParentRoute: () => coWriterLayoutRoute,
  path: "/$docId",
  component: lazyPage(
    () => import("@/app/(workspace)/co-writer/[docId]/page"),
  ),
});
const whisperRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/whisper",
  component: lazyPage(() => import("@/app/(workspace)/whisper/page")),
});

// learning subtree
const learningLayoutRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/learning",
  component: LearningLayoutWrapper,
});
const learningIndexRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(workspace)/learning/page")),
});
const learningNewRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/new",
  component: lazyPage(() => import("@/app/(workspace)/learning/new/page")),
});
const learningPracticeRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/practice",
  component: lazyPage(() => import("@/app/(workspace)/learning/practice/page")),
});
const learningBooksIndexRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/books",
  component: lazyPage(() => import("@/app/(workspace)/learning/books/page")),
});
const learningBooksDetailRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/books/$bookId",
  component: lazyPage(
    () => import("@/app/(workspace)/learning/books/[bookId]/page"),
  ),
});
const learningBooksPageRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/books/$bookId/pages/$pageId",
  component: lazyPage(
    () =>
      import("@/app/(workspace)/learning/books/[bookId]/pages/[pageId]/page"),
  ),
});

const masteryLayoutRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/mastery",
  component: MasteryLayoutWrapper,
});
const masteryIndexRoute = createRoute({
  getParentRoute: () => masteryLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(workspace)/learning/mastery/page")),
});
const masteryPathRoute = createRoute({
  getParentRoute: () => masteryLayoutRoute,
  path: "/$pathId",
  component: lazyPage(
    () => import("@/app/(workspace)/learning/mastery/[pathId]/page"),
  ),
});
const masterySessionsLayoutRoute = createRoute({
  getParentRoute: () => masteryLayoutRoute,
  path: "/$pathId/sessions",
  component: MasterySessionsLayoutWrapper,
});
const masterySessionsIndexRoute = createRoute({
  getParentRoute: () => masterySessionsLayoutRoute,
  path: "/",
  component: lazyPage(
    () => import("@/app/(workspace)/learning/mastery/[pathId]/sessions/page"),
  ),
});
const masterySessionsDetailRoute = createRoute({
  getParentRoute: () => masterySessionsLayoutRoute,
  path: "/$sessionId",
  component: lazyPage(
    () =>
      import(
        "@/app/(workspace)/learning/mastery/[pathId]/sessions/[sessionId]/page"
      ),
  ),
});

const readingLayoutRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/reading",
  component: ReadingLayoutWrapper,
});
const readingIndexRoute = createRoute({
  getParentRoute: () => readingLayoutRoute,
  path: "/",
  component: lazyPage(() => import("@/app/(workspace)/learning/reading/page")),
});
const readingMaterialsRoute = createRoute({
  getParentRoute: () => readingLayoutRoute,
  path: "/materials",
  component: lazyPage(
    () => import("@/app/(workspace)/learning/reading/materials/page"),
  ),
});
const readingFolderRoute = createRoute({
  getParentRoute: () => readingLayoutRoute,
  path: "/folders/$folderId",
  component: function ReadingFolderRouteComponent() {
    const { folderId } = readingFolderRoute.useParams();
    return (
      <LazyRoute>
        <LazyReadingFolderPage folderId={decodeURIComponent(folderId)} />
      </LazyRoute>
    );
  },
});
const readingWorkspaceRoute = createRoute({
  getParentRoute: () => readingLayoutRoute,
  path: "/$workspaceId",
  component: lazyPage(
    () => import("@/app/(workspace)/learning/reading/[workspaceId]/page"),
  ),
});
const readingWorkspaceSessionsRoute = createRoute({
  getParentRoute: () => readingLayoutRoute,
  path: "/$workspaceId/sessions",
  component: lazyPage(
    () =>
      import("@/app/(workspace)/learning/reading/[workspaceId]/sessions/page"),
  ),
});
const readingWorkspaceSessionDetailRoute = createRoute({
  getParentRoute: () => readingLayoutRoute,
  path: "/$workspaceId/sessions/$sessionId",
  component: lazyPage(
    () =>
      import(
        "@/app/(workspace)/learning/reading/[workspaceId]/sessions/[sessionId]/page"
      ),
  ),
});

const watchingIndexRedirectRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/watching",
  beforeLoad: ({ location }) => {
    throw redirect({ href: `${READING_HOME}${location.searchStr}` });
  },
});
const watchingSessionRoute = createRoute({
  getParentRoute: () => learningLayoutRoute,
  path: "/watching/$sessionId",
  component: function WatchingSessionRouteComponent() {
    const { sessionId } = watchingSessionRoute.useParams();
    return (
      <LazyRoute>
        <LazyLegacyWatchingSession sessionId={sessionId} />
      </LazyRoute>
    );
  },
});

const routeTree = rootRoute.addChildren([
  ...createRedirectRoutes(rootRoute),
  settingsGroupLayoutRoute.addChildren([
    settingsLayoutRoute.addChildren([settingsIndexRoute, settingsSectionRoute]),
  ]),
  utilityLayoutRoute.addChildren([
    agentsLayoutRoute.addChildren([agentsIndexRoute]),
    avatarPreviewRoute,
    knowledgeBasesIndexRoute,
    knowledgeBasesDetailRoute,
    memoryLayoutRoute.addChildren([
      memoryIndexRoute,
      memoryGraphRoute,
      memoryL1Route,
      memoryL2IndexRoute,
      memoryL2SurfaceRoute,
      memoryL3IndexRoute,
      memoryL3SlotRoute,
      memoryResolveRoute,
    ]),
    notebooksIndexRoute,
    notebooksDetailRoute,
    personalizationRoute,
    settingsProgressRoute,
    spaceLayoutRoute.addChildren([
      spaceIndexRoute,
      spaceChatHistoryRoute,
      spaceCliAppsRoute,
      spaceJournalRoute,
      spaceQuestionsRoute,
    ]),
  ]),
  workspaceLayoutRoute.addChildren([
    calendarRoute,
    chatIndexRoute,
    chatSessionRoute,
    coWriterLayoutRoute.addChildren([coWriterIndexRoute, coWriterDocRoute]),
    whisperRoute,
    learningLayoutRoute.addChildren([
      learningIndexRoute,
      learningNewRoute,
      learningPracticeRoute,
      learningBooksIndexRoute,
      learningBooksDetailRoute,
      learningBooksPageRoute,
      masteryLayoutRoute.addChildren([
        masteryIndexRoute,
        masteryPathRoute,
        masterySessionsLayoutRoute.addChildren([
          masterySessionsIndexRoute,
          masterySessionsDetailRoute,
        ]),
      ]),
      readingLayoutRoute.addChildren([
        readingIndexRoute,
        readingMaterialsRoute,
        readingFolderRoute,
        readingWorkspaceRoute,
        readingWorkspaceSessionsRoute,
        readingWorkspaceSessionDetailRoute,
      ]),
      watchingIndexRedirectRoute,
      watchingSessionRoute,
    ]),
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
