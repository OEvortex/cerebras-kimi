"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import Tooltip from "@/shared/ui/Tooltip";
import {
  summarizeVisualizeConfig,
  type VisualizeFormConfig,
} from "@/lib/visualize-types";
import {
  importVisualizer,
  installBundledVisualizer,
  listVisualizers,
  setVisualizerEnabled,
  uninstallVisualizer,
  type VisualizerCatalogItem,
} from "@/lib/visualizers-api";
import {
  CollapsibleConfigSection,
  Field,
  INPUT_CLS,
} from "@/components/chat/home/composer-field";

interface VisualizeConfigPanelProps {
  value: VisualizeFormConfig;
  onChange: (next: VisualizeFormConfig) => void;
  /**
   * When provided, the panel is wrapped in a `CollapsibleConfigSection`.
   * Omit both to render bare for the chat Activity panel.
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default memo(function VisualizeConfigPanel({
  value,
  onChange,
  collapsed,
  onToggleCollapsed,
}: VisualizeConfigPanelProps) {
  
  const [catalog, setCatalog] = useState<VisualizerCatalogItem[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [busy, setBusy] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const update = <K extends keyof VisualizeFormConfig>(
    key: K,
    val: VisualizeFormConfig[K],
  ) => onChange({ ...value, [key]: val });

  // Manim modes need extra knobs (render quality, style hint) — match what
  // the legacy Animator panel exposed so users don't lose granularity when
  // they pick "Animation" / "Storyboard" here.
  const isManim =
    value.render_mode === "manim_video" || value.render_mode === "manim_image";

  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await listVisualizers());
      setCatalogError("");
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const enabledTypes = useMemo(
    () => catalog.filter((item) => item.installed && item.enabled),
    [catalog],
  );
  const installableTypes = useMemo(
    () =>
      catalog.filter((item) => item.origin === "bundled" && !item.installed),
    [catalog],
  );
  const disabledTypes = useMemo(
    () => catalog.filter((item) => item.installed && !item.enabled),
    [catalog],
  );
  const selected = catalog.find((item) => item.id === value.render_mode);

  const mutate = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setCatalogError("");
    try {
      await action();
      await refreshCatalog();
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const body = (
    <>
      <Field label={"Render Mode"} width="w-[140px]">
        <select
          value={value.render_mode}
          onChange={(e) =>
            update(
              "render_mode",
              e.target.value as VisualizeFormConfig["render_mode"],
            )
          }
          className={`${INPUT_CLS} w-full`}
        >
          <option value="auto">{"Auto"}</option>
          {enabledTypes.length > 0 ? (
            enabledTypes.map((item) => (
              <option key={item.id} value={item.id}>
                {(item.display_name)}
              </option>
            ))
          ) : (
            <>
              <option value="chartjs">{"Chart.js"}</option>
              <option value="svg">{"SVG"}</option>
              <option value="mermaid">{"Mermaid"}</option>
              <option value="mindmap">{"Mind map"}</option>
              <option value="html">{"HTML"}</option>
              <option value="manim_video">{"Animation"}</option>
              <option value="manim_image">{"Storyboard"}</option>
            </>
          )}
          {value.render_mode !== "auto" &&
          !enabledTypes.some((item) => item.id === value.render_mode) ? (
            <option value={value.render_mode} disabled>
              {value.render_mode} ({"Unavailable"})
            </option>
          ) : null}
        </select>
      </Field>

      {isManim ? (
        <>
          <Field label={"Quality"} width="w-[100px]">
            <select
              value={value.quality}
              onChange={(e) =>
                update(
                  "quality",
                  e.target.value as VisualizeFormConfig["quality"],
                )
              }
              className={`${INPUT_CLS} w-full`}
            >
              <option value="low">{"Low"}</option>
              <option value="medium">{"Medium"}</option>
              <option value="high">{"High"}</option>
            </select>
          </Field>

          <Field label={"Style Hint"} width="min-w-[160px] flex-1">
            <input
              type="text"
              value={value.style_hint}
              onChange={(e) => update("style_hint", e.target.value)}
              placeholder={"Style, pacing, color..."}
              className={`${INPUT_CLS} w-full`}
            />
          </Field>
        </>
      ) : null}

      <Field label={"Visualizer Types"} width="min-w-[210px] flex-1">
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {installableTypes.map((item) => (
            <Tooltip key={item.id} label={(item.display_name)} description={item.description}>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void mutate(`install:${item.id}`, () =>
                    installBundledVisualizer(item.id),
                  )
                }
                className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                + {(item.display_name)}
              </button>
            </Tooltip>
          ))}
          {disabledTypes.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void mutate(`enable:${item.id}`, () =>
                  setVisualizerEnabled(item.id, true),
                )
              }
              className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              {"Enable"} {(item.display_name)}
            </button>
          ))}
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => importRef.current?.click()}
            className="rounded-md border border-dashed border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"
          >
            {"Import .zip"}
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void mutate("import", () => importVisualizer(file));
              }
            }}
          />
          {selected?.installed ? (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => {
                update("render_mode", "auto");
                void mutate(`disable:${selected.id}`, () =>
                  setVisualizerEnabled(selected.id, false),
                );
              }}
              className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              {"Disable selected"}
            </button>
          ) : null}
          {selected?.installed && selected.uninstallable ? (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => {
                update("render_mode", "auto");
                void mutate(`remove:${selected.id}`, () =>
                  uninstallVisualizer(selected.id),
                );
              }}
              className="rounded-md border border-red-300/60 px-2 py-1 text-[10px] text-red-500 disabled:opacity-50"
            >
              {"Uninstall selected"}
            </button>
          ) : null}
          {busy ? (
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {"Updating..."}
            </span>
          ) : null}
        </div>
        {catalogError ? (
          <p className="mt-1 text-[10px] text-red-500">{catalogError}</p>
        ) : null}
      </Field>
    </>
  );

  if (collapsed === undefined) {
    return (
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 px-3.5 py-2.5">
        {body}
      </div>
    );
  }

  return (
    <CollapsibleConfigSection
      collapsed={collapsed}
      summary={summarizeVisualizeConfig(value)}
      onToggleCollapsed={onToggleCollapsed ?? (() => undefined)}
      bodyClassName="flex flex-wrap items-end gap-x-3 gap-y-2 px-3.5 pb-2.5"
    >
      {body}
    </CollapsibleConfigSection>
  );
});
