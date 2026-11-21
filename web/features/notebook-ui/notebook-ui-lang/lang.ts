"use client";

import {
  createParser,
  evaluateRoot,
  isElementNode,
  type ElementNode,
} from "@openuidev/lang-core";

import { extractOpenUILang, toOpenUIProgram } from "@/lib/openui/lang";
import { notebookLibrary } from "./library";
import { notebookRuntimeFunctions } from "./functions";

/* -------------------------------------------------------------------------- */
/* Detecting and normalising a streamed notebook program                       */
/* -------------------------------------------------------------------------- */

const NOTEBOOK_ROOT = /\broot\s*=\s*Notebook\s*\(/;

export type NotebookExtraction = {
  program: string;
  preamble: string;
  trailing: string;
  found: boolean;
};

/** Pull a `root = Notebook(...)` program out of a model reply. */
export function extractNotebookUI(content: string | null | undefined): NotebookExtraction {
  const source = String(content ?? "");
  if (!NOTEBOOK_ROOT.test(source)) {
    return { program: "", preamble: "", trailing: "", found: false };
  }
  const base = extractOpenUILang(source);
  if (!base.found) return { program: "", preamble: "", trailing: "", found: false };
  return base;
}

export function hasNotebookUI(content: string | null | undefined): boolean {
  return extractNotebookUI(content).found;
}

/**
 * The string handed to the renderer. Mid-stream a program is often just
 * `root = Notebook([...` with no closing bracket — pass the raw text through
 * so the renderer can show the shell that has already arrived.
 */
export function toNotebookUIProgram(content: string | null | undefined): string {
  const source = String(content ?? "");
  const extraction = extractNotebookUI(source);
  if (extraction.found) return extraction.program;
  if (NOTEBOOK_ROOT.test(source)) return source;
  return toOpenUIProgram(source);
}

/* -------------------------------------------------------------------------- */
/* Compiling a finished program into real notebook pages                       */
/* -------------------------------------------------------------------------- */

export type NoteBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children?: NoteBlock[];
};

export type NotebookPagePlan = {
  title: string;
  parentTitle: string;
  blocks: NoteBlock[];
};

export type NotebookPlan = {
  title: string;
  pages: NotebookPagePlan[];
};

const schema = notebookLibrary.toJSONSchema() as any;
const parser = createParser(schema, "Notebook");
const runtimeFunctions = notebookRuntimeFunctions();

