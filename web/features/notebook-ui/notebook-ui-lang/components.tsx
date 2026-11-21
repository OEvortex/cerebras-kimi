"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { BookOpen, Layers3 } from "lucide-react";

import Mermaid from "@/components/Mermaid";
import MarkdownRenderer from "@/components/common/MarkdownRenderer";
import QuizBlock from "@/app/(workspace)/learning/books/components/blocks/QuizBlock";
import FlashCardsBlock from "@/app/(workspace)/learning/books/components/blocks/FlashCardsBlock";
import TimelineBlock from "@/app/(workspace)/learning/books/components/blocks/TimelineBlock";
import { noteConceptMap } from "@/features/notes/model/concept-map";
import { SearchImage } from "@/lib/openui/components/search-image";
import type { Block } from "@/lib/book-types";
import "./notebook-ui.css";

type RenderProps = {
  props: Record<string, any>;
  renderNode: (node: unknown) => React.ReactNode;
};

const arrayOf = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const stringOf = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

/** All prose goes through the app's one Markdown renderer, never a second one. */
function Prose({
  content,
  className,
  enableMath,
}: {
  content: string;
  className?: string;
  enableMath?: boolean;
}) {
  return (
    <MarkdownRenderer
      content={content}
      variant="compact"
      allowHtml={false}
      enableMath={enableMath}
      className={className}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The only genuinely new UI: a multi-page shell for a streamed program        */
/* -------------------------------------------------------------------------- */

type PageEntry = { key: string; id: string; title: string; parent: string; icon: string };
const NotebookPagesContext = createContext<{ register: (entry: PageEntry) => void } | null>(null);

function pageAnchor(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `nb-page-${slug || "untitled"}`;
}

function NotebookShell({ props, renderNode }: RenderProps) {
  const [pages, setPages] = useState<PageEntry[]>([]);
  const register = useCallback((entry: PageEntry) => {
    setPages((current) =>
      current.some((page) => page.key === entry.key) ? current : [...current, entry],
    );
  }, []);

  const title = stringOf(props.title).trim();
  const ordered = useMemo(() => {
    const known = new Set([
      ...pages.map((page) => page.id),
      ...pages.map((page) => page.title.toLowerCase()),
    ]);
    const roots = pages.filter(
      (page) => !page.parent || !known.has(page.parent.toLowerCase()),
    );
    const rows: { page: PageEntry; depth: number }[] = [];
    const visit = (page: PageEntry, depth: number) => {
      rows.push({ page, depth });
      pages
        .filter(
          (child) =>
            child.parent.toLowerCase() === page.id ||
            child.parent.toLowerCase() === page.title.toLowerCase(),
        )
        .forEach((child) => visit(child, depth + 1));
    };
    roots.forEach((root) => visit(root, 0));
    pages.forEach((page) => {
      if (!rows.some((row) => row.page.key === page.key)) rows.push({ page, depth: 0 });
    });
    return rows;
  }, [pages]);

  return (
    <NotebookPagesContext.Provider value={{ register }}>
      <div className="nb-root">
        <header className="nb-header">
          <div className="nb-header-icon"><BookOpen size={20} strokeWidth={1.8} /></div>
          <div>
            <div className="nb-eyebrow">Generative notebook</div>
            <h1 className="nb-title">{title || "Study notebook"}</h1>
          </div>
        </header>
        <div className="nb-layout">
          {ordered.length > 1 ? (
            <nav className="nb-nav" aria-label="Notebook pages">
              <div className="nb-nav-label"><Layers3 size={13} /> Pages</div>
              {ordered.map(({ page, depth }) => (
                <a
                  key={page.key}
                  className="nb-nav-link"
                  style={{ paddingLeft: `${10 + depth * 14}px` }}
                  href={`#${pageAnchor(page.title)}`}
                >
                  {page.icon ? <span aria-hidden>{page.icon}</span> : null}
                  <span>{page.title}</span>
                </a>
              ))}
            </nav>
          ) : null}
          <div className="nb-pages">{renderNode(props.children)}</div>
        </div>
      </div>
    </NotebookPagesContext.Provider>
  );
}

function PageBlock({ props, renderNode }: RenderProps) {
  const title = stringOf(props.title) || "Untitled page";
  // Stable across the remounts the OpenUI renderer performs on each chunk.
  const key = title.toLowerCase();
  const id = pageAnchor(title);
  const context = useContext(NotebookPagesContext);
  useEffect(() => {
    context?.register({
      key,
      id,
      title,
      parent: stringOf(props.parent).trim(),
      icon: stringOf(props.icon),
    });
  }, [context, key, id, title, props.parent, props.icon]);

  return (
    <section className="nb-page" id={id}>
      <h1 className="nb-page-title">
        {props.icon ? <span className="nb-page-icon">{stringOf(props.icon)}</span> : null}
        {title}
      </h1>
      {props.parent ? <div className="nb-page-parent">Part of {stringOf(props.parent)}</div> : null}
      <div className="nb-page-body">{renderNode(props.children)}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Content blocks — thin adapters over the app's existing renderers            */
/* -------------------------------------------------------------------------- */

function HeadingBlock({ props }: RenderProps) {
  const level = Math.min(6, Math.max(1, Math.round(Number(props.level) || 2)));
  const hashes = "#".repeat(level);
  return <Prose content={`${hashes} ${stringOf(props.text)}`} className="nb-heading" enableMath />;
}

function ParaBlock({ props }: RenderProps) {
  return <Prose content={stringOf(props.text)} className="nb-para" enableMath />;
}

function ListBlock({ props }: RenderProps) {
  const ordered = Boolean(props.ordered) || props.type === "steps";
  const lines = arrayOf(props.items).map((item, index) => {
    const text = typeof item === "object" && item !== null ? stringOf((item as any).text) : stringOf(item);
    return `${ordered ? `${index + 1}.` : "-"} ${text}`;
  });
  if (!lines.length) return null;
  return <Prose content={lines.join("\n")} className="nb-list" enableMath />;
}

function MathBlock({ props }: RenderProps) {
  const tex = stringOf(props.tex);
  if (!tex) return null;
  return (
    <div className="nb-math">
      <Prose content={`$$${tex}$$`} enableMath />
      {props.caption ? <Prose content={stringOf(props.caption)} className="nb-caption" /> : null}
    </div>
  );
}

function CalloutBlock({ props }: RenderProps) {
  const tone = stringOf(props.tone, "info");
  const kind = ["info", "tip", "warning", "example"].includes(tone) ? tone : "info";
  return (
    <aside className={`nb-callout nb-callout-${kind}`}>
      {props.title ? <Prose content={`**${stringOf(props.title)}**`} /> : null}
      <Prose content={stringOf(props.text)} enableMath />
    </aside>
  );
}

function QuoteBlock({ props }: RenderProps) {
  const lines = stringOf(props.text).split("\n").map((line) => `> ${line}`).join("\n");
  return (
    <div className="nb-quote">
      <Prose content={lines} enableMath />
      {props.cite ? <Prose content={`— ${stringOf(props.cite)}`} className="nb-caption" /> : null}
    </div>
  );
}

function CodeBlock({ props }: RenderProps) {
  const language = stringOf(props.language);
  const code = stringOf(props.code);
  return <Prose content={`\`\`\`${language}\n${code}\n\`\`\``} />;
}

function TableBlock({ props }: RenderProps) {
  const columns = arrayOf(props.columns).map((column) => stringOf(column));
  const rows = arrayOf<any>(props.rows);
  if (!columns.length) return null;
  const cell = (value: unknown) => stringOf(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `| ${columns.map(cell).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((_, i) => cell(arrayOf(row)[i])).join(" | ")} |`),
  ];
  return (
    <div className="nb-table-wrap">
      <Prose content={lines.join("\n")} />
      {props.caption ? <Prose content={stringOf(props.caption)} className="nb-caption" /> : null}
    </div>
  );
}

function DividerBlock() {
  return <hr className="nb-divider" />;
}

function FigureBlock({ props }: RenderProps) {
  const query = stringOf(props.query).trim();
  const Photo = SearchImage.component as React.FC<any>;
  return (
    <figure className="nb-figure">
      {query ? <Photo props={{ query }} renderNode={(node: unknown) => node} /> : null}
      {props.caption ? <Prose content={stringOf(props.caption)} className="nb-caption" /> : null}
    </figure>
  );
}

function DiagramBlock({ props }: RenderProps) {
  const chart = stringOf(props.source).trim();
  if (!chart) return null;
  return (
    <div className="nb-diagram">
      <Mermaid chart={chart} />
      {props.caption ? <Prose content={stringOf(props.caption)} className="nb-caption" /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Learning blocks — reuse the exact components the notes editor uses          */
/* -------------------------------------------------------------------------- */

/** Minimal `Block` shape the book block components read. */
function previewBlock(id: string, payload: Record<string, unknown>): Block {
  return { id, status: "ready", payload } as Block;
}

const QUESTION_TYPES: Record<string, string> = {
  choice: "choice",
  multiple: "choice",
  truefalse: "true_false",
  true_false: "true_false",
  fill: "fill_in_blank",
  fill_in_blank: "fill_in_blank",
  short: "short_answer",
  short_answer: "short_answer",
  written: "written",
  coding: "coding",
  concept: "concept",
};

function optionsObject(options: unknown): Record<string, string> | undefined {
  if (Array.isArray(options)) {
    const out: Record<string, string> = {};
    options.forEach((option, index) => {
      out[String.fromCharCode(65 + index)] = stringOf(option);
    });
    return out;
  }
  if (options && typeof options === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(options)) out[key] = stringOf(value);
    return out;
  }
  return undefined;
}

function BlockTitle({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  return <Prose content={`### ${text}`} className="nb-block-title" />;
}

function QuizAdapter({ props }: RenderProps) {
  const id = useId();
  const streaming = useIsStreaming();
  const questions = arrayOf<any>(props.questions)
    .filter((question) => question && stringOf(question.question).trim())
    .map((question) => {
      const options = optionsObject(question.options);
      return {
        question: stringOf(question.question),
        question_type: QUESTION_TYPES[stringOf(question.type, "choice")] || "short_answer",
        ...(options ? { options } : {}),
        correct_answer: stringOf(question.answer),
        explanation: stringOf(question.explanation),
      };
    });
  if (!questions.length) {
    return streaming ? <div className="nb-loading">Building quiz…</div> : null;
  }
  return (
    <div className="nb-learning">
      <BlockTitle text={stringOf(props.title)} />
      <QuizBlock block={previewBlock(id, { questions })} />
    </div>
  );
}

function FlashcardsAdapter({ props }: RenderProps) {
  const id = useId();
  const streaming = useIsStreaming();
  const cards = arrayOf<any>(props.cards)
    .filter((card) => card && stringOf(card.front).trim())
    .map((card) => ({ front: stringOf(card.front), back: stringOf(card.back) }));
  if (!cards.length) {
    return streaming ? <div className="nb-loading">Building flashcards…</div> : null;
  }
  return (
    <div className="nb-learning">
      <BlockTitle text={stringOf(props.title)} />
      <FlashCardsBlock block={previewBlock(id, { cards })} />
    </div>
  );
}

function TimelineAdapter({ props }: RenderProps) {
  const id = useId();
  const events = arrayOf<any>(props.events)
    .filter((event) => event && stringOf(event.label || event.title).trim())
    .map((event) => ({
      date: stringOf(event.date),
      title: stringOf(event.label || event.title),
      description: stringOf(event.description),
    }));
  if (!events.length) return null;
  return (
    <div className="nb-learning">
      <BlockTitle text={stringOf(props.title)} />
      <TimelineBlock block={previewBlock(id, { events })} />
    </div>
  );
}

function ConceptMapAdapter({ props }: RenderProps) {
  const markdown = noteConceptMap({
    nodes: arrayOf(props.nodes),
    edges: arrayOf(props.edges),
  });
  if (!markdown) return null;
  return (
    <div className="nb-learning">
      <BlockTitle text={stringOf(props.title)} />
      <Prose content={markdown} enableMath />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Component definitions                                                       */
/* -------------------------------------------------------------------------- */

const nodeArray = z.array(z.any());
const stringList = z.array(z.union([z.string(), z.any()]));
const optionalTitle = z.string().optional();

export const Notebook = defineComponent({
  name: "Notebook",
  props: z.object({ children: nodeArray, title: z.string().optional() }),
  description: "The root of a notebook program: an ordered set of Pages.",
  component: NotebookShell,
});

export const Page = defineComponent({
  name: "Page",
  props: z.object({
    children: nodeArray,
    title: z.string(),
    parent: z.string().optional(),
    icon: z.string().optional(),
  }),
  description: "One notebook page. parent names another page's title to nest this one.",
  component: PageBlock,
});

export const Heading = defineComponent({
  name: "Heading",
  props: z.object({ text: z.string(), level: z.number().optional() }),
  description: "A section heading, level 1 to 6 (default 2).",
  component: HeadingBlock,
});

export const Para = defineComponent({
  name: "Para",
  props: z.object({ text: z.string() }),
  description: "A paragraph with Markdown and $inline$ LaTeX.",
  component: ParaBlock,
});

export const Bullets = defineComponent({
  name: "Bullets",
  props: z.object({ items: stringList, ordered: z.boolean().optional() }),
  description: "A bullet list; ordered: true makes it numbered.",
  component: ListBlock,
});

export const Steps = defineComponent({
  name: "Steps",
  props: z.object({ items: stringList }),
  description: "A numbered list of steps.",
  component: ListBlock,
});

export const Math = defineComponent({
  name: "Math",
  props: z.object({ tex: z.string(), caption: z.string().optional() }),
  description: "A display LaTeX formula (raw LaTeX, no $ delimiters).",
  component: MathBlock,
});

export const Note = defineComponent({
  name: "Note",
  props: z.object({
    text: z.string(),
    tone: z.enum(["info", "tip", "warning", "example"]).optional(),
    title: optionalTitle,
  }),
  description: "A callout box: info, tip, warning or example.",
  component: CalloutBlock,
});

export const Quote = defineComponent({
  name: "Quote",
  props: z.object({ text: z.string(), cite: z.string().optional() }),
  description: "A quotation with an optional source.",
  component: QuoteBlock,
});

export const Code = defineComponent({
  name: "Code",
  props: z.object({ code: z.string(), language: z.string().optional() }),
  description: "A code block.",
  component: CodeBlock,
});

export const Table = defineComponent({
  name: "Table",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.any())),
    caption: z.string().optional(),
  }),
  description: "A table with one cell per column in each row.",
  component: TableBlock,
});

export const Divider = defineComponent({
  name: "Divider",
  props: z.object({}),
  description: "A horizontal rule between sections.",
  component: DividerBlock,
});

export const Figure = defineComponent({
  name: "Figure",
  props: z.object({ query: z.string(), caption: z.string().optional() }),
  description: "A real photo the app finds for a 2–4 word subject query.",
  component: FigureBlock,
});

export const Diagram = defineComponent({
  name: "Diagram",
  props: z.object({ source: z.string(), caption: z.string().optional() }),
  description: "A Mermaid diagram; source starts with flowchart, sequenceDiagram, mindmap, etc.",
  component: DiagramBlock,
});

export const Quiz = defineComponent({
  name: "Quiz",
  props: z.object({ questions: z.array(z.any()), title: optionalTitle }),
  description: "An interactive quiz: questions with question, type, options, answer and explanation.",
  component: QuizAdapter,
});

export const Flashcards = defineComponent({
  name: "Flashcards",
  props: z.object({ cards: z.array(z.any()), title: optionalTitle }),
  description: "A flip-card deck: cards have front and back.",
  component: FlashcardsAdapter,
});

export const Timeline = defineComponent({
  name: "Timeline",
  props: z.object({ events: z.array(z.any()), title: optionalTitle }),
  description: "A chronological timeline of date/label/description events.",
  component: TimelineAdapter,
});

export const ConceptMap = defineComponent({
  name: "ConceptMap",
  props: z.object({
    nodes: z.array(z.any()),
    edges: z.array(z.any()),
    title: optionalTitle,
  }),
  description: "A concept map: nodes (id, label, description) and edges (from, to, label).",
  component: ConceptMapAdapter,
});

export const notebookComponents = [
  Notebook,
  Page,
  Heading,
  Para,
  Bullets,
  Steps,
  Math,
  Note,
  Quote,
  Code,
  Table,
  Divider,
  Figure,
  Diagram,
  Quiz,
  Flashcards,
  Timeline,
  ConceptMap,
];
