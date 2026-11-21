import { PageCustomizationProvider } from "@/context/PageCustomizationContext";
import CalendarRuntime from "@/features/calendar/components/CalendarRuntime";
import WorkspaceSidebar from "@/components/sidebar/WorkspaceSidebar";
import AppShell from "@/components/layout/AppShell";
import { LayoutPageBar } from "@/features/ui-layout/slots";
import ModuleGate from "@/components/layout/ModuleGate";
import { ChatRuntimeProvider } from "@/features/chat/ChatRuntimeProvider";
import { ReadingProvider } from "@/context/ReadingContext";
import { Suspense } from "react";
import { WorkspaceRuntimeBoundary } from "@/components/workspaces/WorkspaceRuntimeBoundary";

export default function WorkspaceLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
          <PageCustomizationProvider>
      <Suspense>
        <WorkspaceRuntimeBoundary>
          <CalendarRuntime>
          {/* Inside the boundary: each workspace has its own board. */}
            <ChatRuntimeProvider>
              {/* Above the page on purpose: sending the first message navigates
            /chat → /chat/<id>, which remounts the page. The open document
            must not die with it. */}
              <ReadingProvider>
                  <AppShell sidebar={<WorkspaceSidebar />} pageBar={<LayoutPageBar />}>
                    <ModuleGate>{children}</ModuleGate>
                  </AppShell>
              </ReadingProvider>
            </ChatRuntimeProvider>
        </CalendarRuntime>
        </WorkspaceRuntimeBoundary>
      </Suspense>
    </PageCustomizationProvider>
  );
}
