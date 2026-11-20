"use client";

import { useEffect, useMemo, useState } from "react";

import { Check, Copy, Loader2, type LucideIcon } from "lucide-react";
import type { RagProviderSummary } from "@/features/knowledge/api/engines";
import { copyText } from "@/lib/clipboard";
import type { ProviderConnectionStatus } from "@/lib/knowledge-helpers";
import { MODE_DESCRIPTIONS, RESPONSE_TYPE_PRESETS } from "./engine-constants";

export function StatusBadge({ status }: { status: ProviderConnectionStatus }) {
  
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
        <Check className="h-3 w-3" />
        {"Ready"}
      </span>
    );
  }
  if (status === "needs_key") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
        {"Needs key"}
      </span>
    );
  }
  if (status === "needs_setup") {
    return (
      <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[10.5px] font-medium text-sky-700 dark:bg-sky-950/30 dark:text-sky-300">
        {"Needs setup"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--muted-foreground)]">
      {"Not installed"}
    </span>
  );
}

/** Section shell: small uppercase label + bordered card body. */
export function Section({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7">
      <h2 className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </h2>
      {children}
    </section>
  );
}

export function CopyableCommand({ command }: { command: string }) {
  
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2">
      <code className="truncate font-mono text-[12px] text-[var(--foreground)]">
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          // The write is awaited before the label changes. This used to be
          // `void navigator.clipboard?.writeText(...)` followed by an
          // unconditional `setCopied(true)` — where the `?.` meant a missing
          // Clipboard API did not even throw, and the label said Copied anyway.
          void copyText(command).then(
            () => setOutcome("copied"),
            () => setOutcome("failed"),
          );
          window.setTimeout(() => setOutcome("idle"), 1500);
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        {outcome === "copied" ? (
          <Check className="h-3 w-3" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        {outcome === "copied"
          ? "Copied"
          : outcome === "failed"
            ? "Could not copy"
            : "Copy"}
      </button>
    </div>
  );
}

/** Number field used by the LlamaIndex tuning form. */
export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--foreground)]">
        {label}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
      />
      {hint && (
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {hint}
        </span>
      )}
    </label>
  );
}

export function TextField({
  label,
  hint,
  value,
  maxLength,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  maxLength: number;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--foreground)]">
        {label}
      </span>
      <input
        type="text"
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25"
      />
      {hint && (
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {hint}
        </span>
      )}
    </label>
  );
}

export function ModeSelector({
  provider,
  onSelectMode,
}: {
  provider: RagProviderSummary;
  onSelectMode: (providerId: string, mode: string) => Promise<void> | void;
}) {
  
  const modes = useMemo(() => provider.modes ?? [], [provider.modes]);
  const [selected, setSelected] = useState(
    provider.default_mode || modes[0] || "",
  );
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    setSelected(provider.default_mode || modes[0] || "");
  }, [provider.default_mode, modes]);

  const pick = async (mode: string) => {
    if (mode === selected) return;
    setSelected(mode);
    setPending(mode);
    try {
      await onSelectMode(provider.id, mode);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {modes.map((mode) => {
        const active = mode === selected;
        const desc = MODE_DESCRIPTIONS[`${provider.id}:${mode}`];
        return (
          <button
            key={mode}
            type="button"
            onClick={() => void pick(mode)}
            className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
              active
                ? "border-[var(--primary)] bg-[var(--primary)]/5"
                : "border-[var(--border)] hover:border-[var(--ring)]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-medium text-[var(--foreground)]">
                {mode}
              </span>
              {pending === mode ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--muted-foreground)]" />
              ) : active ? (
                <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
              ) : null}
            </div>
            {desc && (
              <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                {(desc)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function ResponseTypeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  
  const known = RESPONSE_TYPE_PRESETS.includes(value);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--foreground)]">
        {"Response style"}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25"
      >
        {RESPONSE_TYPE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        {!known && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-[12px] font-medium text-[var(--foreground)]">
          {label}
        </span>
        {hint && (
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {hint}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-[var(--primary)]" : "bg-[var(--border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export function SaveButton({
  dirty,
  saving,
  invalid = false,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  invalid?: boolean;
  onSave: () => void;
}) {
  
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || saving || invalid}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {"Save changes"}
      </button>
    </div>
  );
}

/** Shared loader + dirty-tracking scaffold for the small engine config forms. */
export function useEngineForm<T>(
  load: () => Promise<T>,
  onError: (m: string) => void,
) {
  const [loaded, setLoaded] = useState<T | null>(null);
  const [form, setForm] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((cfg) => {
        if (cancelled) return;
        setLoaded(cfg);
        setForm(cfg);
      })
      .catch((err) =>
        onError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => !!form && !!loaded && JSON.stringify(form) !== JSON.stringify(loaded),
    [form, loaded],
  );
  const patch = (p: Partial<T>) =>
    setForm((prev) => (prev ? { ...prev, ...p } : prev));
  return { loaded, form, setLoaded, setForm, saving, setSaving, dirty, patch };
}

export function FormSkeleton() {
  return (
    <div className="flex items-center justify-center rounded-2xl border border-[var(--border)] py-10">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
    </div>
  );
}
