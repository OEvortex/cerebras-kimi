"use client";

import { useCallback, useState } from "react";
import { useRouter } from "@/shared/router/navigation";
import {
  BookOpenCheck,
  Braces,
  CircleStop,
  Eye,
  Loader2,
  Sparkles,
  WandSparkles,
} from "lucide-react";

import { FeaturePage, PageHeader } from "@/components/layout/FeaturePage";
import { applyNotebookProgram, type ApplyResult } from "./apply";
import NotebookUIView from "./NotebookUIView";
import { useNotebookStream } from "./useNotebookStream";
import "./studio.css";

const EXAMPLES = [
  "A study notebook on photosynthesis with a labelled diagram and a quiz",
  "Linear algebra: vectors, dot products, worked examples and flashcards",
  "The French Revolution: a hub page with a timeline and two subpages",
];

export default function NotebookUIStudio() {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [context, setContext] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [applyError, setApplyError] = useState("");
  const { program, isStreaming, error, generate, cancel, reset } = useNotebookStream();

  const run = useCallback(() => {
    if (!request.trim() && !context.trim()) return;
    setResult(null);
    setApplyError("");
    setShowSource(false);
    void generate({ request: request.trim(), context: context.trim() });
  }, [request, context, generate]);

  const apply = useCallback(async () => {
    if (!program.trim() || isStreaming) return;
    setApplying(true);
    setApplyError("");
    try {
      const applied = await applyNotebookProgram(program);
      setResult(applied);
    } catch (cause) {
      setApplyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  }, [program, isStreaming]);

  return (
    <FeaturePage>
      <PageHeader
        title="Notebook UI"
        description="Describe a notebook and watch the model stream real pages, LaTeX, quizzes and flashcards directly — no tools, no waiting for a background job."
        action={
          <div className="nbs-header-actions">
            {isStreaming ? (
              <button type="button" className="nbs-button nbs-button-quiet" onClick={cancel}>
                <CircleStop size={15} /> Stop
              </button>
            ) : null}
            <button type="button" className="nbs-button" onClick={run} disabled={isStreaming || (!request.trim() && !context.trim())}>
              {isStreaming ? <Loader2 size={15} className="nbs-spin" /> : <Sparkles size={15} />}
              {isStreaming ? "Generating…" : "Generate notebook"}
            </button>
          </div>
        }
      />

      <div className="nbs-grid">
        <section className="nbs-controls" aria-label="Notebook prompt">
          <div className="nbs-card">
            <label className="nbs-label" htmlFor="nbs-request">What should the notebook cover?</label>
            <textarea
              id="nbs-request"
              className="nbs-input"
              rows={5}
              value={request}
              placeholder="e.g. A study notebook on the water cycle with a diagram, a quiz and flashcards"
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") run();
              }}
            />
            <div className="nbs-examples">
              {EXAMPLES.map((example) => (
                <button
                  type="button"
                  key={example}
                  className="nbs-example"
                  onClick={() => setRequest(example)}
                >
                  {example}
                </button>
              ))}
            </div>

            <label className="nbs-label" htmlFor="nbs-context">
              Source material <span className="nbs-optional">optional</span>
            </label>
            <textarea
              id="nbs-context"
              className="nbs-input nbs-input-small"
              rows={4}
              value={context}
              placeholder="Paste notes, an outline or a passage to build the notebook from."
              onChange={(event) => setContext(event.target.value)}
            />

            <div className="nbs-control-row">
              <button type="button" className="nbs-button nbs-button-quiet" onClick={reset} disabled={isStreaming || !program}>
                Clear
              </button>
            </div>
          </div>

          {error ? <div className="nbs-error">{error}</div> : null}

          {program && !isStreaming ? (
            <div className="nbs-card nbs-apply">
              <div className="nbs-apply-heading">
                <BookOpenCheck size={16} /> Save to your notebook
              </div>
              <p className="nbs-apply-note">
                The program above is a preview. Apply it to create real Co-Writer pages.
              </p>
              <div className="nbs-control-row">
                <button type="button" className="nbs-button" onClick={() => void apply()} disabled={applying}>
                  {applying ? <Loader2 size={15} className="nbs-spin" /> : <WandSparkles size={15} />}
                  {applying ? "Saving…" : "Apply to notebook"}
                </button>
              </div>
              {applyError ? <div className="nbs-error">{applyError}</div> : null}
              {result ? (
                <div className="nbs-result">
                  <strong>Created {result.pages.length} page(s):</strong>
                  <ul>
                    {result.pages.map((page) => (
                      <li key={page.id}>
                        <button
                          type="button"
                          className="nbs-link"
                          onClick={() => router.push(`/co-writer/${page.id}`)}
                        >
                          {page.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="nbs-preview" aria-label="Live notebook preview">
          <div className="nbs-preview-bar">
            <span className="nbs-preview-title">
              <Eye size={14} /> Live preview
            </span>
            <span className={`nbs-status ${isStreaming ? "is-live" : ""}`}>
              {isStreaming ? "Streaming" : program ? "Complete" : "Idle"}
            </span>
            <button
              type="button"
              className="nbs-source-toggle"
              onClick={() => setShowSource((value) => !value)}
              disabled={!program}
            >
              <Braces size={14} /> {showSource ? "Hide source" : "Source"}
            </button>
          </div>
          {showSource && program ? (
            <pre className="nbs-source">{program}</pre>
          ) : (
            <div className="nbs-preview-surface">
              <NotebookUIView content={program} isStreaming={isStreaming} />
            </div>
          )}
        </section>
      </div>
    </FeaturePage>
  );
}
