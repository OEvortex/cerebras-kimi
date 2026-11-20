"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import {
  getLearnerProfile,
  setLearnerProfile,
  type LearnerProfile,
} from "@/lib/admin-api";

const fields: Array<keyof LearnerProfile> = [
  "age",
  "grade_level",
  "curriculum",
  "reading_level",
  "explanation_style",
];

const fieldLabels: Record<(typeof fields)[number], string> = {
  age: "Age",
  grade_level: "Grade level",
  curriculum: "Curriculum",
  language: "Language",
  reading_level: "Reading level",
  explanation_style: "Explanation style",
};

export function LearnerProfileEditor({ username }: { username: string }) {
  
  const [profile, setProfile] = useState<LearnerProfile>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void getLearnerProfile(username)
      .then((value) => {
        if (active) setProfile(value ?? {});
      })
      .catch(() => {
        if (active) setMessage("Failed to load learner profile");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [username]);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const updated = await setLearnerProfile(username, profile);
      setProfile(updated ?? {});
      setMessage("Saved");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to save learner profile",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--background)]/40 px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--foreground)]">
            {"Learner Profile"}
          </h3>
          <p className="text-xs text-[var(--muted-foreground)]">
            {"Adapt explanations to this learner"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] disabled:opacity-50"
        >
          {saving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          {"Save"}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <label key={field} className="text-xs text-[var(--muted-foreground)]">
            {(fieldLabels[field])}
            <input
              value={profile[field] ?? ""}
              onChange={(event) =>
                setProfile((current) => ({
                  ...current,
                  [field]:
                    field === "age"
                      ? event.target.value
                        ? Number(event.target.value)
                        : undefined
                      : event.target.value || undefined,
                }))
              }
              type={field === "age" ? "number" : "text"}
              min={field === "age" ? 3 : undefined}
              max={field === "age" ? 120 : undefined}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm text-[var(--foreground)]"
            />
          </label>
        ))}
      </div>
      {message && (
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">{message}</p>
      )}
    </div>
  );
}
