"use client";

import { useEffect, useState } from "react";

import { CheckCircle2, Loader2, Server, XCircle } from "lucide-react";
import {
  getGraphRagConfig,
  getLightRagConfig,
  getLightRagModelOptions,
  getLightRagServerConfig,
  updateGraphRagConfig,
  updateLightRagConfig,
  updateLightRagServerConfig,
  type GraphRagConfig,
  type LightRagConfig,
  type LightRagServerConfig,
} from "@/features/knowledge/api/engines";
import {
  probeLightRagServer,
  type LightRagServerProbe,
} from "@/features/knowledge/api/connectors";
import { useLLMOptions } from "@/hooks/useLLMOptions";
import LightRagRoleModelsEditor, {
  newRoleModels,
  roleModelsValidationError,
} from "@/components/knowledge/LightRagRoleModelsEditor";
import { selectionFromLightRagDefault } from "@/components/knowledge/IndexingModelSelector";
import {
  FormSkeleton,
  NumberField,
  ResponseTypeSelect,
  SaveButton,
  ToggleField,
  useEngineForm,
} from "./EngineFormPrimitives";

export function GraphRagForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const { form, setLoaded, setForm, saving, setSaving, dirty, patch } =
    useEngineForm<GraphRagConfig>(
      () => getGraphRagConfig({ force: true }),
      onError,
    );

  if (!form) return <FormSkeleton />;

  const save = async () => {
    setSaving(true);
    try {
      const next = await updateGraphRagConfig({
        response_type: form.response_type,
        community_level: form.community_level,
        dynamic_community_selection: form.dynamic_community_selection,
      });
      setLoaded(next);
      setForm(next);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 rounded-2xl border border-[var(--border)] p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ResponseTypeSelect
          value={form.response_type}
          onChange={(v) => patch({ response_type: v })}
        />
        <NumberField
          label={"Community level"}
          hint={"Graph traversal granularity (local / drift)"}
          value={form.community_level}
          min={0}
          max={5}
          onChange={(v) => patch({ community_level: v })}
        />
      </div>
      <ToggleField
        label={"Dynamic community selection"}
        hint={"Global mode only"}
        checked={form.dynamic_community_selection}
        onChange={(v) => patch({ dynamic_community_selection: v })}
      />
      <SaveButton dirty={dirty} saving={saving} onSave={() => void save()} />
    </div>
  );
}

export function LightRagForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const { form, setLoaded, setForm, saving, setSaving, dirty, patch } =
    useEngineForm<LightRagConfig>(
      () => getLightRagConfig({ force: true }),
      onError,
    );

  if (!form) return <FormSkeleton />;
  const save = async () => {
    setSaving(true);
    try {
      const next = await updateLightRagConfig({
        top_k: form.top_k,
        response_type: form.response_type,
        max_concurrent_files: form.max_concurrent_files,
        entity_extract_max_gleaning: form.entity_extract_max_gleaning,
        llm_timeout: form.llm_timeout,
      });
      setLoaded(next);
      setForm(next);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset
      disabled={saving}
      className="space-y-5 rounded-2xl border border-[var(--border)] p-4"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          label={"Results per query"}
          value={form.top_k}
          min={1}
          max={200}
          onChange={(v) => patch({ top_k: v })}
        />
        <ResponseTypeSelect
          value={form.response_type}
          onChange={(v) => patch({ response_type: v })}
        />
      </div>

      {/* Indexing knobs are a separate axis from the two above: they shape how
          a knowledge base is built, so changing them only affects the next
          build — the divider and note keep that from surprising anyone. */}
      <div className="space-y-4 border-t border-[var(--border)] pt-4">
        <div className="space-y-0.5">
          <div className="text-[12px] font-medium text-[var(--foreground)]">
            {"Indexing"}
          </div>
          <div className="text-[11px] text-[var(--muted-foreground)]">
            {"Applies the next time a knowledge base is built or rebuilt."}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label={"Files in parallel"}
            hint={"Higher finishes sooner but uses more memory"}
            value={form.max_concurrent_files}
            min={1}
            max={16}
            onChange={(v) => patch({ max_concurrent_files: v })}
          />
          <NumberField
            label={"Extra extraction passes"}
            hint={"Recovers missed entities; each pass costs another call"}
            value={form.entity_extract_max_gleaning}
            min={0}
            max={5}
            onChange={(v) => patch({ entity_extract_max_gleaning: v })}
          />
          <NumberField
            label={"LLM timeout (seconds)"}
            hint={"Maximum time per LightRAG LLM call"}
            value={form.llm_timeout}
            min={60}
            max={3600}
            onChange={(v) => patch({ llm_timeout: v })}
          />
        </div>
      </div>

      <SaveButton dirty={dirty} saving={saving} onSave={() => void save()} />
    </fieldset>
  );
}

