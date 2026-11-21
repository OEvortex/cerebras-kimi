"use client";

import { useModules, moduleRouteAvailable } from "@/hooks/useModules";

import { usePathname } from "@/shared/router/navigation";

/**
 * Route-level gate: verifies the current pathname belongs to an installed,
 * enabled module. Mounted once per layout group, so direct-URL access to a
 * disabled module is covered too.
 */
export default function ModuleGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const { modules, error, reload } = useModules();

  if (error) return <button onClick={reload}>{"Retry"}</button>;
  if (!modules) return <div aria-busy="true">{"Loading..."}</div>;
  if (!moduleRouteAvailable(pathname, modules)) {
    return <p className="p-6">{"This module is not installed or is disabled."}</p>;
  }
  return <>{children}</>;
}
