"use client";

import { Check, X } from "lucide-react";


import type { ObjectiveReport } from "@/lib/learning-api";

import { formatAbsolute, formatRelative } from "./format";

/**
 * The evidence behind one objective.
 *
 * The map answers "am I through the gate"; this answers "why" — which
 * questions were asked, what the learner said, what the engine did with it,
 * and when it comes back for review. The gate itself is shown as a bar with
 * the threshold marked, because a hard gate is only legible if you can see how
 * far away it is.
 */
export function ObjectiveDetail({
  report,
}: {
  report: ObjectiveReport;
}) {
  
  const qualitative = report.gate === "qualitative";
  const evidence = report.evidence ?? [];
  const evidenceCount = report.evidence_count ?? evidence.length;
  return (
    <div className="mt-1 mb-2 ml-5 space-y-3 border-l border-[var(--border)] pl-3">
      <GateBar report={report} />

      {report.review && (
        <Row label={"Spaced review"}>
          {report.review.due_at
            ? `Due ${formatRelative(report.review.due_at)} · ${formatAbsolute(report.review.due_at)}`
            : "Not scheduled"}
          <span className="ml-2 text-[var(--muted-foreground)]">
            {`memory ${Math.round(report.review.retrievability * 100)}% · stability ${report.review.stability.toFixed(1)} days`}
          </span>
          <span className="block text-[var(--muted-foreground)]">
            {`risk ${Math.round(report.review.forgetting_risk * 100)}% · ${report.review.lapse_count} lapses`}
          </span>
          {report.review.reason && (
            <span className="block text-[var(--muted-foreground)]">
              {report.review.reason}
            </span>
          )}
        </Row>
      )}

      {qualitative && report.explanation && (
        <Row label={"Your explanation"}>
          <span className="italic">{report.explanation}</span>
        </Row>
      )}

      {report.attempts.length > 0 && (
        <div>
          <div className="text-xs text-[var(--muted-foreground)]">
            {`Attempts (${report.correct_count}/${report.attempts.length} correct)`}
          </div>
          <ul className="mt-1 space-y-1.5">
            {[...report.attempts].reverse().map((attempt, index) => (
              <li
                key={`${attempt.question_id}-${index}`}
                className="flex gap-2 text-xs"
              >
                {attempt.is_correct ? (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                ) : (
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                )}
                <div className="min-w-0">
                  <div className="text-[var(--foreground)]">
                    {attempt.prompt || "(prompt unavailable)"}
                  </div>
                  <div className="text-[var(--muted-foreground)]">
                    {"You said: "}
                    {attempt.answer || "(blank)"}
                    <span className="ml-2">
                      {formatRelative(attempt.at)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.errors.length > 0 && (
        <Row label={"Error diagnosis"}>
          {report.errors.map((record) => (
            <span key={record.id} className="mr-2">
              {(record.error_type)}
              {record.retries > 0 &&
                ` · ${record.retries} retries`}
              {record.status === "graduated" && " · cleared"}
            </span>
          ))}
        </Row>
      )}

      {report.explained && <Row label={"Explained"}>{report.explained.summary}</Row>}
      {!!report.required_visual_tasks?.length && <Row label={"Independent visual evidence"}>{report.demonstrated_visual_tasks?.length ?? 0} / {report.required_visual_tasks.length}</Row>}
      {!!report.required_visual_tasks?.some((task) => !report.demonstrated_visual_tasks?.includes(task)) && <p className="text-xs text-[var(--muted-foreground)]">{"Independent visual evidence is still required for this objective."}</p>}
      {report.attempts.some((attempt) => attempt.independent === false) && <p className="text-xs text-[var(--muted-foreground)]">{"Assisted practice is recorded separately from independent mastery."}</p>}
      {evidence.length > 0 && (
        <div>
          <div className="text-xs text-[var(--muted-foreground)]">
            {`Retention evidence (${evidenceCount})`}
          </div>
          <ul className="mt-1 space-y-1">
            {evidence.map((evidence, index) => (
              <li
                key={`${evidence.timestamp}-${evidence.turn_id || index}`}
                className="flex items-center justify-between gap-2 text-[11px] text-[var(--muted-foreground)]"
              >
                <span>
                  {(evidence.result)} · {(evidence.assessment_type)}
                  {evidence.visual_context?.task && ` · ${"Visual practice"}${evidence.hints_used ? ` · ${"Assisted"}` : ""}`}
                  {evidence.quality !== null &&
                    ` · ${Math.round(evidence.quality * 100)}%`}
                </span>
                <span className="shrink-0">{formatRelative(evidence.timestamp)}</span>
              </li>
            ))}
          </ul>
          {evidenceCount > evidence.length && (
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
              {"Showing the latest 20 events"}
            </p>
          )}
        </div>
      )}

      {report.attempts.length === 0 && !report.explanation && (
        <p className="text-xs text-[var(--muted-foreground)]">
          {"No attempts yet. Once you work through this waypoint, its questions, your answers, and the grading evidence will appear here."}
        </p>
      )}
    </div>
  );
}

/** Mastery against the gate it has to clear. */
function GateBar({ report }: { report: ObjectiveReport }) {
  
  const qualitative = report.gate === "qualitative";
  // A qualitative gate is a boolean, so all-or-nothing is the only honest
  // fill. `mastery` carries quiz accuracy for these objectives too, and
  // drawing that as gate progress is how a waypoint comes to show a full bar
  // beside a hollow dot — the learner reads "100%, still not cleared".
  const pct = qualitative
    ? report.mastered
      ? 100
      : 0
    : Math.round(report.mastery * 100);
  const thresholdPct = Math.round(report.threshold * 100);
  const perfectButBelowGate =
    report.gate === "quantitative" &&
    report.attempts.length > 0 &&
    report.correct_count === report.attempts.length &&
    report.mastery < report.threshold;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-[var(--muted-foreground)]">
          {report.gate === "qualitative"
            ? "Qualitative gate: explain it in your own words"
            : `Quantitative gate: ${thresholdPct}%`}
        </span>
        <span
          className={
            report.mastered
              ? "text-green-500"
              : "text-[var(--muted-foreground)]"
          }
        >
          {pct}%
        </span>
      </div>
      <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--accent)]">
        <div
          className={`h-full ${report.mastered ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]"}`}
          style={{ width: `${pct}%` }}
        />
        {report.gate === "quantitative" && (
          <div
            className="absolute inset-y-0 w-px bg-[var(--foreground)]/40"
            style={{ left: `${thresholdPct}%` }}
          />
        )}
      </div>
      {perfectButBelowGate && (
        <p className="mt-1.5 text-[11px] leading-4 text-[var(--muted-foreground)]">
          {`Even with ${report.correct_count}/${report.attempts.length} correct so far, mastery also weighs evidence volume, difficulty, and recent consistency. One more discriminating practice can raise it further.`}
        </p>
      )}
      {qualitative && !report.mastered && report.attempts.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-4 text-[var(--muted-foreground)]">
          {"Practice questions do not open this gate — it opens when you explain the idea in your own words and your tutor records that. Your answers here still count as practice."}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="text-xs">
      <div className="text-[var(--muted-foreground)]">{label}</div>
      <div className="mt-0.5 text-[var(--foreground)]">{children}</div>
    </div>
  );
}
