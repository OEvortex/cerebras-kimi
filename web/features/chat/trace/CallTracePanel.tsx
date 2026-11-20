"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import MarkdownRenderer from "@/components/common/MarkdownRenderer";
import type { StreamEvent } from "@/features/chat/model/protocol";
import {
  ActivityDetailGrid,
  ActivityDivider,
  ActivityRow,
  ActivityStack,
  argumentRows,
  type ActivityState,
  type DetailRow,
} from "@/components/activity";
import type { TraceDisplayItem, TraceItem } from "./model";
import {
  getCallProvider,
  getLatestToolProgress,
  getToolProvider,
  getTraceCallKind,
  getTraceGroup,
  getTraceMeta,
  getTraceRole,
  groupTraceEvents,
  isChatLoopAnswerContent,
  isTracePending,
  selectTraceDisplayItems,
} from "./selectors";
import {
  ENGINE_NAMED_TOOLS,
  clip,
  describeToolCall,
  formatTraceArgs,
  getTraceHeader,
  getTraceText,
  plainPreview,
  providerLabel,
  renderNiceToolArgs,
} from "./trace-format";

type ToolExchange = { call: StreamEvent; result: StreamEvent | null };

/**
 * Pair each `tool_call` with the `tool_result` that follows it.
 *
 * Needed because the two arrive as separate events, and rendering them as
 * separate blocks is what made the old detail body read as a list of
 * fragments rather than as one exchange.
 */
function pairToolEvents(events: StreamEvent[]): ToolExchange[] {
  const out: ToolExchange[] = [];
  for (const event of events) {
    if (event.type === "tool_call") {
      out.push({ call: event, result: null });
      continue;
    }
    const open = out[out.length - 1];
    if (open && !open.result) open.result = event;
    // A result with no call ahead of it — a resumed turn, or a call event
    // filtered upstream — still has to render, so it stands alone.
    else out.push({ call: event, result: null });
  }
  return out;
}

/**
 * The second level of a tool row: what went in, and what came back.
 *
 * Laid out as one label/value grid, because that is what the content is —
 * `query`, then `result`, on a shared left edge. The previous version put the
 * arguments in a pretty-printed JSON block and the result in a separately
 * ruled box below it, which spent most of its area on braces, quotes and a
 * second vertical rule. The row's own first level already names the action in
 * human terms, so this level never restates it either.
 */
