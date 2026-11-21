"use client";

import dynamic from "@/shared/router/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RotateCcw, Square, Volume2 } from "lucide-react";
import type { StreamEvent } from "@/features/chat/model/protocol";
import type { MessageTraceMetadata } from "@/features/chat/trace/memory";
import type { MessageRequestSnapshot } from "@/features/chat/ChatStateAdapter";
import AssistantResponse from "@/components/common/AssistantResponse";
import { InlineFileCardProvider, mergeGeneratedFiles, unlinkedGeneratedFiles } from "@/components/common/InlineFileCard";
import Tooltip from "@/shared/ui/Tooltip";
import HyperframesPlayer from "@/components/chat/preview/HyperframesPlayer";
import { HYPERFRAMES_MIME } from "@/components/chat/preview/previewerFor";
import { PlayAudioButton } from "@/components/voice/SpeechButton";
import { useVoicePlaybackRate, VOICE_PLAYBACK_RATES } from "@/hooks/useVoicePlaybackRate";
import { extractNotebookTask } from "@/lib/notebook-live-types";
import { extractMathAnimatorResult } from "@/lib/math-animator-types";
import { extractVideoLessonResult } from "@/lib/video-lesson-types";
import { extractVisualizeResult } from "@/lib/visualize-types";
import { hasVisibleMarkdownContent } from "@/lib/markdown-display";
import { AskUserOptions, extractAskUserPayload, extractMessageSegments, leadingTraceEvents, type MessageSegment } from "@/components/chat/home/AskUserOptions";
import { collectMasteryAnswerRejections, collectMasteryGrades, collectMasterySkips, extractMasteryQuestion, type MasteryAnswerRejection, type MasteryGradeResult, type MasteryQuestion } from "@/lib/mastery-question";
import { SetupCredentialCard } from "@/components/chat/home/SetupCredentialCard";
import { extractSetupCredential } from "@/lib/setup-signals";
import { PartnerDraftCard } from "@/components/chat/home/PartnerDraftCard";
import { extractPartnerDraft } from "@/lib/partner-draft";
import { CreationDraftCard } from "@/components/chat/home/CreationDraftCard";
import { extractCreationDraft } from "@/lib/creation-draft";
import { extractMasteryHandoffs } from "@/lib/mastery-handoff";
import { AssistantActivity, NestedTraceFlow, TraceFlow } from "@/features/chat/trace/TracePresentation";
import { hasSettledFinalRound } from "@/features/chat/trace/selectors";
import OpenUIMessage from "@/features/chat/messages/OpenUIMessage";
import LegacyOguiMessage from "@/features/chat/messages/LegacyOguiMessage";
import { hasOpenUILang } from "@/lib/openui/lang";
import { hasLegacyOgui } from "@/lib/openui/legacy-ogui";
import { answererOf, parseAnswerBy } from "@/features/chat/trace/answerer";
import { usePartner } from "@/hooks/usePartnerRoster";
import { authoritativeResearchReport, isConfirmedResearchFollowup, researchFollowupStatus } from "@/lib/deep-research-report";
import { UsageFooter } from "./UsageFooter";
import { cumulativeMessageUsage, messageUsage } from "./usage-summary";
import { GeneratedFileCards } from "./GeneratedFileCards";
import { CopyActionButton, DeleteTurnButton, HandedToBadge, RoughActionButton } from "./MessageActions";
import { ProcessBody, ProcessFold, SentMidTurn, buildMessageBlocks, countProcessToolCalls } from "./message-process";
import { ROW_GUTTER, type ChatMessageItem } from "./types";

const MathAnimatorViewer = dynamic(
  () => import("@/components/math-animator/MathAnimatorViewer"),
  { ssr: false },
);
const MasteryQuestionCard = dynamic(
  () => import("@/components/chat/home/MasteryQuestionCard"), { ssr: false },
);
const MasterySourcePresentation = dynamic(
  () => import("@/components/chat/home/MasterySourcePresentation").then(module => module.MasterySourcePresentation),
  { ssr: false },
);
const MasterySourcePages = dynamic(
  () => import("@/components/chat/home/MasterySourcePresentation").then(module => module.MasterySourcePages),
  { ssr: false },
);
const MasteryHandoffCards = dynamic(
  () => import("@/components/chat/home/MasteryHandoffCard").then(module => module.MasteryHandoffCards),
  { ssr: false },
);
const ResearchOutlineEditor = dynamic(
  () => import("@/components/research/ResearchOutlineEditor"),
  { ssr: false },
);
const VisualizationViewer = dynamic(
  () => import("@/components/visualize/VisualizationViewer"),
  { ssr: false },
);
const VideoLessonViewer = dynamic(
  () => import("@/components/video-lesson/VideoLessonViewer"),
  { ssr: false },
);
const NotebookLivePanel = dynamic(
  () => import("@/features/notebook-ui/NotebookLivePanel"),
  { ssr: false },
);


