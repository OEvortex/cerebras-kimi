"use client";

import React from "react";

import { splitInlineMath } from "@/lib/openui/components/math";
import { MathNode } from "@/lib/openui/components/math";

/** Only http(s) and mailto links are rendered — never a javascript: URL. */
function safeUrl(raw: string): string | null {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value;
  if (/^\//.test(value)) return value;
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/**
 * Small, safe subset of Markdown for prose inside a notebook program:
 * **bold**, *italic*, `code`, [links](https://…) and $LaTeX$ inline math.
 * Everything else stays literal text — the point is to render model prose
 * without ever injecting HTML.
 */
export function renderRichText(input: unknown): React.ReactNode {
  const text = typeof input === "string" ? input : input == null ? "" : String(input);
  if (!text) return null;

  const out: React.ReactNode[] = [];
  splitInlineMath(text).forEach((segment, index) => {
    if (segment.kind === "math") {
      out.push(
        <MathNode key={`m${index}`} tex={segment.tex} display={segment.display} />,
      );
      return;
    }
    const parts = segment.value.split(INLINE);
    parts.forEach((part, partIndex) => {
      const key = `t${index}-${partIndex}`;
      if (!part) return;
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
        return;
      }
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        out.push(<code key={key}>{part.slice(1, -1)}</code>);
        return;
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        out.push(<em key={key}>{part.slice(1, -1)}</em>);
        return;
      }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        const url = safeUrl(link[2]);
        if (url) {
          out.push(
            <a key={key} href={url} target="_blank" rel="noopener noreferrer">
              {link[1]}
            </a>,
          );
          return;
        }
      }
      out.push(part);
    });
  });
  return out;
}

/** Defensive array read: streamed arrays may be partial or malformed. */
export function arrayOf<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Defensive string read. */
export function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}
