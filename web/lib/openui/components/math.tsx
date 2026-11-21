"use client";

import "katex/dist/katex.min.css";

import katex from "katex";
import React from "react";
import type {
  ComponentRenderProps,
  DefinedComponent,
} from "@openuidev/react-lang";

/**
 * Inline maths for OpenUI Lang components.
 *
 * `@openuidev/intelligent-ui-library` renders every text prop through its own
 * `inline()` helper, which understands `**bold**`, `*italic*`, `~~strike~~`,
 * `` `code` `` and `[links]()` — and nothing else. A model that writes tutor
 * prose keeps writing `$z = f(x,y)$`, as it does everywhere else in the app, so
 * the formula reaches the reader as source. Display maths escaped this only
 * because the model happened to emit a `Math("...")` component for those, and
 * that component is the library's own KaTeX wrapper.
 *
 * The components render a string prop into children before the browser sees
 * it, so we mask each formula with a placeholder that survives `inline()`,
 * render the program, then swap the placeholders in the React tree for KaTeX.
 * The library's own classes are reused, so the output is styled exactly like a
 * `Math(...)` component and no component schema, prompt or CSS changes.
 */

const MATH_OPEN = "\uE000";
const MATH_CLOSE = "\uE001";
const PLACEHOLDER = new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, "g");

/** The class the library's own `Math` component puts on its root element. */
const MATH_CLASS = "openui-intelligent-math";
/** The class of the display-mode box the library wraps block maths in. */
const MATH_BLOCK_CLASS = "openui-intelligent-math--block";

export type MathSegment =
  | { kind: "text"; value: string }
  | { kind: "math"; tex: string; display: boolean };

export type MathPart = { tex: string; display: boolean };

/**
 * Split a component string into plain text and LaTeX.
 *
 * Mirrors remark-math's single-dollar rules: `$` must be followed by
 * non-whitespace, the closing `$` must not be preceded by whitespace and must
 * not be followed by a digit — so `it costs $5 or $7` stays money. Code spans
 * and fenced blocks are copied through untouched, and `\$` is a literal dollar.
 * `\(...\)`, `\[...\]` and `$$...$$` are accepted too, which is what many
 * models emit instead of dollars.
 */
function splitInlineMath(input: string): MathSegment[] {
  const out: MathSegment[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", value: buffer });
      buffer = "";
    }
  };
  const pushMath = (tex: string, display: boolean) => {
    if (!tex.trim()) {
      buffer += display ? `$$${tex}$$` : `$${tex}$`;
      return;
    }
    flush();
    out.push({ kind: "math", tex, display });
  };

  let i = 0;
  while (i < input.length) {
    const char = input[i];

    // Code spans and fences are literal: a formula-looking `$` in a snippet of
    // Python is not maths.
    if (char === "`") {
      const fence = input.startsWith("```", i);
      const token = fence ? "```" : "`";
      const close = input.indexOf(token, i + token.length);
      const end = close === -1 ? input.length : close + token.length;
      buffer += input.slice(i, end);
      i = end;
      continue;
    }

    if (char === "\\") {
      const next = input[i + 1];
      if (next === "$") {
        buffer += "$";
        i += 2;
        continue;
      }
      if (next === "(" || next === "[") {
        const token = next === "(" ? "\\)" : "\\]";
        const close = input.indexOf(token, i + 2);
        if (close !== -1) {
          pushMath(input.slice(i + 2, close), next === "[");
          i = close + 2;
          continue;
        }
      }
      buffer += char + (next ?? "");
      i += next === undefined ? 1 : 2;
      continue;
    }

    if (char === "$") {
      if (input[i + 1] === "$") {
        const close = input.indexOf("$$", i + 2);
        if (close !== -1) {
          pushMath(input.slice(i + 2, close).trim(), true);
          i = close + 2;
          continue;
        }
      } else {
        const close = findSingleDollarClose(input, i);
        if (close !== -1) {
          pushMath(input.slice(i + 1, close), false);
          i = close + 1;
          continue;
        }
      }
    }

    buffer += char;
    i++;
  }

  flush();
  return out;
}

function findSingleDollarClose(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;

  for (let j = open + 1; j < text.length; j++) {
    const char = text[j];
    if (char === "\\") {
      j++;
      continue;
    }
    if (char === "\n") return -1;
    if (char !== "$") continue;
    if (/\s/.test(text[j - 1])) continue;
    if (/\d/.test(text[j + 1] ?? "")) continue;
    return j;
  }
  return -1;
}

/** Mask formulas so they can travel through a renderer that only knows strings. */
export function maskMath(value: string): { mask: string; parts: MathPart[] } {
  const segments = splitInlineMath(value);
  if (!segments.some((segment) => segment.kind === "math")) {
    return { mask: value, parts: [] };
  }

  const parts: MathPart[] = [];
  let mask = "";
  for (const segment of segments) {
    if (segment.kind === "text") {
      mask += segment.value;
      continue;
    }
    const index = parts.push({ tex: segment.tex, display: segment.display }) - 1;
    mask += `${MATH_OPEN}${index}${MATH_CLOSE}`;
  }
  return { mask, parts };
}