const ReplyBody = memo(function ReplyBody({
  content,
  isStreaming,
  language,
  onSendFollowUp,
  renderMarkdown = false,
}: {
  content: string;
  isStreaming?: boolean;
  language?: string;
  onSendFollowUp?: (text: string) => void | Promise<void>;
  /** Notebook threads answer in Markdown and render with the note renderer. */
  renderMarkdown?: boolean;
}) {
  if (renderMarkdown) {
    return (
      <AssistantResponse
        content={content}
        isStreaming={isStreaming}
        language={language}
        className="dt-note-chat-markdown"
      />
    );
  }
  if (hasLegacyOgui(content)) {
    return (
      <LegacyOguiMessage
        content={content}
        isStreaming={isStreaming}
        language={language}
        onSendFollowUp={onSendFollowUp}
      />
    );
  }
  return (
    <OpenUIMessage
      content={content}
      isStreaming={isStreaming}
      language={language}
      onSendFollowUp={onSendFollowUp}
    />
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  msg,
  isStreaming,
  outlineStatus,
  sessionId,
  language,
  onConfirmOutline,
  onSubmitUserReply,
  onAnswerMasteryQuestion,
  onSkipMasteryQuestion,
  onChallengeMasteryQuestion,
  onSendFollowUp,
  renderMarkdown = false,
  researchRequestSnapshot,
  onTraceToggle,
  masteryGrades,
  masterySkips,
  masteryAnswerRejections,
}: {
  msg: {
    id?: number;
    content: string;
    capability?: string;
    events?: StreamEvent[];
    trace?: MessageTraceMetadata;
  };
  isStreaming?: boolean;
  /**
   * Every mastery verdict in the conversation, by question id. Collected once
   * for the whole list because a question answered in the composer is graded a
   * turn later than it was posed, and its card should still show the answer.
   */
  masteryGrades?: Map<string, MasteryGradeResult>;
  /** Every question the learner dropped, by id — collected the same way and
   *  for the same reason: the skip lands on a later turn than the card. */
  masterySkips?: Set<string>;
  masteryAnswerRejections?: Map<string, MasteryAnswerRejection>;
  outlineStatus?: "editing" | "researching" | "done" | "failed";
  sessionId?: string | null;
  language?: string;
  researchRequestSnapshot?: MessageRequestSnapshot | null;
  /** Notified when a persisted trace is opened or collapsed. Takes the id so
   *  the list can hand one callback to every row — see ``handleTraceToggle``. */
  onTraceToggle?: (messageId: number, open: boolean) => void;
  onConfirmOutline?: (
    outline: Array<{ title: string; overview: string }>,
    topic: string,
    researchConfig?: Record<string, unknown> | null,
    requestSnapshot?: MessageRequestSnapshot | null,
  ) => void;
  /**
   * Submit a reply for a turn that is paused on ``ask_user``. Wired
   * through from the page so the card's option-buttons / free-text
   * input can deliver the user's selection back to the backend over
   * the unified WebSocket. Triggers a same-turn resume (no new user
   * bubble). Accepts either a flat string (legacy single-question) or
   * a structured object with per-question ``answers`` (v2 path).
   */
  onSubmitUserReply?: (
    reply:
      | string
      | {
          text?: string;
          answers?: Array<{ questionId: string; text: string }>;
        },
  ) => void | boolean | Promise<void | boolean>;
  /**
   * Answer a mastery question card. Unlike ``onSubmitUserReply`` this does
   * NOT resume a paused turn — posing a mastery question ends its turn, so
   * the answer starts the next one, exactly as typing it would. That is what
   * keeps the learner free to answer, ask something else, or come back later.
   */
  onAnswerMasteryQuestion?: (answer: {
    questionId: string;
    text: string;
    answers?: Array<{ questionId: string; text: string }>;
  }) => void | boolean | Promise<void | boolean>;
  /** Drop a question the learner does not want to answer. Same turn-starting
   *  shape as answering it, because the engine holds one open question per
   *  path: without this the tutor's next question is this same one again. */
  onSkipMasteryQuestion?: (
    questionId: string,
  ) => void | boolean | Promise<void | boolean>;
  onChallengeMasteryQuestion?: (questionId: string) => void | boolean | Promise<void | boolean>;
  /** OpenUI `continue_conversation` actions become a normal user turn. */
  onSendFollowUp?: (text: string) => void | Promise<void>;
  /** Notebook companion renders Markdown instead of OpenUI programs. */
  renderMarkdown?: boolean;
}) {
  
  const events = useMemo(() => msg.events ?? [], [msg.events]);
  const readingMaterialId = researchRequestSnapshot?.readingMaterialId;
  const readingMaterialRevision =
    researchRequestSnapshot?.readingMaterialRevision;
  // The language this reply was generated in, as recorded on the turn's
  // request snapshot when it was sent. Prose is tagged with it rather than
  // the session's current language so changing the reply language never
  // re-tags past replies (a Chinese answer keeps zh fonts after the session
  // moves on to Japanese). Replies without a recorded language — legacy
  // rows from before snapshots carried it — fall back to the session
  // language, which is the best guess available for them.
  const turnLanguage = researchRequestSnapshot?.language || language;
  const resultEvent = useMemo(
    () => msg.events?.find((event) => event.type === "result") ?? null,
    [msg.events],
  );

  const outlinePreview = useMemo(() => {
    if (msg.capability !== "deep_research" || !resultEvent) return null;
    const meta = resultEvent.metadata as Record<string, unknown> | undefined;
    if (!meta?.outline_preview) return null;
    return {
      sub_topics: (meta.sub_topics ?? []) as Array<{
        title: string;
        overview: string;
      }>,
      topic: String(meta.topic ?? ""),
      research_config: (meta.research_config ?? null) as Record<
        string,
        unknown
      > | null,
    };
  }, [msg.capability, resultEvent]);

  const mathAnimatorResult = useMemo(() => {
    if (msg.capability !== "math_animator" || !resultEvent) return null;
    return extractMathAnimatorResult(resultEvent.metadata);
  }, [msg.capability, resultEvent]);

  const visualizeResult = useMemo(() => {
    if (msg.capability !== "visualize" || !resultEvent) return null;
    return extractVisualizeResult(resultEvent.metadata);
  }, [msg.capability, resultEvent]);

  const notebookTask = useMemo(() => extractNotebookTask(events), [events]);

  const videoLessonResult = useMemo(() => {
    // A one-turn capability or a resumed turn may still have the composer's
    // chat label. The capability that emitted the result is authoritative.
    // Ignore earlier intermediate results that do not carry a playable page.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== "result" ||
          (event.source !== "video_lesson" && msg.capability !== "video_lesson")) continue;
      const lesson = extractVideoLessonResult(event.metadata);
      if (lesson) return lesson;
    }
    return null;
  }, [msg.capability, events]);

  // Detect the ``ask_user`` terminator payload: when the assistant turn
  // ended via the ``ask_user`` tool, this is the question the user is
  // expected to answer next. Render option chips below the message.
  const askUserPayload = useMemo(
    () => extractAskUserPayload(msg.events, { streaming: isStreaming }),
    [msg.events, isStreaming],
  );
  // A graded mastery question travels on the same pause channel as a
  // clarifying one: the study card that renders it shows the objective, the
  // attempt and the verdict, none of which the generic card has anywhere to
  // put.
  //
  // Only the last one is read here, for the surfaces that pin a single card
  // below the body. The default surface renders a card per segment instead —
  // a turn resumes on this same message after every answer, so working one
  // objective leaves a run of questions, and each card must show the question
  // it actually asked.
  const latestMasteryQuestion = useMemo(
    () => extractMasteryQuestion(msg.events),
    [msg.events],
  );
  // ``false`` — never a silent no-op — so a card with nowhere to send its
  // answer reopens instead of spinning forever. See ``submitUserReply``.
  const submitReply = useCallback(
    (reply: {
      text?: string;
      answers?: Array<{ questionId: string; text: string }>;
    }) => (onSubmitUserReply ? onSubmitUserReply(reply) : false),
    [onSubmitUserReply],
  );
  // The card is answered by sending the next message, so "already answered"
  // cannot come from a resolved pause any more — the turn that posed it is
  // long over. The verdict is the durable signal, and it survives a reload.
  const renderMasteryCard = useCallback(
    (question: MasteryQuestion) => {
      const grade = masteryGrades?.get(question.questionId) ?? null;
      return (
        <MasteryQuestionCard
          question={question}
          grade={grade}
          answered={Boolean(grade) && grade?.complete !== false && grade?.final !== false}
          skipped={masterySkips?.has(question.questionId) ?? false}
          submittedAnswer={grade?.learnerAnswer ?? ""}
          rejectionKey={!grade || grade.complete === false || grade.final === false ? masteryAnswerRejections?.get(question.questionId)?.retryKey : undefined}
          onSubmit={({ text, answers }) =>
            onAnswerMasteryQuestion
              ? onAnswerMasteryQuestion({
                  questionId: question.questionId,
                  text: String(text ?? ""),
                  ...(question.questionType === "group" ? { answers } : {}),
                })
              : false
          }
          onSkip={onSkipMasteryQuestion}
          onChallenge={onChallengeMasteryQuestion}
        />
      );
    },
    [
      masteryGrades,
      masterySkips,
      masteryAnswerRejections,
      onAnswerMasteryQuestion,
      onSkipMasteryQuestion,
  onChallengeMasteryQuestion,
    ],
  );
  // Set by ``request_credential`` when a configuration step needs a secret the
  // assistant must not handle itself.
  const setupCredential = useMemo(
    () => extractSetupCredential(msg.events),
    [msg.events],
  );

  const partnerDraft = useMemo(
    () => extractPartnerDraft(msg.events),
    [msg.events],
  );

  const creationDraft = useMemo(
    () => extractCreationDraft(msg.events),
    [msg.events],
  );


  // Set by the mastery navigation tools when the learner asked to be taken
  // back to something they are studying. The offer carries a
  // destination, a reason, an editable opening line — for the surface that
  // actually teaches it.
  const masteryHandoffs = useMemo(
    () => extractMasteryHandoffs(msg.events),
    [msg.events],
  );

  const body = msg.content;

  // Interleaved segments for the default chat surface: the message is laid
  // out in the order it was written — what DeepTutor said it was about to do,
  // the work it then did, what it found, and so on down to the closing answer.
  // Only walked when this message will actually render through the default
  // branch (the research / quiz / animator / visualize branches have their own
  // layout and pin their cards elsewhere).
  const useInlineSegments =
    !outlinePreview &&
    !mathAnimatorResult &&
    !visualizeResult &&
    !videoLessonResult &&
    !notebookTask;
  const messageSegments = useMemo(
    () =>
      useInlineSegments
        ? extractMessageSegments(msg.events, msg.content, {
            streaming: isStreaming,
          })
        : [],
    [useInlineSegments, msg.events, msg.content, isStreaming],
  );
  // Pages already drawn at the tool call that presented them; the fallback
  // below only stacks the ones this layout had no place for.
  const placedSourcePages = useMemo(() => {
    const urls = new Set<string>();
    if (!useInlineSegments) return urls;
    for (const seg of messageSegments) {
      if (seg.kind === "source_view") seg.pages.forEach(page => urls.add(page.preview_url));
    }
    return urls;
  }, [useInlineSegments, messageSegments]);
  // Either card kind: a clarifying ask_user, or a posed mastery question.
  const hasInlineCards =
    useInlineSegments &&
    messageSegments.some(
      (seg) => seg.kind === "ask_user" || seg.kind === "mastery_question",
    );
  // Lay the body out from the segments whenever there is more to place than
  // one run of prose. A message with nothing but text gets the plain body
  // branch below, which is the same thing with less machinery.
  const useSegmentLayout =
    useInlineSegments && messageSegments.some((seg) => seg.kind !== "text");
  // Every trace row now renders inline, where the work happened. The header
  // block keeps its status line and nothing else — leaving rows up there too
  // would show each step twice.
  const headerTraceEvents = useMemo(
    () =>
      useSegmentLayout ? leadingTraceEvents(events, messageSegments) : undefined,
    [useSegmentLayout, messageSegments, events],
  );
  // The live notebook card replaces the raw "Calling notebook" / tool-result
  // rows — otherwise the same job appears twice in one message.
  const activityEvents = useMemo(() => {
    if (!notebookTask) return events;
    const toolId = notebookTask.tool_call_id || notebookTask.task_id;
    return events.filter((event) => {
      const meta = event.metadata as {
        tool_name?: string;
        tool_call_id?: string;
        notebook_progress?: unknown;
        notebook_task?: unknown;
      } | null;
      if (meta?.notebook_progress || meta?.notebook_task) return false;
      if (meta?.tool_name === "notebook") return false;
      if (toolId && meta?.tool_call_id === toolId) return false;
      return true;
    });
  }, [events, notebookTask]);

  // Where the working-out stops and the answer starts.
  //
  // Everything a turn writes is worth watching while it works, and almost
  // none of it is worth re-reading afterwards. So the two are separate
  // layers: the process stays open and streams live, then folds itself into
  // one line the moment the turn settles into its closing answer.
  //
  // The boundary is the trailing run of prose — the text after the last step —
  // and it is structural, not timed: whatever is being written right now is
  // always placed as the answer, from its first character.
  // Teaching before a mastery question is also answer prose; the block
  // builder preserves it separately because that card ends the turn.
  //
  // Waiting for the terminal round before promoting it is what an earlier cut
  // did, and it meant the closing answer streamed INSIDE the collapsible
  // process and jumped out of it once finished. That leaks a question the
  // reader should never have been asked to hold — "is this the answer yet?" —
  // and it is a question we cannot answer at that point anyway: a round only
  // reveals whether it called tools after its prose is complete.
  //
  // Placing it optimistically inverts which case pays. Commentary is demoted
  // into the process when its round turns out to have called a tool, and that
  // costs one 14px slide at the exact moment the tool row appears below it —
  // motion that reads as the two being grouped. The answer, which is the text
  // the reader actually came for, never moves at all.
  const answerStart = useMemo(() => {
    let idx = messageSegments.length;
    while (idx > 0 && messageSegments[idx - 1].kind === "text") idx -= 1;
    return idx;
  }, [messageSegments]);
  // A turn that has started writing its answer is no longer changing the
  // working-out above it, which is what lets that whole subtree stop
  // re-deriving itself on every delta. Structural, like the boundary: if a new
  // round starts, the answer goes back into the process and this goes false.
  const processSettled = answerStart < messageSegments.length;
  // Separately again: whether the working-out folds itself away. This is the
  // one thing that does need the terminal-round signal, since it is the claim
  // that there is no more work coming at all.
  const settledIntoAnswer = !isStreaming || hasSettledFinalRound(events);
  // Pending questions stay outside the disclosure so they remain answerable.
  // Once answered, a clarification joins the surrounding process so resumed
  // work continues under the original activity header.
  const messageBlocks = useMemo(
    () => buildMessageBlocks(messageSegments, answerStart, msg.capability === "mastery_path"),
    [messageSegments, answerStart, msg.capability],
  );
  // The leading run rides in the activity header, which is already pinned at
  // the top and already is a disclosure — giving it the process keeps the
  // message to ONE line of chrome instead of a status line plus a fold.
  // Only the segment layout hands its process to the header; a message with
  // nothing but prose renders through the plain body branch below, which would
  // otherwise draw the same opening sentence a second time.
  const headerProcess =
    useSegmentLayout && messageBlocks[0]?.kind === "process"
      ? messageBlocks[0]
      : null;
  const bodyBlocks = headerProcess ? messageBlocks.slice(1) : messageBlocks;

  const renderSegments = useCallback(
    (segments: MessageSegment[]) => (
      <ProcessBody
        segments={segments}
        events={events}
        settled={processSettled}
        language={turnLanguage}
        isStreaming={isStreaming}
        readingMaterialId={readingMaterialId}
        readingMaterialRevision={readingMaterialRevision}
      />
    ),
    [
      turnLanguage,
      isStreaming,
      readingMaterialId,
      readingMaterialRevision,
      events,
      processSettled,
    ],
  );
  const headerProcessSummary = useMemo(() => {
    if (!headerProcess) return undefined;
    const toolCalls = countProcessToolCalls(headerProcess.segments);
    return toolCalls > 0
      ? `${toolCalls} tool calls`
      : undefined;
  }, [headerProcess]);

  // A turn handed to a partner or an agent is theirs: the header shows them.
  const answerer = useMemo(() => answererOf(events), [events]);

  const researchInProgress =
    outlineStatus === "researching" ||
    outlineStatus === "done" ||
    outlineStatus === "failed";
  const showResearchBody =
    Boolean(outlinePreview) && researchInProgress && Boolean(msg.content);

  return (
    <>
      {/* Activity block pinned to the TOP: the status header
          ("DeepTutor Exploring… · 8s" → "DeepTutor responded. · 10s") with
          the exploring trace nested beneath it — expanded while DeepTutor is
          still working, collapsed once it settles into the final answer. */}
      <AssistantActivity
        events={activityEvents}
        answerer={answerer}
        traceEvents={headerTraceEvents}
        isStreaming={isStreaming}
        content={msg.content}
        // ``events`` is a preview of a persisted turn — the events marking
        // where it began are not in it — so the header times the turn from
        // this span instead of from what survived the preview.
        traceBounds={msg.trace}
        // The settled preview drops ``thinking``, which for a round that
        // called no tools is the whole trace. Say that the server still holds
        // it, so the header stays openable and the click can fetch it.
        hasStoredTrace={Boolean(
          msg.trace?.turn_id &&
            (msg.trace?.truncated ||
              (msg.trace?.total ?? 0) > (msg.events?.length ?? 0)),
        )}
        className="mb-3"
        onTraceToggle={
          msg.id != null && msg.trace?.turn_id
            ? (open) => onTraceToggle?.(msg.id as number, open)
            : undefined
        }
        // The turn's working-out, folded behind this same header. One line of
        // chrome does both jobs: it says what is happening while the turn runs
        // and, once it settles, what it did on the way to the answer.
        processContent={
          headerProcess ? renderSegments(headerProcess.segments) : undefined
        }
        processSummary={headerProcessSummary}
      />
      {outlinePreview && outlinePreview.sub_topics.length > 0 ? (
        <>
          {/* Layout for the merged research bubble:
                1. trace rows (above, via TraceFlow)
                2. ask_user Q&A summary (collapsible once research starts)
                3. Outline editor (auto-collapses once locked)
                4. Final report body (only after research is underway)
              The Q&A intentionally sits ABOVE the outline so the user
              sees the path that produced the outline before the outline
              itself. */}
          {askUserPayload ? (
            <AskUserOptions
              data={askUserPayload}
              onSubmit={submitReply}
              collapsible={researchInProgress}
              defaultCollapsed={researchInProgress}
            />
          ) : null}
          <ResearchOutlineEditor
            outline={outlinePreview.sub_topics}
            topic={outlinePreview.topic}
            onConfirm={(items) =>
              onConfirmOutline?.(
                items,
                outlinePreview.topic,
                outlinePreview.research_config,
                researchRequestSnapshot,
              )
            }
            status={outlineStatus}
          />
          {showResearchBody ? (
            <ReplyBody
              content={msg.content}
              isStreaming={isStreaming}
              language={turnLanguage}
              onSendFollowUp={onSendFollowUp}
              renderMarkdown={renderMarkdown}
            />
          ) : null}
        </>
      ) : notebookTask ? (
        <>
          <NotebookLivePanel
            task={notebookTask}
            events={events}
            isStreaming={isStreaming}
          />
          {msg.content ? (
            <ReplyBody
              content={msg.content}
              isStreaming={isStreaming}
              language={turnLanguage}
              onSendFollowUp={onSendFollowUp}
              renderMarkdown={renderMarkdown}
            />
          ) : null}
        </>
      ) : mathAnimatorResult ? (
        <MathAnimatorViewer result={mathAnimatorResult} />
      ) : visualizeResult ? (
        <VisualizationViewer result={visualizeResult} />
      ) : videoLessonResult ? (
        <>
          <VideoLessonViewer result={videoLessonResult} />
          {msg.content ? (
            <ReplyBody
              content={msg.content}
              isStreaming={isStreaming}
              language={turnLanguage}
              onSendFollowUp={onSendFollowUp}
              renderMarkdown={renderMarkdown}
            />
          ) : null}
        </>
      ) : hasLegacyOgui(msg.content) ? (
        <LegacyOguiMessage
          content={msg.content}
          isStreaming={isStreaming}
          language={turnLanguage}
          onSendFollowUp={onSendFollowUp}
        />
      ) : hasOpenUILang(msg.content) ? (
        // The main chat now answers with OpenUI Lang programs; render them as
        // live components instead of Markdown so dashboards/quizzes/flashcards
        // work here as they did on the removed /openui page. Notebook threads
        // opt out and render the same text with the Markdown renderer instead.
        <ReplyBody
          content={msg.content}
          isStreaming={isStreaming}
          language={turnLanguage}
          onSendFollowUp={onSendFollowUp}
          renderMarkdown={renderMarkdown}
        />
      ) : useSegmentLayout ? (
        // Default chat surface. The working-out (prose interleaved with the
        // steps it introduced) is one layer, folded once the turn settles; the
        // closing answer is the other and always stands plain. Pending cards
        // stay outside the process until the user answers them.
        bodyBlocks.map((block) =>
          block.kind === "process" ? (
            <ProcessFold
              key={block.key}
              segments={block.segments}
              settled={settledIntoAnswer}
            >
              {renderSegments(block.segments)}
            </ProcessFold>
          ) : block.kind === "card" ? (
            block.segment.kind === "mastery_question" ? (
              <div key={block.key}>
                {renderMasteryCard(block.segment.question)}
              </div>
            ) : block.segment.kind === "source_view" ? (
              <MasterySourcePages key={block.key} pages={block.segment.pages} />
            ) : block.segment.kind === "ask_user" ? (
              <AskUserOptions
                key={block.key}
                data={block.segment.data}
                onSubmit={submitReply}
              />
            ) : block.segment.kind === "user_input" ? (
              <SentMidTurn key={block.key} messages={block.segment.messages} />
            ) : null
          ) : block.segment.kind === "text" ? (
            renderMarkdown ? (
              <AssistantResponse
                key={block.key}
                content={block.segment.text}
                isStreaming={isStreaming}
                language={turnLanguage}
                className="dt-note-chat-markdown"
              />
            ) : (
              <OpenUIMessage
                key={block.key}
                content={block.segment.text}
                isStreaming={isStreaming}
                language={turnLanguage}
                onSendFollowUp={onSendFollowUp}
              />
            )
          ) : null,
        )
      ) : (
        <ReplyBody
          content={body}
          isStreaming={isStreaming}
          language={turnLanguage}
          onSendFollowUp={onSendFollowUp}
          renderMarkdown={renderMarkdown}
        />
      )}
      {events.some(event => event.type === "sources" &&
        Array.isArray(event.metadata.sources) && event.metadata.sources.some(source =>
          source && typeof source === "object" &&
          (source.presentation === "teaching" || source.presentation === "reveal"))) &&
        <MasterySourcePresentation events={events} placed={placedSourcePages} />}
      {/* Non-default branches (quiz, math animator, visualize) keep the
          card below the body. The default branch inlines it via
          ``messageSegments``; the research branch renders its own card
          above the outline editor — both skip this fallback. */}
      {!outlinePreview && !hasInlineCards && latestMasteryQuestion
        ? renderMasteryCard(latestMasteryQuestion)
        : null}
      {!outlinePreview &&
      !hasInlineCards &&
      !latestMasteryQuestion &&
      askUserPayload ? (
        <AskUserOptions data={askUserPayload} onSubmit={submitReply} />
      ) : null}
      {/* Credential hand-off sits below whichever body branch rendered: it
          supplements the answer ("here's where to paste the key") rather than
          replacing it, and applies to every branch. */}
      {setupCredential ? <SetupCredentialCard data={setupCredential} /> : null}
      {partnerDraft ? <PartnerDraftCard data={partnerDraft} /> : null}
      {creationDraft ? <CreationDraftCard data={creationDraft} /> : null}
      {masteryHandoffs.length > 0 && <MasteryHandoffCards handoffs={masteryHandoffs} />}
    </>
  );
});

AssistantMessage.displayName = "AssistantMessage";

// Claude-style icon-only message action: a quiet 15px glyph with the label
// in an instant tooltip, brightening on hover.
