"use client";

import { defineFunction } from "@openuidev/react-lang";
import { z } from "zod/v4";

/**
 * Helpers the notebook DSL documents that are not lang-core built-ins.
 * Count/First/Last/Sum/Avg/Round/Sort/Filter/Each are provided by the parser
 * itself and must not be redefined here (createLibrary rejects the collision).
 */
const num = z.number();
const str = z.string();
const arr = z.array(z.any());
const anyValue = z.any();

export const notebookFunctions = [
  defineFunction({ name: "Join", description: "Join an array into a string.", params: z.object({ a: arr, sep: str.optional() }), returns: str, fn: ({ a, sep }) => a.map((value) => String(value ?? "")).join(sep ?? ", ") }),
  defineFunction({ name: "Unique", description: "Remove duplicates.", params: z.object({ a: arr }), fn: ({ a }) => [...new Set(a)] }),
  defineFunction({ name: "Range", description: "Numbers from start to end.", params: z.object({ start: num, end: num }), fn: ({ start, end }) => Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i) }),
  defineFunction({ name: "Format", description: "Format a number.", params: z.object({ value: anyValue, kind: str.optional(), decimals: num.optional() }), returns: str, fn: ({ value, kind, decimals }) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value ?? "");
    if (kind === "percent") return `${(n * 100).toFixed(decimals ?? 0)}%`;
    return n.toFixed(decimals ?? 0);
  } }),
  defineFunction({ name: "Plural", description: "Count with a singular or plural word.", params: z.object({ n: num, word: str, plural: str.optional() }), returns: str, fn: ({ n, word, plural }) => `${n} ${n === 1 ? word : plural || `${word}s`}` }),
  defineFunction({ name: "Upper", description: "Upper-case text.", params: z.object({ text: str }), returns: str, fn: ({ text }) => text.toUpperCase() }),
  defineFunction({ name: "Lower", description: "Lower-case text.", params: z.object({ text: str }), returns: str, fn: ({ text }) => text.toLowerCase() }),
  defineFunction({ name: "Default", description: "Fallback when a value is empty.", params: z.object({ value: anyValue, fallback: anyValue }), fn: ({ value, fallback }) => value == null || value === "" ? fallback : value }),
];

/** Exported for the compiler's evaluation context. */
export function notebookRuntimeFunctions(): Record<string, (args: Record<string, unknown>) => unknown> {
  const out: Record<string, (args: Record<string, unknown>) => unknown> = {};
  for (const definition of notebookFunctions) {
    out[definition.name] = (args: Record<string, unknown>) => {
      try {
        return (definition.fn as (args: Record<string, unknown>) => unknown)(args);
      } catch {
        return null;
      }
    };
  }
  return out;
}
