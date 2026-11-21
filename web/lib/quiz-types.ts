/**
 * Shared types for Quiz Generation (deep_question capability).
 */

import { decodeEscapedUnicodeForDisplay } from "./markdown-display";
import {
  type NormalizedQuizQuestionType,
  normalizeQuizQuestionType,
} from "./quiz-question-type";

export type DeepQuestionMode = "custom" | "mimic";

export interface DeepQuestionFormConfig {
  mode: DeepQuestionMode;
  topic: string;
  num_questions: number;
  difficulty: string;
  /**
   * Multi-select allowed-types whitelist. Empty list = "auto" (planner
   * picks any type per question). When ≥1 type is selected, the planner
   * is restricted to those types.
   */
  question_types: NormalizedQuizQuestionType[];
  /**
   * Per-type quantity targets (sums to num_questions when non-empty).
   * Only populated when ≥2 types are selected and the user has tweaked
   * the ratio bar; empty means "distribute evenly across allowed types".
   */
  per_type_counts: Partial<Record<NormalizedQuizQuestionType, number>>;
  paper_path: string;
  max_questions: number;
}

export interface QuizQuestion {
  question_id: string;
  question: string;
  question_type: NormalizedQuizQuestionType;
  options?: Record<string, string>;
  correct_answer: string;
  explanation: string;
  difficulty?: string;
  concentration?: string;
  knowledge_context?: string;
}

export interface QuizFollowupContext {
  parent_quiz_session_id?: string;
  question_id: string;
  question: string;
  question_type: QuizQuestion["question_type"];
  options?: Record<string, string>;
  correct_answer: string;
  explanation: string;
  difficulty?: string;
  concentration?: string;
  knowledge_context?: string;
  user_answer?: string;
  is_correct?: boolean;
  /**
   * Filenames of the images the learner attached as their answer. Image
   * bytes ride on the first follow-up message as regular attachments so
   * vision-capable models see them; the filenames here let the follow-up
   * system prompt mention them explicitly so the LLM knows the attached
   * images are the learner's answer, not unrelated context.
   */
  user_answer_image_filenames?: string[];
  /** Latest AI judgment text for this question, when one has been run. */
  ai_judgment?: string;
}

/** Decode dense ``\\uXXXX`` runs on learner-facing quiz strings (#973 family). */
function decodeQuizText(value: string | undefined | null): string {
  return decodeEscapedUnicodeForDisplay(String(value ?? ""));
}

function decodeQuizOptions(
  options: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!options || typeof options !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    out[key] = decodeQuizText(value);
  }
  return out;
}

function buildQuizQuestionFromQa(qa: Record<string, unknown>): QuizQuestion {
  return {
    question_id: String(qa.question_id ?? ""),
    question: decodeQuizText(qa.question as string | undefined | null),
    question_type: normalizeQuizQuestionType(qa.question_type),
    options: decodeQuizOptions(qa.options as Record<string, string> | undefined),
    correct_answer: decodeQuizText(qa.correct_answer as string | undefined | null),
    explanation: decodeQuizText(qa.explanation as string | undefined | null),
    difficulty: qa.difficulty ? String(qa.difficulty) : undefined,
    concentration: qa.concentration ? String(qa.concentration) : undefined,
    knowledge_context:
      qa.metadata &&
      typeof qa.metadata === "object" &&
      "knowledge_context" in qa.metadata &&
      qa.metadata.knowledge_context
        ? decodeQuizText(String(qa.metadata.knowledge_context))
        : undefined,
  };
}

/**
 * Extract QuizQuestion[] from per-question ``content`` events emitted live
 * by the new ``QuestionPipeline`` while the quizzing phase is running.
 *
 * The backend tags each event with ``metadata.call_kind ===
 * "quiz_question_emitted"`` and the structured ``qa_pair`` payload. We
 * collect them, dedupe by ``question_id``, and order by
 * ``question_index`` so QuizViewer can render each question the moment
 * it lands — without waiting for the final ``result`` event.
 *
 * Returns ``null`` until at least one valid quiz event has arrived, so
 * the caller can fall back to the legacy ``extractQuizQuestions`` shape
 * for older (mimic) result envelopes.
 */

/**
 * Resolve the turn identity of a quiz message from its event stream.
 *
 * Quiz answer state is scoped per turn: the notebook unique key is
 * ``(session_id, turn_id, question_id)`` and positional question ids
 * (``q_1``..``q_N``) repeat across quizzes in one session. During
 * generation the final ``result`` event hasn't landed yet, so the turn id
 * must come from the streamed events themselves — every unified-WS event
 * carries ``turn_id``. The ``result`` event stays authoritative when
 * present so the settled/persisted path is unchanged (issues #487 / #677).
 *
 * Returns ``null`` only for legacy persisted turns whose events predate
 * ``turn_id``; QuizViewer renders those cards local-only (no notebook
 * reads or writes), so they can never inherit another turn's answers.
 */

/**
 * Extract QuizQuestion[] from the raw `result` event metadata returned by
 * the deep_question capability.
 */
export function extractQuizQuestions(
  resultMetadata: Record<string, unknown> | undefined,
): QuizQuestion[] | null {
  if (!resultMetadata) return null;
  const summary = resultMetadata.summary as Record<string, unknown> | undefined;
  if (!summary) return null;
  const results = summary.results as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(results) || results.length === 0) return null;

  const parsed: Array<QuizQuestion | null> = results.map((item) => {
    const qa = (item.qa_pair ?? item) as Record<string, unknown>;
    if (!qa.question) return null;
    return buildQuizQuestionFromQa(qa);
  });

  return parsed.filter(
    (question): question is QuizQuestion => question !== null,
  );
}

export interface QuizFollowupExtras {
  /** Filenames of the learner's image answers (bytes ride on first msg). */
  userAnswerImageFilenames?: string[] | null;
  /** Last AI-judgment text for this question, if the learner ran it. */
  aiJudgment?: string | null;
}

export function buildQuizFollowupConfig(
  question: QuizQuestion,
  userAnswer: string,
  isCorrect: boolean | null,
  parentQuizSessionId?: string | null,
  extras?: QuizFollowupExtras,
): Record<string, unknown> {
  const filenames = (extras?.userAnswerImageFilenames ?? [])
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0);
  const context: QuizFollowupContext = {
    question_id: question.question_id,
    question: question.question,
    question_type: question.question_type,
    options: question.options,
    correct_answer: question.correct_answer,
    explanation: question.explanation,
    difficulty: question.difficulty,
    concentration: question.concentration,
    knowledge_context: question.knowledge_context,
    user_answer: userAnswer || undefined,
    is_correct: typeof isCorrect === "boolean" ? isCorrect : undefined,
    parent_quiz_session_id: parentQuizSessionId || undefined,
    user_answer_image_filenames: filenames.length > 0 ? filenames : undefined,
    ai_judgment: extras?.aiJudgment?.trim() || undefined,
  };

  return {
    followup_question_context: context,
  };
}

function titleCase(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const QUIZ_TYPE_LABEL_KEYS: Record<NormalizedQuizQuestionType, string> =
  {
    choice: "Multiple Choice",
    concept: "Concept Question",
    fill_in_blank: "Fill in the Blank",
    short_answer: "Short Answer",
    written: "Essay",
    coding: "Coding",
  };

/**
 * One-line summary of the quiz form, shown next to the collapsed `Settings`
 * chevron in the composer. The summary is always in English.
 */

/**
 * Build the `config` payload to send over WebSocket for a quiz generation
 * request.
 */

