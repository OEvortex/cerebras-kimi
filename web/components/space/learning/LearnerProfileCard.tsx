"use client";

import { UserRound } from "lucide-react";


import type { LearnerProfile } from "@/lib/learning-api";
import { TEACH_FIRST_PROFILE_LABEL } from "./next-step-copy";

/**
 * What the tutor knows about the person learning this goal.
 *
 * Not a fourth asset — the outline, the review plan and the sessions are what
 * the goal *produces*; this is what it was shaped by. It reads back so the
 * learner can catch an answer that is now wrong, and the way to fix one is to
 * say so in a session: the tutor records corrections through `mastery_profile`
 * and reshapes the outline when the correction makes it wrong. An edit form
 * here would be a second writer with no way to do that second half.
 */
export function LearnerProfileCard({ profile }: { profile: LearnerProfile | null }) {
  
  const teachFirst =
    profile?.teaching_strategy === "teach_first" ? TEACH_FIRST_PROFILE_LABEL : "";
  const teachingPreference = [profile?.preferences?.trim(), teachFirst]
    .filter(Boolean)
    .join(" · ");
  const rows: [string, string][] = profile
    ? (
        [
          ["Already knows", profile.prior_knowledge],
          ["Wants to reach", profile.target_level],
          ["Time available", profile.time_budget],
          ["How to teach it", teachingPreference],
          ["Other", profile.notes],
        ] as [string, string][]
      ).filter(([, value]) => value.trim())
    : [];

  return (
    <section className="dt-panel shrink-0 lg:max-h-[46%]">
      <div className="dt-panel-head">
        <UserRound className="h-3.5 w-3.5" />
        <h2>{"About you"}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 pt-1 text-[12.5px] leading-5 text-[var(--muted-foreground)]">
          {"The tutor has not asked about you yet. It will before it designs the outline."}
        </p>
      ) : (
        <dl className="min-h-0 flex-1 overflow-y-auto pb-2">
          {rows.map(([label, value]) => (
            <div key={label} className="px-4 py-2">
              <dt className="text-[11px] text-[var(--muted-foreground)]">
                {label}
              </dt>
              <dd className="mt-0.5 text-[12px] leading-5 text-[var(--foreground)]">
                {value}
              </dd>
            </div>
          ))}
          <p className="px-4 py-2.5 text-[11px] leading-4 text-[var(--muted-foreground)]">
            {"Tell the tutor in a session if any of this has changed."}
          </p>
        </dl>
      )}
    </section>
  );
}