export function LightRagModelsForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const catalog = useLLMOptions(getLightRagModelOptions);
  const { form, setLoaded, setForm, saving, setSaving, dirty, patch } =
    useEngineForm<LightRagConfig>(
      () => getLightRagConfig({ force: true }),
      onError,
    );

  if (!form) return <FormSkeleton />;
  const legacyBase = selectionFromLightRagDefault(
    catalog.options,
    form,
    catalog.activeDefault,
  );
  const legacyOption = catalog.options.find(
    (option) =>
      option.profile_id === legacyBase?.profile_id &&
      option.model_id === legacyBase?.model_id,
  );
  const roleModels =
    form.role_models ??
    (legacyBase
      ? newRoleModels(
          legacyBase,
          form.version !== 2 && legacyOption?.supports_vision === true,
          form.llm_model_max_async,
        )
      : null);
  const validationError = roleModelsValidationError(
    roleModels,
    catalog.options,
  );

  const save = async () => {
    if (!roleModels) {
      onError("Choose a LightRAG base model before saving.");
      return;
    }
    setSaving(true);
    try {
      const next = await updateLightRagConfig({ role_models: roleModels });
      setLoaded(next);
      setForm(next);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset
      disabled={saving}
      className="space-y-4 rounded-2xl border border-[var(--border)] p-4"
    >
      <LightRagRoleModelsEditor
        models={roleModels}
        options={catalog.options}
        initialMaxAsync={form.llm_model_max_async}
        loading={catalog.loading}
        error={catalog.error}
        disabled={saving}
        onChange={(role_models) => patch({ role_models })}
      />
      <p className="text-xs text-[var(--muted-foreground)]">
        {"KEYWORD and QUERY apply to subsequent queries. EXTRACT and VLM apply to new or fully rebuilt indexes; published indexes keep their pinned models."}
      </p>
      {validationError && (
        <p className="text-xs text-red-600">{(validationError)}</p>
      )}
      <SaveButton
        dirty={dirty || (!form.role_models && roleModels !== null)}
        saving={saving}
        invalid={validationError !== null}
        onSave={() => void save()}
      />
    </fieldset>
  );
}

export function LightRagServerForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const [loaded, setLoaded] = useState<LightRagServerConfig | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [probe, setProbe] = useState<LightRagServerProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getLightRagServerConfig({ force: true })
      .then((config) => {
        if (cancelled) return;
        setLoaded(config);
        setServerUrl(config.server_url);
      })
      .catch((err) =>
        onError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      cancelled = true;
    };
  }, [onError]);

  if (!loaded) return <FormSkeleton />;

  const normalizedUrl = serverUrl.trim().replace(/\/+$/, "");
  const dirty = normalizedUrl !== loaded.server_url || apiKey.length > 0;
  const testedCurrentUrl = probe?.ok && probe.base_url === normalizedUrl;

  const test = async () => {
    if (!normalizedUrl) return;
    setProbing(true);
    setProbe(null);
    try {
      setProbe(
        await probeLightRagServer({
          serverUrl: normalizedUrl,
          apiKey,
          useSavedApiKey: !apiKey && loaded.api_key_set,
        }),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const save = async () => {
    if (!testedCurrentUrl) return;
    setSaving(true);
    try {
      const next = await updateLightRagServerConfig({
        server_url: normalizedUrl,
        ...(apiKey ? { api_key: apiKey } : {}),
      });
      setLoaded(next);
      setServerUrl(next.server_url);
      setApiKey("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-[var(--border)] p-4">
      <div>
        <label className="mb-1 block text-[12px] font-medium text-[var(--foreground)]">
          {"Server URL"}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={serverUrl}
            onChange={(event) => {
              setServerUrl(event.target.value);
              setProbe(null);
            }}
            placeholder={"http://localhost:9621"}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12.5px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25"
          />
          <button
            type="button"
            onClick={() => void test()}
            disabled={!normalizedUrl || probing || saving}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--ring)] disabled:opacity-40"
          >
            {probing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Server className="h-3.5 w-3.5" />
            )}
            {"Test connection"}
          </button>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-[var(--foreground)]">
          {"API key"} · {"optional"}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setProbe(null);
          }}
          placeholder={
            loaded.api_key_set
              ? "Saved key · leave blank to keep"
              : "Only if your server requires one"
          }
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12.5px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25"
        />
      </label>

      {probe && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${
            probe.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
          }`}
        >
          {probe.ok ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {probe.ok
              ? "Connected to LightRAG server"
              : probe.error || "Could not connect"}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
        <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
          {"New knowledge bases inherit this connection. You can override it without changing the saved default."}
        </p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || !testedCurrentUrl || saving}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {"Save as default"}
        </button>
      </div>
    </div>
  );
}
