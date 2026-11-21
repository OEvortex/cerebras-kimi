import ModuleGate from "@/components/layout/ModuleGate";

/** Settings owns its navigation, independently of the conversation sidebar. */
export default function SettingsRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ModuleGate>{children}</ModuleGate>;
}
