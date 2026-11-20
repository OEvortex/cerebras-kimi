"use client";

import type { ReactNode } from "react";
import type { StreamEvent } from "@/features/chat/model/protocol";
import { describeProviderTool, type ToolProvider } from "@/lib/trace-tools";
import type { ResearchStageId } from "./model";
import {
  getTraceCallKind,
  getTraceGroup,
  getTraceMeta,
  getTraceRole,
  isChatLoopAnswerContent,
} from "./selectors";

export const RESEARCH_STAGE_SPECS: Array<{
  id: ResearchStageId;
  titleKey: string;
  hintKey: string;
}> = [
  {
    id: "understand",
    titleKey: "research.stage.understand.title",
    hintKey: "research.stage.understand.hint",
  },
  {
    id: "decompose",
    titleKey: "research.stage.decompose.title",
    hintKey: "research.stage.decompose.hint",
  },
  {
    id: "evidence",
    titleKey: "research.stage.evidence.title",
    hintKey: "research.stage.evidence.hint",
  },
  {
    id: "result",
    titleKey: "research.stage.result.title",
    hintKey: "research.stage.result.hint",
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Collapse whitespace and clip to ``max`` chars with an ellipsis. */
/**
 * Flatten markdown-ish prose into one line of plain text for a folded row.
 *
 * Not a markdown parser — it strips the few marks that would otherwise show
 * up as literal punctuation in a preview (emphasis, headings, list bullets,
 * code fences) and collapses whitespace. Anything it misses degrades to
 * showing the raw character, which is acceptable in a one-line teaser.
 */
export function plainPreview(value: string, max = 140) {
  const flat = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/[*_]{1,2}([^*_]*)[*_]{1,2}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function clip(value: string, max = 56) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Last path segment (handles both / and \\ separators). */
function basename(path: string) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

/** A trace-row glyph: either a hand-drawn Mark or a lucide icon. Both accept
 *  this prop subset, so the row renders them uniformly. */
type ToolDescriptor = {
  /** Human action verb (already translated). */
  verb: string;
  /** The concrete artifact this call touched (file, query, …), or null. */
  chip: string | null;
  /** Render the chip in a mono face (code / paths / commands). */
  mono: boolean;
};

/**
 * Maps a tool call to the activity-row vocabulary: a hand-drawn glyph (the
 * same organic mark family as the status header — see {@link CommandMark}
 * &c.), a human action verb ("Running command", "Reading skill"), and a
 * compact chip naming the artifact it acted on (the command, the file, the
 * query). Falls back to a humanized tool name + generic mark for unknown
 * tools so new tools still read sensibly without a code change.
 *
 * `provider` short-circuits the switch for tools that come from an MCP server
 * or an installed CLI app. Their names are *generated*, so the fallback would
 * title-case a machine string — "Mcp Wolfram Wolframalpha" — and tell the reader
 * neither which service is being used nor what it was asked to do.
 */
export function describeToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  provider?: ToolProvider | null,
): ToolDescriptor {
  const a = args ?? {};
  const str = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";

  // An external provider's row is decided in `lib/trace-tools` — the whole
  // decision is data there, so it is unit-tested; only the glyph is resolved
  // here, where the marks live.
  const providerRow = describeProviderTool(toolName, args, provider);
  if (providerRow) {
    return {
      verb: providerRow.verb,
      chip: providerRow.chip,
      mono: providerRow.mono,
    };
  }
  const host = (url: string) => {
    if (!url) return "";
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  switch (toolName) {
    case "exec":
      return {
        verb: a.language === "shell" ? "Running command" : "Running code",
        chip:
          a.language === "shell"
            ? clip(str(a.code), 48) || null
            : str(a.language) || "Python",
        mono: true,
      };
    case "rag":
      return {
        verb: "Searching knowledge",
        chip: clip(str(a.query)) || null,
        mono: false,
      };
    case "kb_files":
      return {
        verb: "Listing knowledge base files",
        chip: str(a.kb_name) || null,
        mono: false,
      };
    case "web_search":
      return {
        verb: "Searching the web",
        chip: clip(str(a.query)) || null,
        mono: false,
      };
    case "paper_search":
      return {
        verb: "Searching papers",
        chip: clip(str(a.query)) || null,
        mono: false,
      };
    case "web_fetch":
      return {
        verb: "Fetching page",
        chip: host(str(a.url)) || null,
        mono: true,
      };
    case "read_skill":
      return {
        verb: "Reading skill",
        chip: str(a.name) || null,
        mono: false,
      };
    case "load_tools": {
      const names = Array.isArray(a.names)
        ? (a.names as unknown[]).map((n) => String(n))
        : [];
      return {
        verb: "Loading tools",
        chip: names.join(", ") || null,
        mono: true,
      };
    }
    case "read_source":
      return {
        verb: "Reading source",
        chip: str(a.source_id) || null,
        mono: false,
      };
    case "read_file":
      return {
        verb: "Reading file",
        chip: basename(str(a.path)) || null,
        mono: true,
      };
    case "write_file":
      return {
        verb: "Writing file",
        chip: basename(str(a.path)) || null,
        mono: true,
      };
    case "edit_file":
      return {
        verb: "Editing file",
        chip: basename(str(a.path)) || null,
        mono: true,
      };
    case "list_dir":
      return {
        verb: "Listing files",
        chip: basename(str(a.path)) || null,
        mono: true,
      };
    case "write_note":
      return {
        verb: "Writing note",
        chip: clip(str(a.title), 40) || null,
        mono: false,
      };
    case "read_memory":
      return {
        verb: "Recalling memory",
        chip: null,
        mono: false,
      };
    case "write_memory":
      return {
        verb: "Saving memory",
        chip: null,
        mono: false,
      };
    case "reason":
      return {
        verb: "Reasoning",
        chip: clip(str(a.query)) || null,
        mono: false,
      };
    case "brainstorm":
      return {
        verb: "Brainstorming",
        chip: clip(str(a.topic)) || null,
        mono: false,
      };
    case "ask_user":
      return {
        verb: "Asking you",
        chip: null,
        mono: false,
      };
    case "invoke_other":
      return {
        verb: "Proposing a Partner follow-up",
        chip: str(a.target_partner_id)
          ? `@${str(a.target_partner_id).replace(/^@/, "")}`
          : null,
        mono: false,
      };
    case "github":
      return {
        verb: "Querying GitHub",
        chip: str(a.target) || null,
        mono: true,
      };
    case "geogebra_analysis":
      return {
        verb: "Analyzing figure",
        chip: null,
        mono: false,
      };
    case "visualize":
      return {
        verb: "Visualizing",
        chip: null,
        mono: false,
      };
    case "math_animator":
      return { verb: "Animating", chip: null, mono: false };
    default:
      return {
        verb: titleCase(toolName),
        chip: null,
        mono: false,
      };
  }
}

export function humanizeQuestionId(value: string) {
  return value.replace(/\bq_(\d+)\b/gi, (_match, n) => `Question ${n}`);
}

function getTraceLabel(events: StreamEvent[]) {
  for (const event of events) {
    const meta = getTraceMeta(event);
    if (meta.label) return humanizeQuestionId(String(meta.label));
  }
  const fallback = events[0]?.stage || "trace";
  return humanizeQuestionId(titleCase(fallback));
}

/**
 * The external provider this trace's tool belongs to, or null for a built-in.
 *
 * Exported for tests: this and {@link getLatestToolProgress} are the wiring
 * between what the backend stamps on a turn's events and what the row shows, and
 * they are checked against events recorded from a real LLM turn
 * (`tests/fixtures/provider-trace-events.json`).
 *
 * Scanned across the group rather than read off the `tool_call` event alone: the
 * status and progress events carry it too, and a group whose opening event was
 * dropped (a reconnect mid-turn) should still be labelled correctly.
 */

export function getTraceHeader(events: StreamEvent[], nested?: boolean) {
  const label = getTraceLabel(events);
  const role = getTraceRole(events);
  const group = getTraceGroup(events);
  const kind = getTraceCallKind(events);
  const meta = getTraceMeta(events[0]);

  let title = label;
  if (
    [
      "math_concept_analysis",
      "math_concept_design",
      "math_code_generation",
      "math_code_retry",
      "math_summary",
      "math_render_output",
    ].includes(kind)
  ) {
    title = label;
  } else if (kind === "context_exploration") {
    // The pre-pass that investigates the turn's attached sources before
    // answering. Noun header for the trace row — the turn-level status row
    // carries the verb form ("Exploring your context…") so the two never
    // read as the same label stacked on itself.
    title = "Context exploration";
  } else if (role === "retrieve") {
    title = "Retrieve";
  } else if (role === "explore" || kind === "agent_loop_round") {
    title = "Exploring";
  } else if (kind === "tool_planning") {
    title = "Tool call";
  } else if (group === "react_round") {
    if (nested) {
      title = meta.round ? `Round ${meta.round}` : label;
    } else {
      const step = meta.step_id ? `Step ${meta.step_id}` : "";
      const round = meta.round ? `Round ${meta.round}` : label;
      title = [step, round].filter(Boolean).join(" · ");
    }
  } else if (role === "plan" && kind === "llm_planning") {
    title = "Plan";
  } else if (role === "observe" || kind === "llm_observation") {
    title = "Observe";
  } else if (role === "quiz_question" || kind === "quiz_question_emitted") {
    // Each quiz question gets its own sub-trace card; index is 0-based in
    // metadata, so display as 1-based for the user.
    const idx = Number(meta.question_index);
    title = Number.isFinite(idx)
      ? `Question ${idx + 1}`
      : "Question";
  } else if (role === "response" || kind === "llm_final_response") {
    title = "Response";
  } else if (role === "reflection" || kind === "tool_result_reflection") {
    // Tool Summarizer sub-trace (Phase 1 of the question pipeline). The
    // top-level status row carries the verbose "DeepTutor Reflecting…"
    // wording; the sub-trace just labels itself "Reflecting" so the card
    // header stays short.
    title = "Reflecting";
  } else if (role === "thought" || kind === "llm_reasoning") {
    title = "Thought";
  } else if (kind === "llm_generation") {
    if (/^generate\s+/i.test(label)) {
      title = `Generating ${label.replace(/^generate\s+/i, "")}`;
    } else if (/^write\s+/i.test(label)) {
      title = `Writing ${label.replace(/^write\s+/i, "")}`;
    }
  }

  return title;
}

// Chat-loop prose belongs to the answer and must not be duplicated in the trace.
export function getTraceText(
  events: StreamEvent[],
  eventTypes: Array<StreamEvent["type"]>,
) {
  const textEvents = events.filter(
    (event) =>
      eventTypes.includes(event.type) &&
      event.content.trim().length > 0 &&
      !isChatLoopAnswerContent(event),
  );
  if (!textEvents.length) return "";

  const explicitOutputs = textEvents.filter(
    (event) => String(getTraceMeta(event).trace_kind || "") === "llm_output",
  );
  if (explicitOutputs.length > 0) {
    return explicitOutputs[explicitOutputs.length - 1].content;
  }

  return textEvents.map((event) => event.content).join("");
}

// Long string values in tool args are almost always base64 payloads
// (image bytes, file blobs) the LLM never typed itself — they were
// server-injected by the chat pipeline. Pretty-printing the raw value
// fills the trace with megabytes of noise, so we elide anything past
// this many characters down to a short summary.
const TRACE_ARGS_MAX_STRING_CHARS = 200;

function elideLongStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > TRACE_ARGS_MAX_STRING_CHARS) {
      const head = value.slice(0, 40);
      return `${head}… <${value.length.toLocaleString()} chars elided>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(elideLongStrings);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = elideLongStrings(v);
    }
    return out;
  }
  return value;
}

export function formatTraceArgs(args: unknown) {
  if (args == null) return "";
  try {
    return JSON.stringify(elideLongStrings(args), null, 2);
  } catch {
    return String(args);
  }
}

/**
 * Per-tool nice rendering for ``tool_call`` args. Some tools (notably
 * ``ask_user``) have args that are large structured payloads which the
 * UI also renders as a dedicated card below the trace — dumping the raw
 * JSON twice is just noise. Returning ``null`` falls back to the
 * generic JSON ``<pre>`` block.
 */
export function renderNiceToolArgs(
  toolName: string | undefined,
  rawArgs: unknown,
): ReactNode | null {
  if (toolName !== "ask_user" || !rawArgs || typeof rawArgs !== "object") {
    return null;
  }
  const obj = rawArgs as Record<string, unknown>;
  const questions = Array.isArray(obj.questions)
    ? (obj.questions as Array<Record<string, unknown>>)
    : [];
  if (questions.length === 0) return null;
  return (
    <ul className="ml-3 mt-0.5 space-y-0.5 text-[10.5px] leading-[1.5] not-italic">
      {questions.map((q, idx) => {
        const prompt = String(q.prompt ?? q.question ?? "").trim();
        if (!prompt) return null;
        return (
          <li
            key={idx}
            className="flex items-start gap-1.5 text-[var(--muted-foreground)]"
          >
            <span className="shrink-0 tabular-nums opacity-50">{idx + 1}.</span>
            <span className="min-w-0 flex-1">{prompt}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Display name for a retrieval / search engine slug.
 *
 * The backend keeps the authoritative label table (`provider_runtime.py`),
 * but it is only reachable through the settings endpoints and a trace row has
 * no business calling those. `titleCase` handles most slugs; this table is
 * only the ones whose capitalisation it cannot guess.
 */
const PROVIDER_LABELS: Record<string, string> = {
  lightrag: "LightRAG",
  raganything: "RAGAnything",
  pageindex: "PageIndex",
  llamaindex: "LlamaIndex",
  graphrag: "GraphRAG",
  duckduckgo: "DuckDuckGo",
  ddg: "DuckDuckGo",
  openai: "OpenAI",
  aliyun_iqs: "Aliyun IQS",
  iqs: "IQS",
  bocha: "Bocha",
  zhipu: "Zhipu",
  deepseek: "DeepSeek",
  specstream: "SpecStream",
};

export function providerLabel(slug: string): string {
  return PROVIDER_LABELS[slug.toLowerCase()] ?? titleCase(slug);
}

/**
 * Tools whose row names its engine.
 *
 * Only the ones the user picks a provider for. Which engine answered is the
 * whole difference between two calls that otherwise render identically, and
 * it is the part of the pipeline the reader configured themselves — so
 * "Perplexity web search" says more than "web search" at no extra width.
 */
export const ENGINE_NAMED_TOOLS = new Set([
  "web_search",
  "rag_search",
  "rag",
  "paper_search",
]);

/** A tool call together with its result, once one arrives. */
