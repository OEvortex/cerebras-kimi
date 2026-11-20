import type { AppLanguage } from "@/context/languages";
import type { ResponseLanguage } from "@/context/languages";
import type { LearningDisplay } from "@/lib/learning-display";
import type {
  Catalog,
  ConnectionTarget,
  ProviderOption,
  ServiceName,
  TaskKindInfo,
} from "@/lib/model-catalog-types";

export type UiSettings = LearningDisplay & {
  theme: "system" | "light" | "dark" | "glass" | "snow";
  language: AppLanguage;
  response_language: ResponseLanguage;
  code_block_theme: string;
  code_block_show_line_numbers: boolean;
  code_block_wrap_long_lines: boolean;
};

export type CodeBlockUiSettings = Pick<
  UiSettings,
  | "code_block_theme"
  | "code_block_show_line_numbers"
  | "code_block_wrap_long_lines"
>;

export type UiSettingsPatch = Partial<UiSettings>;

export type SystemStatus = {
  backend: { status: string; timestamp: string };
  llm: { status: string; model?: string; error?: string };
  embeddings: { status: string; model?: string; error?: string };
  search: { status: string; provider?: string; error?: string };
};

export type EmbeddingCapabilities = {
  detected_dim?: number;
  default_dim?: number;
  supported_dimensions?: number[];
  supports_variable_dimensions?: boolean;
  model_known?: boolean;
  active_dim?: number;
  active_dim_source?: string;
};

export type DiagnosticsResult = {
  state: "success" | "failed";
  message: string;
  profileId: string | null;
  modelId: string | null;
};

export type ServiceReadiness =
  | "not_configured"
  | "untested"
  | "passed"
  | "failed";

/**
 * Where the current settings state lives.
 *   clean   — identical to what is applied
 *   unsaved — edited, not written anywhere yet
 *   saved   — written to the draft store, not applied
 */
export type DraftState = "clean" | "unsaved" | "saved";

/** What the server holds as unapplied. `catalog` comes back redacted. */
export type StoredDraft = {
  version: number;
  updated_at: string;
  catalog: Catalog | null;
  extensions: Record<string, unknown>;
};

export type SettingsPayload = {
  ui: UiSettings;
  catalog?: Catalog;
  providers?: Record<ServiceName, ProviderOption[]>;
  connection_targets?: ConnectionTarget[];
  task_kinds?: TaskKindInfo[];
};

export type TourStep = {
  target: string;
  route: string;
  titleKey: string;
  descKey: string;
};

export interface SettingsExtension {
  dirty: boolean;
  save: () => Promise<void>;
  /**
   * The page's current editable state. Retained by the provider after the
   * page unmounts, so navigating away from a half-edited settings page no
   * longer throws the edit away, and stored in the draft so it survives a
   * reload. Pages that omit it keep the old (lossy) behaviour.
   */
  payload?: unknown;
}
