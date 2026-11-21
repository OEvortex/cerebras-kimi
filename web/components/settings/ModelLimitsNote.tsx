"use client";

import type { CatalogModel } from "@/features/settings/store/SettingsStore";

type VtxLimits = {
  vtx_context_window?: number;
  vtx_max_tokens?: number;
  vtx_supported_reasoning_efforts?: string[];
};

function formatTokens(value?: number): string {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Read-only vtx/models.dev limits, shown next to the editable catalog values. */
export function ModelLimitsNote({ model }: { model: CatalogModel }) {
  const limits = model as CatalogModel & VtxLimits;
  if (!limits.vtx_context_window && !limits.vtx_max_tokens) return null;
  return (
    <p className="text-[12px] leading-relaxed text-[var(--muted-foreground)]">
      {"vtx / models.dev: "}
      <span className="font-medium text-[var(--foreground)]">
        {formatTokens(limits.vtx_context_window)} ctx
      </span>
      {limits.vtx_max_tokens ? (
        <>
          {" · max output "}
          <span className="font-medium text-[var(--foreground)]">
            {formatTokens(limits.vtx_max_tokens)}
          </span>
        </>
      ) : null}
      {limits.vtx_supported_reasoning_efforts?.length ? (
        <> · effort: {limits.vtx_supported_reasoning_efforts.join(", ")}</>
      ) : null}
    </p>
  );
}

export default ModelLimitsNote;
