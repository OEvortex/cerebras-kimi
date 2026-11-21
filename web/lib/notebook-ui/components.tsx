"use client";

import "katex/dist/katex.min.css";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { BookOpen, ChevronLeft, ChevronRight, Layers3, Shuffle } from "lucide-react";

import Mermaid from "@/components/Mermaid";
import { SearchImage } from "@/lib/openui/components/search-image";
import { MathNode } from "@/lib/openui/components/math";
import { arrayOf, renderRichText, stringOf } from "./rich";
import "./notebook-ui.css";

type RenderProps = { props: Record<string, any>; renderNode: (node: unknown) => React.ReactNode };

/* -------------------------------------------------------------------------- */
/* Multi-page shell                                                            */
/* -------------------------------------------------------------------------- */

type PageEntry = { key: string; id: string; title: string; parent: string; icon: string };
const NotebookPagesContext = createContext<{
  register: (entry: PageEntry) => void;
} | null>(null);

function pageAnchor(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `nb-page-${slug || "untitled"}`;
}

function NotebookShell({ props, renderNode }: RenderProps) {
  const [pages, setPages] = useState<PageEntry[]>([]);
  const register = React.useCallback((entry: PageEntry) => {
    setPages((current) => {
      if (current.some((page) => page.key === entry.key)) return current;
      return [...current, entry];
    });
  }, []);
  const title = stringOf(props.title).trim();
  const ordered = useMemo(() => {
    const byIdOrTitle = new Set([
      ...pages.map((page) => page.id),
      ...pages.map((page) => page.title.toLowerCase()),
    ]);
    const roots = pages.filter((page) => !page.parent || !byIdOrTitle.has(page.parent.toLowerCase()));
    const rows: { page: PageEntry; depth: number }[] = [];
    const visit = (page: PageEntry, depth: number) => {
      rows.push({ page, depth });
      pages
        .filter((child) => child.parent.toLowerCase() === page.id || child.parent.toLowerCase() === page.title.toLowerCase())
        .forEach((child) => visit(child, depth + 1));
    };
    roots.forEach((root) => visit(root, 0));
    pages.forEach((page) => {
      if (!rows.some((row) => row.page.id === page.id)) rows.push({ page, depth: 0 });
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
  // A stable key matters: the OpenUI renderer remounts components whenever a
  // streamed chunk changes the parse tree, so an id derived from render state
  // would register the same page again on every chunk and duplicate the nav.
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
    <section className="nb-page" id={pageAnchor(title)} data-page-id={id}>
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
/* Content blocks                                                              */
/* -------------------------------------------------------------------------- */

function HeadingBlock({ props }: RenderProps) {
  const level = globalThis.Math.min(6, globalThis.Math.max(1, globalThis.Math.round(Number(props.level) || 2)));
  const content = renderRichText(props.text);
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return <Tag className={`nb-heading nb-heading-${level}`}>{content}</Tag>;
}

function ParaBlock({ props }: RenderProps) {
  return <p className="nb-para">{renderRichText(props.text)}</p>;
}

function ListBlock({ props }: RenderProps) {
  const items = arrayOf(props.items);
  const ordered = Boolean(props.ordered) || stringOf(props.type) === "steps";
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={`nb-list ${ordered ? "nb-steps" : ""}`}>
      {items.map((item, index) => (
        <li key={index}>{renderRichText(typeof item === "object" ? (item as any)?.text : item)}</li>
      ))}
    </Tag>
  );
}

function MathBlock({ props }: RenderProps) {
  const tex = stringOf(props.tex);
  if (!tex) return null;
  return (
    <figure className="nb-math">
      <MathNode tex={tex} display />
      {props.caption ? <figcaption>{renderRichText(props.caption)}</figcaption> : null}
    </figure>
  );
}

function CalloutBlock({ props }: RenderProps) {
  const tone = stringOf(props.tone, "info");
  const kind = ["info", "tip", "warning", "example"].includes(tone) ? tone : "info";
  return (
    <aside className={`nb-callout nb-callout-${kind}`}>
      {props.title ? <div className="nb-callout-title">{renderRichText(props.title)}</div> : null}
      <div>{renderRichText(props.text)}</div>
    </aside>
  );
}

function QuoteBlock({ props }: RenderProps) {
  return (
    <blockquote className="nb-quote">
      {renderRichText(props.text)}
      {props.cite ? <cite>— {renderRichText(props.cite)}</cite> : null}
    </blockquote>
  );
}

function CodeBlock({ props }: RenderProps) {
  return (
    <pre className="nb-code" data-language={stringOf(props.language) || undefined}>
      <code>{stringOf(props.code)}</code>
    </pre>
  );
}

function TableBlock({ props }: RenderProps) {
  const columns = arrayOf(props.columns).map((column) => stringOf(column));
  const rows = arrayOf<any>(props.rows);
  return (
    <figure className="nb-table-wrap">
      <table className="nb-table">
        {columns.length ? (
          <thead>
            <tr>{columns.map((column, i) => <th key={i}>{renderRichText(column)}</th>)}</tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {arrayOf(row).map((cell, cellIndex) => (
                <td key={cellIndex}>{renderRichText(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {props.caption ? <figcaption>{renderRichText(props.caption)}</figcaption> : null}
    </figure>
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
      {props.caption ? <figcaption>{renderRichText(props.caption)}</figcaption> : null}
    </figure>
  );
}

function DiagramBlock({ props }: RenderProps) {
  const chart = stringOf(props.source).trim();
  if (!chart) return null;
  return (
    <figure className="nb-diagram">
      <Mermaid chart={chart} />
      {props.caption ? <figcaption>{renderRichText(props.caption)}</figcaption> : null}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Learning blocks — authored directly in the program, no tools required      */
/* -------------------------------------------------------------------------- */

type Question = {
  question?: string;
  type?: string;
  options?: unknown;
  answer?: string;
  explanation?: string;
};

function choicesFor(question: Question): string[] {
  if (question.type === "truefalse") return ["true", "false"];
  const options = question.options;
  if (Array.isArray(options)) return options.map((option) => stringOf(option));
  if (options && typeof options === "object") return Object.values(options).map((v) => stringOf(v));
  return [];
}

function QuizBlock({ props }: RenderProps) {
  const questions = arrayOf<Question>(props.questions).filter(
    (question) => question && stringOf(question.question).trim() && stringOf(question.answer).trim(),
  );
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState(false);
  const streaming = useIsStreaming();

  if (!questions.length) {
    return streaming ? <div className="nb-loading">Building quiz…</div> : null;
  }

  const score = questions.filter((question, index) => {
    const given = (answers[index] || "").trim().toLowerCase();
    return given === stringOf(question.answer).trim().toLowerCase();
  }).length;

  return (
    <section className="nb-learning nb-quiz">
      {props.title ? <h3 className="nb-learning-title">{renderRichText(props.title)}</h3> : null}
      <ol className="nb-questions">
        {questions.map((question, index) => {
          const choices = choicesFor(question);
          const freeText = !choices.length || question.type === "fill" || question.type === "short";
          const correct = stringOf(question.answer).trim();
          const given = answers[index] || "";
          const isRight = given.trim().toLowerCase() === correct.toLowerCase();
          return (
            <li className="nb-question" key={index}>
              <div className="nb-question-prompt">
                <span className="nb-question-index">{index + 1}.</span>
                {renderRichText(question.question)}
              </div>
              {freeText ? (
                <input
                  className="nb-answer-input"
                  value={given}
                  disabled={streaming || checked}
                  placeholder={question.type === "fill" ? "Fill the blank" : "Your answer"}
                  onChange={(event) => setAnswers((current) => ({ ...current, [index]: event.target.value }))}
                />
              ) : (
                <div className="nb-choices">
                  {choices.map((choice, choiceIndex) => (
                    <button
                      type="button"
                      key={choiceIndex}
                      disabled={streaming || checked}
                      className={[
                        "nb-choice",
                        given === choice ? "is-selected" : "",
                        checked && choice === correct ? "is-correct" : "",
                        checked && given === choice && choice !== correct ? "is-wrong" : "",
                      ].filter(Boolean).join(" ")}
                      onClick={() => setAnswers((current) => ({ ...current, [index]: choice }))}
                    >
                      <span className="nb-choice-letter">{String.fromCharCode(65 + choiceIndex)}</span>
                      {renderRichText(choice)}
                    </button>
                  ))}
                </div>
              )}
              {checked ? (
                <div className={`nb-feedback ${isRight ? "is-right" : "is-wrong"}`}>
                  {isRight ? "Correct." : `Answer: ${correct}`}
                  {question.explanation ? <span> {renderRichText(question.explanation)}</span> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="nb-learning-actions">
        {!checked ? (
          <button type="button" className="nb-action" disabled={streaming} onClick={() => setChecked(true)}>
            Check answers
          </button>
        ) : (
          <button
            type="button"
            className="nb-action nb-action-quiet"
            onClick={() => { setChecked(false); setAnswers({}); }}
          >
            Try again
          </button>
        )}
        {checked ? <span className="nb-score">{score} / {questions.length} correct</span> : null}
      </div>
    </section>
  );
}

type Card = { front?: string; back?: string };

function FlashcardsBlock({ props }: RenderProps) {
  const cards = arrayOf<Card>(props.cards).filter(
    (card) => card && stringOf(card.front).trim(),
  );
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [shuffled, setShuffled] = useState<Card[] | null>(null);
  const streaming = useIsStreaming();
  const deck = shuffled ?? cards;
  const current = deck[globalThis.Math.min(index, globalThis.Math.max(0, deck.length - 1))];

  if (!deck.length) {
    return streaming ? <div className="nb-loading">Building flashcards…</div> : null;
  }

  const move = (delta: number) => {
    setFlipped(false);
    setIndex((value) => (value + delta + deck.length) % deck.length);
  };

  return (
    <section className="nb-learning nb-flashcards">
      {props.title ? <h3 className="nb-learning-title">{renderRichText(props.title)}</h3> : null}
      <button
        type="button"
        className="nb-flipcard"
        onClick={() => setFlipped((value) => !value)}
        aria-label={flipped ? "Show the front of the card" : "Show the back of the card"}
      >
        <span className="nb-flipcard-label">{flipped ? "Answer" : "Term"}</span>
        <span className="nb-flipcard-face">{renderRichText(flipped ? current?.back || "—" : current?.front)}</span>
        <span className="nb-flipcard-hint">{flipped ? "Tap to see the term" : "Tap to reveal the answer"}</span>
      </button>
      <div className="nb-learning-actions">
        <button type="button" className="nb-action nb-action-quiet" disabled={streaming} onClick={() => move(-1)}>
          <ChevronLeft size={15} /> Previous
        </button>
        <span className="nb-score">{globalThis.Math.min(index + 1, deck.length)} / {deck.length}</span>
        <button type="button" className="nb-action nb-action-quiet" disabled={streaming} onClick={() => move(1)}>
          Next <ChevronRight size={15} />
        </button>
        <button
          type="button"
          className="nb-action nb-action-quiet"
          disabled={streaming}
          onClick={() => {
            const copy = [...cards];
            for (let i = copy.length - 1; i > 0; i--) {
              const j = globalThis.Math.floor(globalThis.Math.random() * (i + 1));
              [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            setShuffled(copy);
            setIndex(0);
            setFlipped(false);
          }}
        >
          <Shuffle size={14} /> Shuffle
        </button>
      </div>
    </section>
  );
}

function TimelineBlock({ props }: RenderProps) {
  const events = arrayOf<any>(props.events).filter((event) => event && stringOf(event.label).trim());
  if (!events.length) return null;
  return (
    <section className="nb-learning">
      {props.title ? <h3 className="nb-learning-title">{renderRichText(props.title)}</h3> : null}
      <ol className="nb-timeline">
        {events.map((event, index) => (
          <li key={index}>
            {event.date ? <span className="nb-timeline-date">{renderRichText(event.date)}</span> : null}
            <strong>{renderRichText(event.label)}</strong>
            {event.description ? <span>{renderRichText(event.description)}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ConceptMapBlock({ props }: RenderProps) {
  const nodes = arrayOf<any>(props.nodes).filter((node) => node && stringOf(node.id).trim());
  const edges = arrayOf<any>(props.edges).filter(
    (edge) => edge && stringOf(edge.from).trim() && stringOf(edge.to).trim(),
  );
  if (!nodes.length) return null;
  return (
    <section className="nb-learning">
      {props.title ? <h3 className="nb-learning-title">{renderRichText(props.title)}</h3> : null}
      <div className="nb-concept-nodes">
        {nodes.map((node, index) => (
          <div className="nb-concept-node" key={index}>
            <strong>{renderRichText(node.label || node.id)}</strong>
            {node.description ? <span>{renderRichText(node.description)}</span> : null}
          </div>
        ))}
      </div>
      {edges.length ? (
        <ul className="nb-concept-edges">
          {edges.map((edge, index) => (
            <li key={index}>
              {renderRichText(edge.from)} <span aria-hidden>→</span> {renderRichText(edge.to)}
              {edge.label ? <em> ({renderRichText(edge.label)})</em> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Component definitions                                                       */
/* -------------------------------------------------------------------------- */

const nodeArray = z.array(z.any());
const stringList = z.array(z.union([z.string(), z.any()]));

export const Notebook = defineComponent({
  name: "Notebook",
  props: z.object({
    children: nodeArray,
    title: z.string().optional(),
  }),
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
  description: "A paragraph. Supports **bold**, *italic*, `code`, links and $inline$ LaTeX.",
  component: ParaBlock,
});

export const Bullets = defineComponent({
  name: "Bullets",
  props: z.object({ items: stringList, ordered: z.boolean().optional() }),
  description: "A bullet list; ordered: true makes it a numbered list.",
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
    title: z.string().optional(),
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
  props: z.object({ questions: z.array(z.any()), title: z.string().optional() }),
  description: "An interactive quiz: questions with question, type, options, answer and explanation.",
  component: QuizBlock,
});

export const Flashcards = defineComponent({
  name: "Flashcards",
  props: z.object({ cards: z.array(z.any()), title: z.string().optional() }),
  description: "A flip-card deck: cards have front and back.",
  component: FlashcardsBlock,
});

export const Timeline = defineComponent({
  name: "Timeline",
  props: z.object({ events: z.array(z.any()), title: z.string().optional() }),
  description: "A chronological timeline of date/label/description events.",
  component: TimelineBlock,
});

export const ConceptMap = defineComponent({
  name: "ConceptMap",
  props: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()), title: z.string().optional() }),
  description: "A concept map: nodes (id, label, description) and edges (from, to, label).",
  component: ConceptMapBlock,
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