/** A formula, rendered the way the library's `Math` component renders it. */
export function MathNode({
  tex,
  display,
}: {
  tex: string;
  display: boolean;
}): React.ReactElement {
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: "ignore",
    output: "htmlAndMathml",
  });
  return (
    <span
      className={display ? `${MATH_CLASS} ${MATH_BLOCK_CLASS}` : MATH_CLASS}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type AnyProps = Record<string, unknown> & { children?: unknown };
type AnyDefinedComponent = DefinedComponent<any>;

/**
 * Strip the math delimiters a model wraps a `Math(...)` argument in.
 *
 * `Math` takes raw LaTeX, but the same model writes `$...$` in prose all day, so
 * it hands the component `"$E=mc^2$"` often enough to matter. KaTeX reads the
 * leading `$` as a parse error and the formula prints as red source text.
 * Only a balanced pair is unwrapped, and only when it is the *whole* string, so
 * a formula containing a literal `\$` or several separate spans is left alone.
 */
export function normalizeTex(input: string): string {
  const tex = String(input ?? "").trim();
  if (!tex) return tex;
  const count = (token: string) => tex.split(token).length - 1;

  if (tex.startsWith("$$") && tex.endsWith("$$") && count("$$") === 2) {
    return tex.slice(2, -2).trim();
  }
  // `\$` is an escaped literal dollar, never a delimiter.
  if (tex.startsWith("$") && tex.endsWith("$") && count("$") === 2) {
    return tex.slice(1, -1).trim();
  }
  if (tex.startsWith("\\[") && tex.endsWith("\\]") && count("\\[") === 1) {
    return tex.slice(2, -2).trim();
  }
  if (tex.startsWith("\\(") && tex.endsWith("\\)") && count("\\(") === 1) {
    return tex.slice(2, -2).trim();
  }
  return tex;
}

/** Wrap a component so a delimited `tex` prop is unwrapped before KaTeX sees it. */
export function withNormalizedTex<T extends AnyDefinedComponent>(definition: T): T {
  const component = (context: ComponentRenderProps<AnyProps>) => {
    const props = context.props ?? {};
    const raw = props.tex;
    const render = definition.component as (
      context: ComponentRenderProps<AnyProps>,
    ) => React.ReactNode;
    if (typeof raw !== "string") return render(context);
    const tex = normalizeTex(raw);
    return tex === raw ? render(context) : render({ ...context, props: { ...props, tex } });
  };
  return { ...definition, component } as T;
}

/** Replace placeholders inside the tree a component produced. */
function injectMath(node: React.ReactNode, parts: MathPart[]): React.ReactNode {
  if (typeof node === "string") return splitPlaceholderString(node, parts);
  if (Array.isArray(node)) return node.map((child) => injectMath(child, parts));
  if (!React.isValidElement(node)) return node;

  const props = node.props as AnyProps;
  if (props.dangerouslySetInnerHTML) return node;

  const children = props.children;
  if (children == null || typeof children === "function") return node;

  const next = injectMath(children as React.ReactNode, parts);
  return React.cloneElement(node as React.ReactElement<AnyProps>, undefined, next);
}

function splitPlaceholderString(
  value: string,
  parts: MathPart[],
): React.ReactNode {
  if (!value.includes(MATH_OPEN)) return value;

  const out: React.ReactNode[] = [];
  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;
  for (let match = PLACEHOLDER.exec(value); match; match = PLACEHOLDER.exec(value)) {
    if (match.index > cursor) out.push(value.slice(cursor, match.index));
    const part = parts[Number(match[1])];
    if (!part) continue;
    out.push(
      <MathNode key={`math-${match.index}`} tex={part.tex} display={part.display} />,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) out.push(value.slice(cursor));
  return out.length === 1 ? out[0] : out;
}

/** Mask every string (and string array) in a component's props. */
function maskProps(
  props: AnyProps,
  parts: MathPart[],
): { props: AnyProps; masked: boolean } {
  let masked = false;

  const maskValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = maskMath(value);
      if (!result.parts.length) return value;
      masked = true;
      const offset = parts.length;
      for (const part of result.parts) parts.push(part);
      // Re-index this string's placeholders into the shared parts array.
      return result.mask.replace(PLACEHOLDER, (whole, index: string) => {
        const shifted = Number(index) + offset;
        return `${MATH_OPEN}${shifted}${MATH_CLOSE}`;
      });
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const maskedItem = maskValue(item);
        if (maskedItem !== item) changed = true;
        return maskedItem;
      });
      return changed ? next : value;
    }
    return value;
  };

  let nextProps: AnyProps | undefined;
  for (const key of Object.keys(props)) {
    const value = maskValue(props[key]);
    if (value !== props[key]) {
      nextProps ??= { ...props };
      nextProps[key] = value;
    }
  }

  return { props: nextProps ?? props, masked };
}

/**
 * Wrap a library component so any `$...$` in its text props renders as KaTeX.
 *
 * The original renderer, schema and description are kept — only the strings it
 * receives are masked, then the placeholders in its output are filled in.
 */
export function withInlineMath<T extends AnyDefinedComponent>(definition: T): T {
  const component = (context: ComponentRenderProps<AnyProps>) => {
    const parts: MathPart[] = [];
    const { props: maskedProps, masked } = maskProps(context.props ?? {}, parts);
    const tree = (
      definition.component as (context: ComponentRenderProps<AnyProps>) => React.ReactNode
    )(masked ? { ...context, props: maskedProps } : context);
    return masked ? injectMath(tree, parts) : tree;
  };

  return { ...definition, component } as T;
}

/**
 * The components that take a prose string (a paragraph, a heading, a caption, a
 * quote, list items, table cells, or a Markdown block). A sentence can carry a
 * formula in all of them; charts and SVG labels are left alone because KaTeX is
 * an HTML tree and does not belong inside `<text>`.
 */
export const MATH_TEXT_COMPONENTS = [
  "Text",
  "Title",
  "Caption",
  "Quote",
  "List",
  "ListItem",
  "Table",
  "Markdown",
] as const;
