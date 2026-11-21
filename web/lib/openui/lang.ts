/**
 * Locating the OpenUI Lang program inside a model reply.
 *
 * The tutor prompt asks for a bare program ("Your ENTIRE response must be
 * valid openui-lang code"), and most replies are one. Models still prefix a
 * sentence of prose now and then — "I'll lay out the derivation …root = Col(…)
 * — and that single line is enough to fail the parser outright, which is what
 * left those turns as raw source (or blank) in the transcript. These helpers
 * find the program inside a mixed reply, so the chat can render it instead of
 * falling back to another renderer.
 */

/** A statement line: `root = …`, `name = …`, `$state = …`. */
const STATEMENT = /^\s*(?:\$?[A-Za-z_][\w$]*)\s*=/;
/** `root = Component(` — a program must define root this way. */
const ROOT = /\broot\s*=\s*[A-Za-z_$][\w$]*\s*\(/;
/**
 * A fenced block wrapping the program. The prompt asks for a bare program, but
 * models routinely wrap it in ``` — sometimes with an `openui-lang` tag, often
 * with no tag at all. Any fence is accepted here and its body is then verified
 * as a program below, so a plain fence is not mistaken for prose: left in the
 * preamble it rendered as an empty code block, a stray strip above the answer.
 */
const OPENUI_FENCE = /```[ \t]*(?:[\w+-]+)?[ \t]*\r?\n([\s\S]*?)```/i;

export type OpenUILangExtraction = {
  /** The program text, or "" when the reply contains none. */
  program: string;
  /** Prose that preceded the program (trimmed), or "". */
  preamble: string;
  /** Prose that followed the program (trimmed), or "". */
  trailing: string;
  /** Whether a program was found. */
  found: boolean;
};

const EMPTY: OpenUILangExtraction = {
  program: "",
  preamble: "",
  trailing: "",
  found: false,
};

/**
 * Put each statement on its own line.
 *
 * A model sometimes writes the whole program on one line —
 * `root = Col([a, b]) a = Title(…, "xl") b = Text(…)` — which the parser reads
 * as one statement and renders as nothing. Splitting at top-level `name =`
 * boundaries restores the shape the parser expects. String literals and
 * brackets are tracked so a `=` inside a string or a call argument is not a
 * boundary.
 */
export function splitProgramStatements(source: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);

    if (depth === 0 && /\s/.test(char)) {
      const previous = out.trimEnd().slice(-1);
      const boundary = /[)\]]|["'`]/.test(previous);
      if (boundary) {
        const space = /^\s+/.exec(source.slice(i));
        if (
          space &&
          /^(?:\$?[A-Za-z_][\w$]*)\s*=(?!=)/.test(source.slice(i + space[0].length))
        ) {
          out += "\n";
          i += space[0].length - 1;
          continue;
        }
      }
    }

    out += char;
  }

  return out;
}

function buildExtraction(
  source: string,
): OpenUILangExtraction {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  // A line belongs to the program while it is a statement, a blank line, or an
  // indented continuation. Flush-left prose is dropped rather than ending the
  // program — a model sometimes narrates between two statements.
  const programLines: string[] = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (STATEMENT.test(line)) {
      last = i;
      programLines.push(line);
      continue;
    }
    if (!line.trim()) {
      programLines.push("");
      continue;
    }
    if (/^\s+\S/.test(line) || /^\s*[\]\)}]/.test(line)) {
      programLines.push(line);
    }
  }

  if (last === -1) return EMPTY;

  const trailingStart = lines.slice(last + 1).findIndex((line) => line.trim());
  const trailing =
    trailingStart === -1 ? "" : lines.slice(last + 1 + trailingStart).join("\n").trim();
  const program = splitProgramStatements(programLines.join("\n").trim());
  if (!program) return EMPTY;

  return {
    program,
    preamble: "",
    trailing,
    found: true,
  };
}

/**
 * Split a reply into prose and the OpenUI Lang program it carries.
 *
 * Accepts a fenced ```openui-lang block, a program that starts on its own line,
 * and a program that begins mid-sentence after a prose prefix.
 */
export function extractOpenUILang(
  content: string | null | undefined,
): OpenUILangExtraction {
  if (!content) return EMPTY;
  const source = String(content);

  const fence = OPENUI_FENCE.exec(source);
  if (fence) {
    const inner = buildExtraction(fence[1]);
    if (inner.found) {
      return {
        ...inner,
        preamble: source.slice(0, fence.index).trim(),
        trailing: source.slice(fence.index + fence[0].length).trim(),
      };
    }
  }

  const root = ROOT.exec(source);
  if (!root) return EMPTY;

  const start = root.index;
  const preamble = source.slice(0, start).trim();
  const rest = buildExtraction(source.slice(start));
  if (!rest.found) return EMPTY;

  return { ...rest, preamble };
}

/** True when a model reply carries an OpenUI Lang program, with or without prose. */
export function hasOpenUILang(content: string | null | undefined): boolean {
  if (!content) return false;
  if (content.includes("```openui-lang")) return true;
  return extractOpenUILang(content).found;
}

/**
 * True for a reply with no program at all — not even a partial statement that
 * is still streaming in. Such replies are ordinary Markdown and should use the
 * app's prose renderer rather than OpenUI's minimal `Markdown` node.
 */
export function isPlainProse(content: string | null | undefined): boolean {
  const source = String(content ?? "");
  if (!source.trim()) return true;
  if (hasOpenUILang(source)) return false;
  return !source.split("\n").some((line) => STATEMENT.test(line));
}

/**
 * The program to hand the renderer for a reply.
 *
 * A reply with no program is plain prose, and still renders through OpenUI — as
 * a `Markdown` node — so the chat has one renderer for every answer (and the
 * inline-maths handling that comes with it).
 */
export function toOpenUIProgram(content: string | null | undefined): string {
  const source = String(content ?? "");
  const extraction = extractOpenUILang(source);
  if (extraction.found) return extraction.program;
  // Mid-stream a program can start with a state or component assignment before
  // its `root` line arrives. Hand the partial source to the renderer rather
  // than showing it as Markdown for a frame.
  if (source.split("\n").some((line) => STATEMENT.test(line))) return source;
  return `root = Markdown(${JSON.stringify(source)})`;
}
