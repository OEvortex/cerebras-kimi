"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Trash2, X, type LucideIcon } from "lucide-react";

import Tooltip from "@/shared/ui/Tooltip";
import { notify } from "@/lib/notifications";
import type { SiblingInfo } from "@/lib/message-branches";
import { QUOTE_RULE_CLASS } from "@/components/chat/home/QuotedPassage";
import { AnswererMark } from "@/features/chat/trace/AnswererMark";
import { answererOf } from "@/features/chat/trace/answerer";
import { useConnectedAgentKinds } from "@/hooks/useConnectedAgentKinds";
import { usePartner } from "@/hooks/usePartnerRoster";

export function RoughActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="inline-flex items-center justify-center rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Icon size={15} strokeWidth={1.5} />
      </button>
    </Tooltip>
  );
}

/**
 * ``Promise<void>`` and not ``void | Promise<void>``: this button reports
 * success to the user, so it needs a handler that can tell it about failure.
 * A synchronously-void handler has no way to, which is how a swallowed
 * clipboard error came to be rendered as Copied.
 */
export type CopyHandler = (content: string) => Promise<void>;

export function CopyActionButton({
  content,
  onCopy,
}: {
  content: string;
  onCopy: CopyHandler;
}) {
  
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    const settle = (next: "copied" | "failed") => {
      setOutcome(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setOutcome("idle"), 1600);
    };
    // `Promise.resolve().then(() => onCopy(...))` rather than
    // `Promise.resolve(onCopy(...))`: the latter runs the handler outside the
    // chain, so a *synchronous* throw — which is exactly what reading
    // `navigator.clipboard.writeText` on an insecure origin does — escapes it.
    void Promise.resolve()
      .then(() => onCopy(content))
      .then(
        () => settle("copied"),
        () => settle("failed"),
      );
  }, [content, onCopy]);

  const label =
    outcome === "copied"
      ? "Copied"
      : outcome === "failed"
        ? "Could not copy"
        : "Copy";

  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={handleClick}
        aria-live="polite"
        aria-label={label}
        className={`inline-flex items-center justify-center rounded-md p-1 transition-colors ${
          outcome === "copied"
            ? "text-[var(--primary)]"
            : outcome === "failed"
              ? "text-[var(--destructive)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)]"
        }`}
      >
        {outcome === "copied" ? (
          <Check size={15} strokeWidth={2} />
        ) : outcome === "failed" ? (
          <X size={15} strokeWidth={2} />
        ) : (
          <Copy size={15} strokeWidth={1.5} />
        )}
      </button>
    </Tooltip>
  );
}


export function BranchNavigator({
  info,
  onSwitch,
}: {
  info: SiblingInfo;
  onSwitch: (childId: number) => void;
}) {
  
  const prevIdx = info.index - 2; // 0-based prev index
  const nextIdx = info.index; // 0-based next index
  const prevId = prevIdx >= 0 ? info.siblingIds[prevIdx] : null;
  const nextId =
    nextIdx < info.siblingIds.length ? info.siblingIds[nextIdx] : null;
  return (
    <div className="inline-flex items-center gap-0.5 text-[10.5px] text-[var(--muted-foreground)]">
      <button
        type="button"
        onClick={() => prevId !== null && onSwitch(prevId)}
        disabled={prevId === null}
        aria-label={"Previous branch"}
        className="rounded p-0.5 transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronLeft size={12} strokeWidth={1.8} />
      </button>
      <span className="select-none tabular-nums">
        {info.index} / {info.total}
      </span>
      <button
        type="button"
        onClick={() => nextId !== null && onSwitch(nextId)}
        disabled={nextId === null}
        aria-label={"Next branch"}
        className="rounded p-0.5 transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronRight size={12} strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function DeleteTurnButton({ onDelete }: { onDelete: () => void }) {
  
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <RoughActionButton
        icon={Trash2}
        label={"Delete"}
        onClick={() => setConfirm(true)}
      />
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 text-[11px]">
      <span className="text-[var(--muted-foreground)]">
        {"Delete this turn?"}
      </span>
      <button
        type="button"
        onClick={() => {
          onDelete();
          setConfirm(false);
        }}
        className="rounded-md px-1.5 py-0.5 font-medium text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
      >
        {"Delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirm(false)}
        className="rounded-md px-1.5 py-0.5 font-medium text-[var(--muted-foreground)] hover:bg-[var(--muted)]/40"
      >
        {"Cancel"}
      </button>
    </div>
  );
}


export function ReadingPassageQuote({ quote, href }: { quote: string; href?: string }) {
  
  const className = `mb-1.5 block ${QUOTE_RULE_CLASS}`;
  const text = <span className="line-clamp-3">{quote}</span>;
  return href ? (
    <a
      href={href}
      aria-label={`${"Go to this passage"}: ${quote}`}
      className={`${className} transition-colors hover:text-[var(--foreground)]`}
    >
      {text}
    </a>
  ) : (
    <div className={className}>{text}</div>
  );
}


export function HandedToBadge({
  kind,
  id,
  agentKind,
}: {
  kind: "partner" | "subagent";
  id: string;
  agentKind?: string;
}) {
  
  const partner = usePartner(kind === "partner" ? id : null);
  const name = partner?.name ?? id;
  return (
    <div className="flex items-center justify-end gap-1.5 pr-1 text-[11px] text-[var(--muted-foreground)]">
      <AnswererMark answerer={{ kind, id, name, agent: agentKind }} size={14} />
      <span>{`Handed to ${name}`}</span>
    </div>
  );
}
