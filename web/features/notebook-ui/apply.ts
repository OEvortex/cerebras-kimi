"use client";

import { notifyCoWriterChanged } from "@/lib/co-writer-events";
import { noteRequest, type NotePage } from "@/lib/notes-api";
import { compileNotebookProgram, type NotebookPlan } from "@/lib/notebook-ui/lang";

export type ApplyResult = {
  pages: { id: string; title: string }[];
  warnings: string[];
};

/**
 * Turn a finished notebook-ui-lang program into real Co-Writer pages.
 * Page order is preserved; `parent` on a Page resolves to an earlier page in
 * the same program (by title) or to the caller's chosen parent page.
 */
export async function applyNotebookProgram(
  program: string,
  parentPageId: string | null = null,
): Promise<ApplyResult> {
  const plan: NotebookPlan | null = compileNotebookProgram(program);
  if (!plan) throw new Error("The program did not contain a usable Notebook with at least one Page.");

  const byTitle = new Map<string, string>();
  const pages: ApplyResult["pages"] = [];
  const warnings: string[] = [];

  for (const page of plan.pages) {
    const parent = page.parentTitle
      ? byTitle.get(page.parentTitle.toLowerCase()) || parentPageId
      : parentPageId;
    if (page.parentTitle && !byTitle.has(page.parentTitle.toLowerCase()) && !parentPageId) {
      warnings.push(`Parent "${page.parentTitle}" was not found; the page was placed at the notebook root.`);
    }
    const doc = await noteRequest<NotePage>("", {
      title: page.title,
      parent_id: parent || null,
      blocks: page.blocks,
    });
    byTitle.set(page.title.toLowerCase(), doc.id);
    pages.push({ id: doc.id, title: doc.title || page.title });
  }

  notifyCoWriterChanged();
  return { pages, warnings };
}
