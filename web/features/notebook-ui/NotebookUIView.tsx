"use client";

import "@openuidev/react-ui/styles/index.css";

import React, { useEffect, useMemo, useState } from "react";
import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/intelligent-ui-library";

import { resolveTheme, getStoredThemePreference, subscribeToThemeChanges } from "@/lib/theme";
import { notebookLibrary } from "./notebook-ui-lang/library";
import { toNotebookUIProgram } from "./notebook-ui-lang/lang";

/**
 * Renders a streamed notebook-ui-lang program with the same incremental
 * parser that powers OpenUI chat answers. The shell appears as soon as
 * `root = Notebook(...)` arrives and blocks fill in chunk by chunk.
 */
export default function NotebookUIView({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  const [mode, setMode] = useState<"light" | "dark">(() =>
    resolveTheme(getStoredThemePreference()) === "light" ? "light" : "dark",
  );

  useEffect(() => {
    const update = () => {
      const resolved = resolveTheme(getStoredThemePreference());
      document.documentElement.setAttribute(
        "data-openui-theme",
        resolved === "dark" || resolved === "glass" ? "dark" : "light",
      );
      setMode(resolved === "dark" || resolved === "glass" ? "dark" : "light");
    };
    update();
    return subscribeToThemeChanges(update);
  }, []);

  const program = useMemo(() => toNotebookUIProgram(content), [content]);
  const [rejected, setRejected] = useState<string | null>(null);
  const unrenderable = rejected === program && !isStreaming;

  if (!program.trim()) {
    return <div className="nb-empty">The notebook will appear here as it streams.</div>;
  }

  return (
    <ThemeProvider mode={mode}>
      <div role="article" aria-live="polite" aria-atomic="false" className="nb-render-root">
        {unrenderable ? (
          <div className="nb-parse-error">
            The model returned something that is not a valid notebook program. Show the source below
            to inspect it, or generate again.
          </div>
        ) : (
          <Renderer
            key={unrenderable ? "fallback" : "program"}
            response={program}
            library={notebookLibrary}
            isStreaming={isStreaming}
            onAction={(event: ActionEvent) => {
              // Notebook programs do not need conversational actions today;
              // keep this hook so a future @ToAssistant can be wired up.
              void event;
            }}
            onError={(errors) => {
              if (isStreaming) return;
              if (errors.some((error) => error?.code === "parse-failed")) setRejected(program);
            }}
          />
        )}
      </div>
    </ThemeProvider>
  );
}
