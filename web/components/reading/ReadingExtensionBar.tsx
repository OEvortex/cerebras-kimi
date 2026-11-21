"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Star, X } from "lucide-react";

import { randomUuid } from "@/lib/random-uuid";
import {
  runReadingExtension,
  submitReadingQuizAnswers,
  type ReadingExtensionManifest,
  type ReadingExtensionResult,
  type ReadingQuizReward,
} from "@/lib/reading-api";
import Tooltip from "@/shared/ui/Tooltip";

type VocabularyTerm = {
  term: string;
  meaning: string;
  usage: string;
};

export type QuizHelpContext = {
  selection?: string;
  locator?: number;
  actions: Array<{
    extension: ReadingExtensionManifest;
    action: ReadingExtensionManifest["actions"][number];
  }>;
};

type QuizQuestion = {
  id?: string;
  prompt: string;
  choices: string[];
  can_answer?: boolean;
};

type TranslationResult = {
  translation: string;
  alternatives: string[];
  note: string;
};

export function builtInActionLabel(extensionId: string, actionId: string) {
  if (extensionId === "read_aloud" && actionId === "read") {
    return "Read aloud";
  }
  if (extensionId === "guided_learning" && actionId === "guide") {
    return "Guide me";
  }
  if (extensionId === "vocabulary" && actionId === "explain") {
    return "Explain vocabulary";
  }
  if (extensionId === "quiz" && actionId === "start") {
    return "Quiz me";
  }
  if (extensionId === "translation" && actionId === "translate_en") {
    return "Translate to English";
  }
  if (extensionId === "translation" && actionId === "translate_zh") {
    return "Translate to Chinese";
  }
  return "";
}

