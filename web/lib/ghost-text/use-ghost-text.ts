"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ghostTextEnabled, subscribeGhostText } from "./enabled";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (text: string) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./tinynext.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; id?: number; text?: string; error?: string };
      if (msg.type === "suggestion" && typeof msg.id === "number") {
        if (msg.error && process.env.NODE_ENV !== "production") {
          console.warn("[ghost-text]", msg.error);
        }
        pending.get(msg.id)?.(msg.text ?? "");
        pending.delete(msg.id);
      }
    };
    worker.onerror = (event) => {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[ghost-text] worker error", event.message);
      }
      // Drop the broken worker so the next ask() can spawn a fresh one;
      // keeping it around used to kill ghost text until a page reload.
      worker = null;
      for (const resolve of pending.values()) resolve("");
      pending.clear();
    };
    worker.postMessage({ type: "warmup" });
  }
  return worker;
}

function ask(text: string): Promise<string> {
  const w = getWorker();
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ type: "suggest", id, text });
    // Never leave a caller hanging if the worker dies. The first request has
    // to load the 15 MB model + wasm runtime, so this has to be generous.
    setTimeout(() => {
      if (pending.delete(id)) resolve("");
    }, 15000);
  });
}

/**
 * Ghost-text autocomplete for a plain-text composer.
 *
 * `value`/`cursor` describe the textarea contents; a suggestion is only
 * requested when the caret sits at the end of a single-line draft (the
 * model only knows end-of-paragraph anyway). `accept()` appends the
 * suggestion at the caret.
 */
export function useGhostText(value: string, cursor: number) {
  const enabled = useSyncExternalStore(
    subscribeGhostText,
    ghostTextEnabled,
    () => false,
  );
  const [suggestion, setSuggestion] = useState("");
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setSuggestion("");
      return;
    }
    const atEnd = cursor >= value.length;
    const singleLine = !value.includes("\n");
    const trimmed = value.trim();
    if (!atEnd || !singleLine || trimmed.length < 12) {
      setSuggestion("");
      return;
    }
    const seq = ++requestSeq.current;
    const handle = setTimeout(() => {
      void ask(value.slice(0, cursor)).then((text) => {
        if (seq === requestSeq.current) setSuggestion(text);
      });
    }, 700);
    return () => clearTimeout(handle);
  }, [enabled, value, cursor]);

  const accept = useCallback(
    (current: string, caret: number): string | null => {
      if (!suggestion) return null;
      const next = current.slice(0, caret) + suggestion + current.slice(caret);
      setSuggestion("");
      return next;
    },
    [suggestion],
  );

  const dismiss = useCallback(() => setSuggestion(""), []);

  return { enabled, suggestion, accept, dismiss };
}