function evaluationContext() {
  const functions: Record<string, any> = {};
  for (const [name, definition] of Object.entries<any>(schema.functions ?? {})) {
    functions[name] = { ...definition, fn: runtimeFunctions[name] ?? (() => null) };
  }
  return {
    ctx: {
      getState: () => null,
      resolveRef: () => null,
      functions,
      actions: schema.actions ?? {},
    },
    library: notebookLibrary as any,
    store: null,
    errors: [] as any[],
  };
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function inlineContent(value: unknown): unknown[] {
  return [{ type: "text", text: textValue(value), styles: {} }];
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `nb-${idCounter.toString(36).padStart(4, "0")}`;
}

function learningBlock(kind: string, data: Record<string, unknown>, markdown = ""): NoteBlock {
  return {
    id: nextId(),
    type: "learning",
    props: {
      kind,
      prompt: "",
      markdown,
      data: JSON.stringify(data),
      sourceUrl: "",
    },
    children: [],
  };
}

const QUESTION_TYPES: Record<string, string> = {
  choice: "choice",
  truefalse: "choice",
  multiple: "choice",
  fill: "fill_in_blank",
  fill_in_blank: "fill_in_blank",
  short: "short_answer",
  short_answer: "short_answer",
  written: "written",
  coding: "coding",
  concept: "short_answer",
};

function quizData(questions: any[]): Record<string, unknown> {
  const normalised = questions
    .filter((question) => question && textValue(question.question).trim())
    .map((question) => {
      const rawOptions = question.options;
      let options: Record<string, string> | undefined;
      let correct = textValue(question.answer);
      if (Array.isArray(rawOptions) && rawOptions.length) {
        options = {};
        rawOptions.forEach((option, index) => {
          const letter = String.fromCharCode(65 + index);
          options![letter] = textValue(option);
          if (correct === options![letter]) correct = letter;
        });
      } else if (rawOptions && typeof rawOptions === "object") {
        options = {};
        for (const [key, value] of Object.entries(rawOptions)) options[key] = textValue(value);
      }
      return {
        question: textValue(question.question),
        question_type: QUESTION_TYPES[textValue(question.type, "choice")] || "choice",
        ...(options ? { options } : {}),
        correct_answer: correct,
        explanation: textValue(question.explanation),
      };
    });
  return { questions: normalised };
}

/** One component node -> zero or more BlockNote blocks. */
function blocksFor(node: ElementNode): NoteBlock[] {
  switch (node.typeName) {
    case "Heading": {
      const level = Math.min(6, Math.max(1, Number(node.props.level) || 2));
      return [{ id: nextId(), type: "heading", props: { level }, content: inlineContent(node.props.text) }];
    }
    case "Para":
      return [{ id: nextId(), type: "paragraph", props: {}, content: inlineContent(node.props.text) }];
    case "Bullets":
    case "Steps":
      return arrayValue(node.props.items).map((item) => ({
        id: nextId(),
        type: node.typeName === "Steps" || node.props.ordered ? "numberedListItem" : "bulletListItem",
        props: {},
        content: inlineContent(typeof item === "object" ? item?.text : item),
      }));
    case "Math":
      return [{ id: nextId(), type: "math", props: { formula: textValue(node.props.tex) }, children: [] }];
    case "Note":
      return [{
        id: nextId(),
        type: "callout",
        props: { tone: ["info", "tip", "warning", "example"].includes(textValue(node.props.tone)) ? textValue(node.props.tone) : "info" },
        content: inlineContent(node.props.text),
      }];
    case "Quote":
      return [{ id: nextId(), type: "quote", props: {}, content: inlineContent(node.props.text) }];
    case "Code":
      return [{
        id: nextId(),
        type: "codeBlock",
        props: { language: textValue(node.props.language) },
        content: inlineContent(node.props.code),
      }];
    case "Table": {
      const rows = arrayValue(node.props.rows).map((row) => ({
        cells: arrayValue(row).map((cell) => ({ content: inlineContent(cell) })),
      }));
      return [{ id: nextId(), type: "table", props: {}, content: { rows }, children: [] }];
    }
    case "Divider":
      return [{ id: nextId(), type: "divider", props: {}, children: [] }];
    case "Figure": {
      const url = textValue(node.props.url);
      if (!url) return [];
      return [{ id: nextId(), type: "image", props: { url, caption: textValue(node.props.caption) }, children: [] }];
    }
    case "Diagram": {
      const source = textValue(node.props.source).trim();
      if (!source) return [];
      return [learningBlock("mermaid", {}, `\`\`\`mermaid\n${source}\n\`\`\``)];
    }
    case "Quiz": {
      const data = quizData(arrayValue(node.props.questions));
      if (!arrayValue(data.questions).length) return [];
      return [learningBlock("quiz", data, textValue(node.props.title))];
    }
    case "Flashcards": {
      const cards = arrayValue(node.props.cards)
        .filter((card) => card && textValue(card.front).trim())
        .map((card) => ({ front: textValue(card.front), back: textValue(card.back) }));
      if (!cards.length) return [];
      return [learningBlock("flashcards", { cards }, textValue(node.props.title))];
    }
    case "Timeline": {
      const events = arrayValue(node.props.events)
        .filter((event) => event && textValue(event.label).trim())
        .map((event) => ({ date: textValue(event.date), label: textValue(event.label), description: textValue(event.description) }));
      if (!events.length) return [];
      return [learningBlock("timeline", { events }, textValue(node.props.title))];
    }
    case "ConceptMap": {
      const nodes = arrayValue(node.props.nodes).filter((node: any) => node && textValue(node.id).trim());
      const edges = arrayValue(node.props.edges).filter((edge: any) => edge && textValue(edge.from).trim());
      if (!nodes.length) return [];
      return [learningBlock("concept_map", { nodes, edges }, textValue(node.props.title))];
    }
    default:
      // A page, Notebook root or an inline component: descend into its children.
      return arrayValue(node.props.children).flatMap((child) =>
        isElementNode(child) ? blocksFor(child) : [],
      );
  }
}

/**
 * Compile a complete notebook-ui-lang program into page plans that can be
 * created through `/api/documents`. Returns null when the program has no
 * usable page.
 */
export function compileNotebookProgram(program: string): NotebookPlan | null {
  const result = parser.parse(program);
  const root = evaluateRoot(result, evaluationContext());
  if (!root || root.typeName !== "Notebook") return null;

  idCounter = 0;
  const pages: NotebookPagePlan[] = [];
  for (const child of arrayValue(root.props.children)) {
    if (!isElementNode(child) || child.typeName !== "Page") continue;
    const title = textValue(child.props.title).trim();
    const blocks = arrayValue(child.props.children).flatMap((block) =>
      isElementNode(block) ? blocksFor(block) : [],
    );
    if (!title || !blocks.length) continue;
    pages.push({
      title,
      parentTitle: textValue(child.props.parent).trim(),
      blocks,
    });
  }
  if (!pages.length) return null;
  return { title: textValue(root.props.title).trim(), pages };
}
