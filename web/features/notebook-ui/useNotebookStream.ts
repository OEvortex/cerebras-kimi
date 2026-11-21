"use client";

import { useCallback, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/shared/api/client";

type StreamEvent =
  | { event: "stream"; data: { type?: string; content?: string } }
  | { event: "result"; data: { program?: string } }
  | { event: "error"; data: { detail?: string } };

async function* parseSse(response: Response): AsyncGenerator<StreamEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = frame.split("\n");
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const dataLine = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (dataLine) {
        try {
          const data = JSON.parse(dataLine);
          if (eventName === "stream" || eventName === "result" || eventName === "error") {
            yield { event: eventName, data } as StreamEvent;
          }
        } catch {
          // A partial or malformed frame is not a reason to stop the stream.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function useNotebookStream() {
  const [program, setProgram] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgram("");
    setError("");
    setIsStreaming(false);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const generate = useCallback(async (input: {
    request: string;
    context?: string;
    pageId?: string;
  }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProgram("");
    setError("");
    setIsStreaming(true);
    try {
      const response = await apiFetch(apiUrl("/api/notebook-ui/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.detail || `Request failed (${response.status})`);
      }
      let full = "";
      for await (const frame of parseSse(response)) {
        if (frame.event === "error") {
          throw new Error(frame.data.detail || "The generator failed.");
        }
        if (frame.event === "stream") full += frame.data.content || "";
        if (frame.event === "result" && frame.data.program) full = frame.data.program;
        setProgram(full);
      }
      if (!full.trim()) throw new Error("The model returned no notebook program.");
      return full;
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return "";
      setError(cause instanceof Error ? cause.message : String(cause));
      return "";
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
      }
    }
  }, []);

  return { program, isStreaming, error, generate, cancel, reset };
}