function ToolExchangeDetail({
  exchange,
  showToolName,
}: {
  exchange: ToolExchange;
  showToolName: boolean;
}) {
  const { call, result } = exchange;
  const toolName = (call.metadata?.tool as string | undefined) ?? undefined;
  const isCall = call.type === "tool_call";

  const niceArgs = isCall
    ? renderNiceToolArgs(toolName, call.metadata?.args)
    : null;
  const rawArgs = isCall ? call.metadata?.args : undefined;
  const entries = niceArgs ? [] : argumentRows(rawArgs);
  // Non-object args (a bare string, an array) have no keys to lay out; they
  // land under a generic label rather than inventing a shape for them.
  const fallback =
    !niceArgs && entries.length === 0 && rawArgs && typeof rawArgs !== "object"
      ? formatTraceArgs(rawArgs)
      : "";

  const resultText = result?.content?.trim() || (!isCall ? call.content : "");
  const rows: DetailRow[] = [];

  if (showToolName && (toolName || call.content)) {
    rows.push({ key: "tool", value: toolName || call.content, mono: true });
  }
  rows.push(...entries);
  if (fallback) rows.push({ key: "args", value: fallback, mono: true });
  if (resultText) {
    rows.push({
      key: "result",
      value: <MarkdownRenderer content={resultText} variant="trace" />,
    });
  }

  if (!rows.length && !niceArgs) return null;

  return (
    <div>
      <ActivityDetailGrid rows={rows} />
      {niceArgs ?? null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Display-item grouping (step-level)                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Primitive UI pieces                                                */
/* ------------------------------------------------------------------ */

function ScrollableTraceBody({
  children,
  autoScroll,
  className = "ml-5 mr-3 mt-0.5 max-h-[180px] overflow-y-auto px-3 py-1",
}: {
  children: React.ReactNode;
  autoScroll?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (!autoScroll || !stickRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    if (autoScroll) stickRef.current = true;
  }, [autoScroll]);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  return (
    <div ref={ref} onScroll={handleScroll} className={className}>
      {children}
    </div>
  );
}


function TraceSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  if (!children) return null;
  return (
    <div className="space-y-0.5">
      <div className="not-italic text-[10px] font-semibold tracking-[0.04em] text-[var(--muted-foreground)]/70">
        {title}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Per-trace rendering                                                */
/* ------------------------------------------------------------------ */

function TraceRowBody({
  callId,
  callEvents,
  group,
  role,
  kind,
}: {
  callId: string;
  callEvents: StreamEvent[];
  group: string;
  role: string;
  kind: string;
}) {
  const progressEvents = callEvents.filter((event) => {
    if (event.type !== "progress") return false;
    const traceKind = String(getTraceMeta(event).trace_kind || "");
    if (traceKind === "call_status") return false;
    return event.content.trim().length > 0;
  });
  const toolEvents = callEvents.filter(
    (event) => event.type === "tool_call" || event.type === "tool_result",
  );
  const summaryProgressEvents = progressEvents.filter(
    (event) => String(getTraceMeta(event).trace_layer || "summary") !== "raw",
  );
  const rawProgressEvents = progressEvents.filter(
    (event) => String(getTraceMeta(event).trace_layer || "") === "raw",
  );
  const errorEvents = callEvents.filter(
    (event) => event.type === "error" && event.content.trim().length > 0,
  );
  const thoughtText = getTraceText(callEvents, ["thinking"]);
  const observationText = getTraceText(callEvents, ["observation"]);
  // Chat-loop reasoning belongs in the trace; its public prose stays in the answer.
  const isChatRound = kind === "agent_loop_round";
  const contentText = getTraceText(callEvents, ["content"]);
  const bodyBlocks =
    role === "observe"
      ? [observationText]
      : role === "retrieve"
        ? []
        : isChatRound
          ? [thoughtText, contentText]
          : [thoughtText || contentText];
  const renderableBodyBlocks = bodyBlocks.filter(
    (text): text is string => Boolean(text) && text.trim().length > 0,
  );
  // A connected subagent's native run streams in as ``subagent_event`` progress
  // lines, but those are shown in the side viewer's per-agent tab — keep the
  // inline trace compact (the question + the agent's final reply).
  const plainSummaryEvents = summaryProgressEvents.filter(
    (event) => getTraceMeta(event).trace_kind !== "subagent_event",
  );
  const inlineSources = callEvents.flatMap(
    (event) => getTraceMeta(event).sources ?? [],
  );

  return (
    <div className="text-[11.5px] leading-[1.6] text-[var(--muted-foreground)]">
      {group === "react_round" ? (
        <div className="space-y-2">
          <TraceSection title={"Thought"}>
            {thoughtText ? (
              <MarkdownRenderer content={thoughtText} variant="trace" />
            ) : null}
          </TraceSection>
          <TraceSection title={"Tool"}>
            {toolEvents.length > 0 ? (
              <div className="space-y-0.5">
                {pairToolEvents(toolEvents).map((exchange, idx) => (
                  <ToolExchangeDetail
                    key={`${callId}-tool-${idx}`}
                    exchange={exchange}
                    // Inside a round's "Tool" section the name is the only
                    // thing identifying which tool ran.
                    showToolName
                  />
                ))}
              </div>
            ) : null}
          </TraceSection>
          <TraceSection title={"Observe"}>
            {observationText ? (
              <MarkdownRenderer content={observationText} variant="trace" />
            ) : null}
          </TraceSection>
        </div>
      ) : (
        <div className="space-y-1">
          {plainSummaryEvents.length > 0 && (
            <div className="space-y-0.5">
              {plainSummaryEvents.map((event, idx) => (
                <div key={`${callId}-progress-${idx}`} className="opacity-70">
                  {event.content}
                </div>
              ))}
            </div>
          )}

          {(role === "retrieve" || kind === "math_render_output") &&
            rawProgressEvents.length > 0 && (
              <div className="space-y-0.5">
                <div className="not-italic text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                  {"Raw logs"}
                </div>
                <div className="max-h-[200px] overflow-y-auto rounded-md border border-[var(--border)] bg-[#292524] px-3 py-2 font-mono text-[10px] leading-[1.55] text-[#D6D3D1] shadow-inner">
                  {rawProgressEvents.map((event, idx) => (
                    <div
                      key={`${callId}-raw-${idx}`}
                      className="whitespace-pre-wrap break-words"
                    >
                      {event.content}
                    </div>
                  ))}
                </div>
              </div>
            )}

          {toolEvents.length > 0 && (
            <div className="space-y-1">
              {pairToolEvents(toolEvents).map((exchange, idx) => (
                <ToolExchangeDetail
                  key={`${callId}-tool-${idx}`}
                  exchange={exchange}
                  // The row's own first level already spells the action out,
                  // so repeating the raw tool name here is noise.
                  showToolName={false}
                />
              ))}
            </div>
          )}

          {renderableBodyBlocks.length > 0 && (
            <div className="mt-1 space-y-1.5">
              {renderableBodyBlocks.map((text, idx) => (
                <MarkdownRenderer
                  key={`${callId}-body-${idx}`}
                  content={text}
                  variant="trace"
                />
              ))}
            </div>
          )}
        </div>
      )}

      {inlineSources.length > 0 && (
        <div className="mt-1 opacity-50">
          {"Sources"}:{" "}
          {inlineSources.map((source, idx) => (
            <span key={`${callId}-source-${idx}`}>
              {idx > 0 && " · "}
              {String(source.title || source.query || source.type || "source")}
            </span>
          ))}
        </div>
      )}

      {errorEvents.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {errorEvents.map((event, idx) => (
            <div key={`${callId}-error-${idx}`} className="text-red-400/80">
              ✗ {event.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function hasExpandableContent(
  callEvents: StreamEvent[],
  group: string,
  role: string,
) {
  const progressEvents = callEvents.filter((event) => {
    if (event.type !== "progress") return false;
    const traceKind = String(getTraceMeta(event).trace_kind || "");
    if (traceKind === "call_status") return false;
    return event.content.trim().length > 0;
  });
  const toolEvents = callEvents.filter(
    (event) => event.type === "tool_call" || event.type === "tool_result",
  );
  const summaryProgressEvents = progressEvents.filter(
    (event) => String(getTraceMeta(event).trace_layer || "summary") !== "raw",
  );
  const rawProgressEvents = progressEvents.filter(
    (event) => String(getTraceMeta(event).trace_layer || "") === "raw",
  );
  const errorEvents = callEvents.filter(
    (event) => event.type === "error" && event.content.trim().length > 0,
  );
  const thoughtText = getTraceText(callEvents, ["thinking"]);
  const observationText = getTraceText(callEvents, ["observation"]);
  const contentText = getTraceText(callEvents, ["content"]);
  const genericBodyText =
    role === "observe"
      ? observationText
      : role === "retrieve"
        ? ""
        : thoughtText || contentText;
  const inlineSources = callEvents.flatMap(
    (event) => getTraceMeta(event).sources ?? [],
  );

  return (
    toolEvents.length > 0 ||
    summaryProgressEvents.length > 0 ||
    rawProgressEvents.length > 0 ||
    errorEvents.length > 0 ||
    Boolean(genericBodyText) ||
    inlineSources.length > 0 ||
    (group === "react_round" &&
      (Boolean(thoughtText) || Boolean(observationText)))
  );
}

/* ------------------------------------------------------------------ */
/*  Inline trace rows                                                  */
/* ------------------------------------------------------------------ */

/**
 * One trace = one Claude-style flat activity line in the message flow:
 * a small icon + the meaningful text of this step (reasoning / narration,
 * or a tool action with a tool-name chip) shown inline. There is no boxed
 * header and no always-visible chevron — a faint chevron only appears on
 * hover for rows that carry extra detail.
 *
 * The live step is auto-expanded so its reasoning streams in full; once it
 * completes it folds to a one-line preview (the activity-feed look). A
 * manual toggle pins the row from then on.
 */
function TraceRowItem({
  trace,
  active,
  nested,
}: {
  trace: TraceItem;
  active: boolean;
  nested: boolean;
}) {
  
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const { callId, events: callEvents } = trace;
  const first = callEvents[0];
  const meta = getTraceMeta(first);
  const phase = String(meta.phase || first?.stage || "");
  const role = getTraceRole(callEvents);
  const group = getTraceGroup(callEvents);
  const kind = getTraceCallKind(callEvents);
  const header = getTraceHeader(callEvents, nested);

  if (kind === "llm_final_response") return null;
  const expandable = hasExpandableContent(callEvents, group, role);
  if (!expandable && !active) return null;

  const isToolRow = kind === "tool_planning" || group === "tool_call";
  const isChatRound = kind === "agent_loop_round";
  const isRetrieve = role === "retrieve";
  // The model's own text-form deliberation — chat-loop reasoning/narration and
  // pipeline "Thought"/"Plan" rounds. Unlike a tool call (whose result is
  // secondary detail worth folding away), here the text IS the substance, so
  // it always streams in full and is never collapsed behind a chevron.
  const isThinking =
    isChatRound ||
    role === "thought" ||
    kind === "llm_reasoning" ||
    kind === "llm_planning";
  // The first level IS the default view: no row opens its own detail on its
  // own. The single exception is the model's own deliberation, which streams
  // in place while its round is live and folds itself away once the round
  // settles — watching it think is the point, re-reading it afterwards is
  // not. The context-exploration pre-pass opts out even of that: its
  // briefing runs long enough to walk the trace up the viewport while the
  // page is pinned to the bottom.
  const isContextExploration = kind === "context_exploration";
  const answering =
    isChatRound &&
    callEvents.some(isChatLoopAnswerContent);
  const autoOpen =
    isThinking && !isContextExploration && !answering ? active : false;
  const open = expandable && (userOpen ?? autoOpen);
  // Every row with detail is clickable now, deliberation included — it has to
  // be, since a settled round folds itself and the text has to be reachable.
  const canToggle = expandable;

  const toolCallEvent = callEvents.find((event) => event.type === "tool_call");
  const toolName = String(
    (toolCallEvent &&
      (getTraceMeta(toolCallEvent).tool_name ||
        toolCallEvent.metadata?.tool)) ||
      toolCallEvent?.content ||
      "",
  ).trim();
  const toolArgs = toolCallEvent?.metadata?.args as
    | Record<string, unknown>
    | undefined;

  const thoughtText = getTraceText(callEvents, ["thinking"]).trim();
  const contentText = getTraceText(callEvents, ["content"]).trim();

  // Resolve every row into a uniform { icon, headline, chip } triple so the
  // activity feed reads consistently across pipelines. Tool calls get a human
  // action verb + an artifact chip (the Claude-cowork pattern); retrieval
  // surfaces its query; chat reasoning rounds ARE their text (rendered inline
  // when open, clamped to a preview when folded).
  const provider = getToolProvider(callEvents);
  const descriptor =
    isToolRow && toolName
      ? describeToolCall(toolName, toolArgs, provider)
      : null;
  // What the provider last said about its own progress. Only MCP servers and
  // CLI apps publish these, and only while the call is open.
  const liveStatus = active ? getLatestToolProgress(callEvents) : "";

  let headline: string;
  let chip: { text: string; mono: boolean } | null = null;

  const engine = getCallProvider(callEvents);

  if (descriptor) {
    headline =
      engine && ENGINE_NAMED_TOOLS.has(toolName)
        ? `${providerLabel(engine)} ${descriptor.verb}`
        : descriptor.verb;
    chip = descriptor.chip
      ? { text: descriptor.chip, mono: descriptor.mono }
      : null;
    // While it runs, how far along it is displaces what it is: the identity is
    // already in the verb, and "fetching pages (30%)" is the only thing that
    // distinguishes a working call from a hung one. It reverts once settled.
    if (liveStatus) chip = { text: liveStatus, mono: false };
    // Name the consult after the agent it targets (e.g. "Consult Subagent
    // test-cc"); the name rides on the streamed subagent events in the group.
    if (toolName === "consult_subagent") {
      const agentName = String(
        callEvents.map((e) => getTraceMeta(e).subagent_name).find(Boolean) ||
          "",
      );
      const kind = callEvents.map((event) => getTraceMeta(event).subagent_kind).find(Boolean);
      const action = kind === "partner_group" ? "Organize partner discussion"
        : kind === "partner" ? "Ask partner" : "Ask subagent";
      headline = agentName ? `${action} ${agentName}` : action;
    }
  } else if (isRetrieve) {
    headline = engine ? `${providerLabel(engine)} ${header}` : header;
    const query = clip(
      String(callEvents.map((e) => getTraceMeta(e).query).find(Boolean) || ""),
    );
    chip = query ? { text: query, mono: false } : null;
  } else if (isChatRound) {
    // The label, not the prose. A chat round used to title itself with its
    // own reasoning, which forced the row to clamp onto two or three lines
    // and made it the only row shaped differently from its neighbours. The
    // reasoning now trails the label as this row's content, same as a query
    // trails a search.
    headline = header;
  } else {
    headline = header;
  }
  // What the dot has to say. Deliberately about state, not category: the
  // row's own text already names the category ("web search …", "search", or the
  // model's own sentence), so a glyph repeating it spent the one pre-text
  // position in the row on something the reader can already see. Where the
  // step stands is the part the text never says.
  const rowState: ActivityState = callEvents.some(
    (event) => event.type === "error" && event.content.trim().length > 0,
  )
    ? "error"
    : toolName === "ask_user"
      ? "awaiting"
      : active
        ? "running"
        : "done";

  // The model's own deliberation is the one case where the substance lives at
  // level one: a chat round's text IS the row, so an open one renders its
  // markdown inline rather than a structured detail body.
  const deliberation = isChatRound
    ? [thoughtText, contentText].filter(Boolean)
    : [thoughtText || contentText].filter(Boolean);

  return (
    <ActivityRow
      state={rowState}
      // Every row is one line: an action, then what it acted on. For a tool
      // that is verb + query; for deliberation it is the phase label + the
      // opening of the reasoning. The full text is level two.
      title={headline}
      detail={
        chip?.text ??
        // The preview is what stands in for the text while the row is folded.
        // An open row already shows that text in full below, so repeating its
        // opening on the title line prints the same sentence twice — which is
        // what a short deliberation looks like the whole time it streams.
        (isThinking && deliberation.length && !open
          ? plainPreview(deliberation[0])
          : undefined)
      }
      detailMono={chip?.mono ?? false}
      breathing={active}
      followOpen={autoOpen}
      autoScrollDetail={active}
      className={isChatRound ? "italic" : ""}
    >
      {isThinking ? (
        deliberation.length ? (
          <div
            className={`space-y-1.5 leading-[1.6] ${isChatRound ? "italic" : ""}`}
          >
            {deliberation.map((text, idx) => (
              <MarkdownRenderer
                key={`${callId}-say-${idx}`}
                content={text}
                variant="trace"
              />
            ))}
          </div>
        ) : null
      ) : (
        <TraceRowBody
          callId={callId}
          callEvents={callEvents}
          group={group}
          role={role}
          kind={kind}
          
        />
      )}
    </ActivityRow>
  );
}

export function CallTracePanel({
  events,
  isStreaming,
  nested = false,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
  // Kept for callers that render the rows inside their own framed shell;
  // rows are inline either way, ``nested`` only affects sub-row layout.
  nested?: boolean;
}) {
  

  const traceGroups = useMemo(() => groupTraceEvents(events), [events]);

  const displayItems: TraceDisplayItem[] = useMemo(
    () => selectTraceDisplayItems(traceGroups),
    [traceGroups],
  );

  // Hide the outer container entirely when no sub-trace ends up being
  // rendered. ``traceGroups`` can be non-empty even when every group is
  // filtered out by ``selectTraceDisplayItems`` (final-response groups and groups
  // tagged ``absorbed_into_final``) — in that case we used to draw an
  // empty bordered box. Check the materialised displayItems instead.
  if (!displayItems.length) return null;

  // Rows flow inline with the message — no outer card, no shared scroll
  // region. Each row manages its own fold state (live-follow + manual pin)
  // and its expanded body has its own bounded scroll area.
  return (
    <ActivityStack className="mb-3">
      {displayItems.map((item, displayIdx) => {
        const isLastDisplayItem = displayIdx === displayItems.length - 1;

        if (item.kind === "step") {
          const lastTrace = item.traces[item.traces.length - 1];
          const isActiveStep =
            Boolean(isStreaming) &&
            isLastDisplayItem &&
            isTracePending(lastTrace.events);

          // A step is a divider, not a level.
          //
          // It used to be a third fold wrapping its own hand-written
          // Round/Thought/Tool/Observe tree — a second renderer for the same
          // trace data, two levels deeper than the flat rows beside it, and
          // auto-expanded while live. Now it just labels the group and its
          // traces are ordinary first-level rows, so every trace in a turn
          // reads, folds and looks the same regardless of which pipeline
          // produced it.
          return (
            <div key={item.stepId} className={displayIdx > 0 ? "mt-2" : ""}>
              <ActivityDivider
                label={`Step ${item.stepId}`}
                active={isActiveStep}
              />
              <ActivityStack alignUnderOrb={false}>
                {item.traces.map((trace, idx) => (
                  <TraceRowItem
                    key={trace.callId}
                    trace={trace}
                    active={
                      Boolean(isStreaming) &&
                      isLastDisplayItem &&
                      idx === item.traces.length - 1 &&
                      isTracePending(trace.events)
                    }
                    nested={nested}
                  />
                ))}
              </ActivityStack>
            </div>
          );
        }

        const active =
          Boolean(isStreaming) &&
          isLastDisplayItem &&
          isTracePending(item.trace.events);
        return (
          <TraceRowItem
            key={item.trace.callId}
            trace={item.trace}
            active={active}
            nested={nested}
          />
        );
      })}
    </ActivityStack>
  );
}
