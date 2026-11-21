import { Outlet } from "@tanstack/react-router";
import SettingsReturnTracker from "@/components/settings/SettingsReturnTracker";
import { WorkspaceNavigation } from "@/components/workspaces/WorkspaceNavigation";
import MotionProvider from "@/components/common/MotionProvider";
import ToastViewport from "@/components/common/ToastViewport";
import { AppShellProvider } from "@/context/AppShellContext";

import SettingsGroupLayout from "@/app/(settings)/layout";
import SettingsLayout from "@/app/(settings)/settings/layout";
import UtilityLayout from "@/app/(utility)/layout";
import AgentsLayout from "@/app/(utility)/agents/layout";
import MemoryLayout from "@/app/(utility)/memory/layout";
import SpaceLayout from "@/app/(utility)/space/layout";
import WorkspaceLayout from "@/app/(workspace)/layout";
import CoWriterLayout from "@/app/(workspace)/co-writer/layout";
import LearningLayout from "@/app/(workspace)/learning/layout";
import MasteryLayout from "@/app/(workspace)/learning/mastery/layout";
import MasterySessionsLayout from "@/app/(workspace)/learning/mastery/[pathId]/sessions/layout";
import ReadingLayout from "@/app/(workspace)/learning/reading/layout";

export function RootShell() {
  return (
    <AppShellProvider>
      <SettingsReturnTracker />
      <WorkspaceNavigation />
      <MotionProvider>
        <Outlet />
      </MotionProvider>
      <ToastViewport />
    </AppShellProvider>
  );
}

export function SettingsGroupLayoutWrapper() {
  return (
    <SettingsGroupLayout>
      <Outlet />
    </SettingsGroupLayout>
  );
}

export function SettingsLayoutWrapper() {
  return (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  );
}

export function UtilityLayoutWrapper() {
  return (
    <UtilityLayout>
      <Outlet />
    </UtilityLayout>
  );
}

export function AgentsLayoutWrapper() {
  return (
    <AgentsLayout>
      <Outlet />
    </AgentsLayout>
  );
}

export function MemoryLayoutWrapper() {
  return (
    <MemoryLayout>
      <Outlet />
    </MemoryLayout>
  );
}

export function SpaceLayoutWrapper() {
  return (
    <SpaceLayout>
      <Outlet />
    </SpaceLayout>
  );
}

export function WorkspaceLayoutWrapper() {
  return (
    <WorkspaceLayout>
      <Outlet />
    </WorkspaceLayout>
  );
}

export function CoWriterLayoutWrapper() {
  return (
    <CoWriterLayout>
      <Outlet />
    </CoWriterLayout>
  );
}

export function LearningLayoutWrapper() {
  return (
    <LearningLayout>
      <Outlet />
    </LearningLayout>
  );
}

export function MasteryLayoutWrapper() {
  return (
    <MasteryLayout>
      <Outlet />
    </MasteryLayout>
  );
}

export function MasterySessionsLayoutWrapper() {
  return (
    <MasterySessionsLayout>
      <Outlet />
    </MasterySessionsLayout>
  );
}

export function ReadingLayoutWrapper() {
  return (
    <ReadingLayout>
      <Outlet />
    </ReadingLayout>
  );
}