export function ExtensionResult({
  result,
  materialId,
  locator,
  sessionId,
  closeLabel,
  onClose,
  onError,
  variant = "strip",
  helpContext,
}: {
  result: ReadingExtensionResult;
  materialId: string;
  locator: number;
  sessionId?: string | null;
  closeLabel: string;
  onClose: () => void;
  onError: (message: string) => void;
  /**
   * `strip` is the band under the toolbar, with its own title and close
   * button. `card` is the body of a companion card, whose header already
   * carries both.
   */
  variant?: "strip" | "card";
  helpContext?: QuizHelpContext;
}) {
  const questions = Array.isArray(result.payload.questions)
    ? (result.payload.questions as QuizQuestion[])
    : [];
  const items = Array.isArray(result.payload.items) ? result.payload.items.map(String) : [];
  const steps = Array.isArray(result.payload.steps) ? result.payload.steps.map(String) : [];
  const terms: VocabularyTerm[] = Array.isArray(result.payload.terms)
    ? result.payload.terms
        .map((row) => {
          if (typeof row !== "object" || row === null) return null;
          const term = row as Partial<VocabularyTerm>;
          return {
            term: String(term.term || ""),
            meaning: String(term.meaning || ""),
            usage: String(term.usage || ""),
          };
        })
        .filter((row): row is VocabularyTerm => row !== null)
    : [];
  const translation: TranslationResult = {
    translation: String(result.payload.translation || ""),
    alternatives: Array.isArray(result.payload.alternatives)
      ? result.payload.alternatives.map(String)
      : [],
    note: String(result.payload.note || ""),
  };
  const body = String(result.payload.body || result.payload.overview || "");
  const card = variant === "card";
  return (
    <section
      className={
        card
          ? "text-[12.5px] leading-relaxed text-[var(--foreground)] [&>*:first-child]:mt-0"
          : "relative mx-3 mb-2 shrink-0 rounded-xl bg-[var(--card)] px-3 py-3 text-xs text-[var(--foreground)] shadow-[var(--dt-shadow-xs,0_0_0_1px_rgba(0,0,0,.06))]"
      }
    >
      {card ? null : (
        <>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="absolute right-2 top-2 text-[var(--muted-foreground)]"
          >
            <X size={14} />
          </button>
          <h3 className="pr-6 font-semibold">{result.title}</h3>
        </>
      )}
      {result.message ? (
        <p className="mt-1 text-[var(--muted-foreground)]">{result.message}</p>
      ) : null}
      {body ? <p className="mt-2 whitespace-pre-wrap">{body}</p> : null}
      {translation.translation ? (
        <p className="mt-2 whitespace-pre-wrap font-medium">{translation.translation}</p>
      ) : null}
      {translation.note ? (
        <p className="mt-1 text-[var(--muted-foreground)]">{translation.note}</p>
      ) : null}
      {translation.alternatives.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--muted-foreground)]">
          {translation.alternatives.map((alternative, index) => (
            <li key={`${index}-${alternative}`}>{alternative}</li>
          ))}
        </ul>
      ) : null}
      {items.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      ) : null}
      {steps.length ? (
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          {steps.map((step, index) => (
            <li key={`${index}-${step}`}>{step}</li>
          ))}
        </ol>
      ) : null}
      {terms.length ? (
        <dl className="mt-2 space-y-2">
          {terms.map((term, index) => (
            <div
              key={`${index}-${term.term}`}
              className="pt-2.5 first:pt-0"
            >
              <dt className="font-medium">{term.term}</dt>
              <dd className="mt-1 text-[var(--muted-foreground)]">{term.meaning}</dd>
              <dd className="mt-1 text-[var(--muted-foreground)]">{term.usage}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {questions.length ? (
        <QuizQuestions
          key={JSON.stringify([materialId, locator, questions.map((question) => question.id)])}
          helpContext={helpContext}
          questions={questions}
          materialId={materialId}
          locator={locator}
          sessionId={sessionId}
          onError={onError}
        />
      ) : null}
    </section>
  );
}

function QuizQuestions({
  questions,
  materialId,
  locator,
  sessionId,
  onError,
  helpContext,
}: {
  questions: QuizQuestion[];
  materialId: string;
  locator: number;
  sessionId?: string | null;
  onError: (message: string) => void;
  helpContext?: QuizHelpContext;
}) {
  
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [verdicts, setVerdicts] = useState<Record<string, boolean>>({});
  const [reward, setReward] = useState<ReadingQuizReward | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [helping, setHelping] = useState<Record<string, boolean>>({});
  const pendingSubmissions = useRef<Record<string, { selected: number; id: string }>>({});

  async function persistAnswer(question: QuizQuestion, index: number, choiceIndex: number) {
    const questionId = question.id || `q_${index + 1}`;
    const key = question.id || String(index);
    const pending = pendingSubmissions.current[key];
    const submissionId = pending?.selected === choiceIndex ? pending.id : randomUuid();
    pendingSubmissions.current[key] = { selected: choiceIndex, id: submissionId };
    setSaving((current) => ({ ...current, [key]: true }));
    try {
      const results = await submitReadingQuizAnswers(materialId, {
        locator,
        session_id: sessionId || "",
        submission_id: submissionId,
        answers: [{ question_id: questionId, selected_index: choiceIndex }],
      });
      const verdict = results.answers.find((item) => item.question_id === questionId);
      if (!verdict) throw new Error("Failed to save answer. Please try again.");
      setAnswers((current) => ({ ...current, [key]: choiceIndex }));
      setVerdicts((current) => ({ ...current, [key]: verdict.is_correct }));
      setReward(results.reward ?? null);
      delete pendingSubmissions.current[key];
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving((current) => ({ ...current, [key]: false }));
    }
  }

  return (
    <>
      {questions.map((question, index) => {
        const key = question.id || String(index);
        const selected = answers[key];
        if (question.can_answer !== true) {
          return (
            <div key={key} className="mt-3">
              <p className="font-medium">{question.prompt}</p>
              <ol className="mt-1 list-inside list-[upper-alpha] space-y-0.5 text-[var(--muted-foreground)]">
                {question.choices.map((choice) => (
                  <li key={choice}>{choice}</li>
                ))}
              </ol>
            </div>
          );
        }
        return (
          <fieldset key={key} className="mt-3">
            <legend className="font-medium">{question.prompt}</legend>
            <div className="mt-1 grid gap-1">
              {question.choices.map((choice, choiceIndex) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={selected === choiceIndex}
                  disabled={Boolean(saving[key] || helping[key])}
                  onClick={() => {
                    void persistAnswer(question, index, choiceIndex);
                  }}
                  className="rounded-md bg-[var(--muted)]/50 px-2 py-1.5 text-left text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] aria-pressed:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] aria-pressed:text-[var(--foreground)]"
                >
                  {String.fromCharCode(65 + choiceIndex)}. {choice}
                </button>
              ))}
            </div>
            {question.id && helpContext ? (
              <QuestionHelp
                questionId={question.id}
                materialId={materialId}
                locator={locator}
                context={helpContext}
                disabled={Boolean(saving[key])}
                onBusyChange={(busy) => setHelping((current) => ({ ...current, [key]: busy }))}
                onError={onError}
              />
            ) : null}
            {selected !== undefined ? (
              <p
                role="status"
                className={`mt-1 font-medium ${
                  verdicts[key]
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {verdicts[key] ? "Correct" : "Incorrect"}
              </p>
            ) : null}
          </fieldset>
        );
      })}
      {reward ? (
        <p
          role="status"
          className="mt-3 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400"
        >
          <Star size={14} fill="currentColor" aria-hidden="true" />
          {`Quiz stars: ${reward.stars}`}
        </p>
      ) : null}
    </>
  );
}

function QuestionHelp({
  questionId, materialId, locator, context, disabled, onBusyChange, onError,
}: {
  questionId: string;
  materialId: string;
  locator: number;
  context: QuizHelpContext;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  
  const [result, setResult] = useState<ReadingExtensionResult | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const active = useRef(true);
  const requests = useRef(new Map<string, string>());
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const actions = context.actions.filter(({ extension, action }) =>
    (extension.id === "guided_learning" && action.id === "guide") ||
    (extension.id === "vocabulary" && action.id === "explain"),
  );
  if (!actions.length) return null;
  const hasSelection = Boolean(context.selection?.trim()) && context.locator === locator;

  async function requestHelp(entry: QuizHelpContext["actions"][number]) {
    if (busyRef.current || disabled || !hasSelection) return;
    const selection = context.selection || "";
    const locale = "en";
    const requestKey = JSON.stringify([entry.extension.id, entry.action.id, selection, locale]);
    const requestId = requests.current.get(requestKey) || randomUuid();
    requests.current.set(requestKey, requestId);
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    try {
      const next = await runReadingExtension(materialId, entry.extension.id, entry.action.id, {
        locator, selection, locale, question_id: questionId, help_request_id: requestId,
      });
      if (!active.current) return;
      const receipt = next.quiz_help;
      if (!receipt || receipt.question_id !== questionId ||
          !Number.isInteger(receipt.hints_used) || receipt.hints_used < 1 ||
          (next.type !== "card" && next.type !== "feedback")) {
        throw new Error("Failed to record help. Please try again.");
      }
      requests.current.delete(requestKey);
      setCount((previous) => Math.max(previous, receipt.hints_used));
      setResult(next);
    } catch (error) {
      if (active.current) onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (active.current) {
        busyRef.current = false;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((entry) => (
          <button
            key={`${entry.extension.id}:${entry.action.id}`}
            type="button"
            disabled={disabled || busy || !hasSelection}
            onClick={() => { void requestHelp(entry); }}
            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
          >
            {entry.extension.id === "guided_learning" ? "Guide me" : "Explain vocabulary"}
          </button>
        ))}
      </div>
      {!hasSelection ? <p className="text-xs text-[var(--muted-foreground)]">{"Select text from this question's reading section first."}</p> : null}
      {busy ? <p role="status">{"Working on it…"}</p> : null}
      {count > 0 ? <p role="status">{`Recorded help: ${count}`}</p> : null}
      {result ? (
        <ExtensionResult
          variant="card" result={result} materialId={materialId} locator={locator}
          closeLabel={"Close"} onClose={() => setResult(null)} onError={onError}
        />
      ) : null}
    </div>
  );
}
