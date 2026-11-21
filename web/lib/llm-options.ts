import { apiFetch, apiUrl } from "@/shared/api/client";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";
import type { LLMSelection } from "@/features/chat/model/protocol";

const LLM_OPTIONS_CACHE_KEY = "llm-options:list";
const DEFAULT_LLM_OPTIONS_TIMEOUT_MS = 30_000;

export interface LLMOption extends LLMSelection {
  profile_name: string;
  model_name: string;
  model: string;
  provider: string;
  /** Human-readable provider name from the registry ("OpenRouter"). */
  provider_label?: string;
  context_window?: number;
  /** Context window / max output from vtx's models.dev metadata. */
  vtx_context_window?: number;
  vtx_max_tokens?: number;
  vtx_supported_reasoning_efforts?: string[];
  vtx_capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean; audio?: boolean };
  reasoning_effort?: string;
  supported_reasoning_efforts?: string[];
  /** The model's own Settings declaration of reasoning support, when present. */
  declared_reasoning?: boolean;
  supports_vision?: boolean;
  is_active_default: boolean;
  /** Present when the model is in vtx's recent_models list. */
  is_recent?: boolean;
}

export interface LLMOptionsResponse {
  active: LLMSelection | null;
  options: LLMOption[];
}

export function llmSelectionKey(selection: LLMSelection | null | undefined) {
  if (!selection?.profile_id || !selection.model_id) return "";
  return `${selection.profile_id}:${selection.model_id}`;
}

export function sameLLMSelection(
  a: LLMSelection | null | undefined,
  b: LLMSelection | null | undefined,
) {
  return llmSelectionKey(a) === llmSelectionKey(b);
}

/** Resolve a selection to a catalog option.
 *
 * Older sessions stored slug-style selections such as
 * ``{ profile_id: "kilo", model_id: "kilo-auto/free" }`` while the catalog now
 * gives saved profiles generated UUID ids. Those selections still run fine
 * (the backend falls back to the provider preset) but match no option, which
 * makes the selector show "Select model" and hides the chosen model. Fall back
 * to a provider + wire-model match so the model is displayed and highlighted.
 */
export function resolveLLMSelection(
  selection: LLMSelection | null | undefined,
  options: LLMOption[],
): LLMOption | null {
  if (!selection) return null;
  const exact = options.find((option) => sameLLMSelection(option, selection));
  if (exact) return exact;
  return (
    options.find(
      (option) =>
        option.provider === selection.profile_id &&
        (option.model === selection.model_id ||
          option.model_name === selection.model_id ||
          option.model_id === selection.model_id),
    ) ?? null
  );
}

/** Rewrite a resolved selection to the catalog's canonical ids, keeping any
 *  reasoning-effort override the user already chose. */
export function canonicalLLMSelection(
  option: LLMOption,
  original: LLMSelection | null | undefined,
): LLMSelection {
  return {
    profile_id: option.profile_id,
    model_id: option.model_id,
    ...(original?.reasoning_effort
      ? { reasoning_effort: original.reasoning_effort }
      : {}),
  };
}

/** The most recent option list any `listLLMOptions` call fetched — no TTL.
 *
 *  Synchronous, so a send path can validate its `llm_selection` against the
 *  catalog without awaiting (or firing) a request (#641): empty until the
 *  first successful load, which callers treat as "option unresolved".
 */
let lastKnownOptions: LLMOption[] = [];

export function readLastKnownLLMOptions(): LLMOption[] {
  return lastKnownOptions;
}

/** List the configured model profiles.
 *
 *  Cached so the many consumers that need the model list (composer, model
 *  picker, capability gate, partner forms) share one round-trip instead of
 *  each firing their own on mount. Editing a profile calls
 *  ``invalidateLLMOptionsCache``; pass ``force`` to bypass the cache. */
export async function listLLMOptions(options?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<LLMOptionsResponse> {
  return withClientCache<LLMOptionsResponse>(
    LLM_OPTIONS_CACHE_KEY,
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options?.timeoutMs ?? DEFAULT_LLM_OPTIONS_TIMEOUT_MS,
      );
      try {
        const response = await apiFetch(apiUrl("/api/settings/llm-options"), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to load LLM options: ${response.status}`);
        }
        const data = (await response.json()) as LLMOptionsResponse;
        lastKnownOptions = Array.isArray(data.options) ? data.options : [];
        return {
          active: data.active ?? null,
          options: lastKnownOptions,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    { force: options?.force },
  );
}

export function invalidateLLMOptionsCache(): void {
  invalidateClientCache(LLM_OPTIONS_CACHE_KEY);
}
