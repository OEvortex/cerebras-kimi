import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, apiUrl } from "@/shared/api/client";
import type {
  Catalog,
  LlmContextWindowDetection,
  ServiceName,
} from "@/lib/model-catalog-types";
import {
  modelTestFingerprint,
  modelTestKey,
  type ModelTestState,
} from "@/lib/model-settings";
import {
  cloneCatalog,
  readStoredDiagnosticsResults,
  writeStoredDiagnosticsResults,
} from "./catalog-helpers";
import type { DiagnosticsResult, EmbeddingCapabilities } from "./types";

type UseDiagnosticsParams = {
  catalogEditable: boolean | null;
  draft: Catalog;
};

export function useDiagnostics({
  catalogEditable,
  draft,
}: UseDiagnosticsParams) {
  const [logs, setLogs] = useState<string>("");
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>(
    {},
  );
  const testBusyRef = useRef(false);
  const [testRunning, setTestRunning] = useState<ServiceName | null>(null);
  const [diagnosticsResults, setDiagnosticsResults] = useState<
    Partial<Record<ServiceName, DiagnosticsResult>>
  >(() => readStoredDiagnosticsResults());
  const [llmContextDetection, setLlmContextDetection] =
    useState<LlmContextWindowDetection | null>(null);
  const [embeddingCapabilities, setEmbeddingCapabilities] =
    useState<EmbeddingCapabilities | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  useEffect(() => {
    writeStoredDiagnosticsResults(diagnosticsResults);
  }, [diagnosticsResults]);

  useEffect(() => {
    setEmbeddingCapabilities(null);
  }, [
    draft.services.embedding.active_profile_id,
    draft.services.embedding.active_model_id,
  ]);

  const llmActiveProfileId = draft.services.llm.active_profile_id;
  const llmActiveModelId = draft.services.llm.active_model_id;
  useEffect(() => {
    setLlmContextDetection((current) => {
      if (!current) return null;
      if (
        current.profileId === llmActiveProfileId &&
        current.modelId === llmActiveModelId
      ) {
        return current;
      }
      return null;
    });
  }, [llmActiveProfileId, llmActiveModelId]);

  const runDetailedTest = useCallback(
    async (
      service: ServiceName,
      selection?: { profileId: string; modelId?: string },
    ) => {
      if (!catalogEditable || testBusyRef.current) return;
      const diagnosticCatalog = cloneCatalog(draft);
      const target = diagnosticCatalog.services[service];
      const runProfileId = selection?.profileId ?? target.active_profile_id;
      const runModelId =
        service === "search"
          ? null
          : (selection?.modelId ?? target.active_model_id);
      const profile = target.profiles.find((item) => item.id === runProfileId);
      if (
        !profile ||
        (service !== "search" &&
          !profile.models.some(
            (item) => item.id === runModelId && item.model.trim(),
          ))
      ) {
        return;
      }
      if (service === "task") target.mode = "profiles";
      target.active_profile_id = runProfileId;
      if (service !== "search") target.active_model_id = runModelId;
      const key = modelTestKey(service, profile.id, runModelId);
      const fingerprint = modelTestFingerprint(
        draft,
        service,
        profile.id,
        runModelId,
      );
      let finished = false;
      testBusyRef.current = true;
      setTestRunning(service);
      setLogs("");
      setModelTests((current) => ({
        ...current,
        [key]: {
          state: "running",
          fingerprint,
          logs: "",
          message: "Testing model…",
        },
      }));
      const update = (patch: Partial<ModelTestState>) =>
        setModelTests((current) => ({
          ...current,
          [key]: { ...current[key], ...patch },
        }));
      const finish = (state: "success" | "failed", message: string) => {
        if (finished) return;
        finished = true;
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        testBusyRef.current = false;
        setTestRunning(null);
        update({ state, message });
        setDiagnosticsResults((current) => ({
          ...current,
          [service]: {
            state,
            message,
            profileId: profile.id,
            modelId: runModelId ?? null,
          },
        }));
      };
      try {
        const response = await apiFetch(
          apiUrl(`/api/settings/tests/${service}/start`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ catalog: diagnosticCatalog }),
          },
        );
        const payload = await response.json();
        if (!response.ok || !payload.run_id) {
          throw new Error(
            typeof payload.detail === "string"
              ? payload.detail
              : "Could not start diagnostics.",
          );
        }
        const source = new EventSource(
          apiUrl(`/api/settings/tests/${service}/${payload.run_id}/events`),
          { withCredentials: true },
        );
        eventSourceRef.current = source;
        source.onmessage = (event) => {
          if (finished) return;
          try {
            const entry = JSON.parse(event.data);
            const line = `[${entry.type}] ${entry.message || ""}\n`;
            setLogs((current) => current + line);
            setModelTests((current) => ({
              ...current,
              [key]: {
                ...current[key],
                logs: current[key].logs + line,
                message: entry.message || current[key].message,
              },
            }));
            if (entry.type === "response" && entry.snippet) {
              update({ response: entry.snippet });
            }
            if (
              entry.type === "context_window" &&
              Number(entry.context_window) > 0
            ) {
              const context = {
                value: Number(entry.context_window),
                source: entry.source || "metadata",
                detail: entry.detail,
                detectedAt: entry.detected_at,
              };
              update({ context });
              if (service === "llm") {
                setLlmContextDetection({
                  profileId: profile.id,
                  modelId: runModelId ?? null,
                  contextWindow: context.value,
                  source: context.source,
                  detail: context.detail,
                  detectedAt: context.detectedAt,
                });
              }
            }
            if (entry.type === "capabilities") {
              update({
                dimension: entry.detected_dim,
                supportedDimensions: entry.supported_dimensions,
              });
              setEmbeddingCapabilities(entry);
            }
            if (entry.type === "completed") finish("success", entry.message);
            if (entry.type === "failed") finish("failed", entry.message);
          } catch {
            finish("failed", "Could not read the model test result.");
          }
        };
        source.onerror = () =>
          finish("failed", "Diagnostics stream disconnected.");
      } catch (error) {
        finish(
          "failed",
          error instanceof Error
            ? error.message
            : "Could not start diagnostics.",
        );
      }
    },
    [catalogEditable, draft],
  );

  return {
    logs,
    modelTests,
    setModelTests,
    testRunning,
    diagnosticsResults,
    llmContextDetection,
    embeddingCapabilities,
    runDetailedTest,
  };
}
