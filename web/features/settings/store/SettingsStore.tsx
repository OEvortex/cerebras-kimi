"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "@/shared/router/navigation";


import {
  recoveryPrincipal,
  RECOVERY_PRINCIPAL_CHANGED,
} from "@/lib/recovery-principal";
import {
  DEFAULT_LEARNING_DISPLAY,
  normalizeLearningDisplay,
  publishLearningDisplay,
  type LearningDisplay,
} from "@/lib/learning-display";

import type { CodeBlockThemeId } from "@/components/common/code-block-themes";
import {
  normalizeCodeBlockTheme,
  normalizeLanguage,
  writeStoredCodeBlockShowLineNumbers,
  writeStoredCodeBlockTheme,
  writeStoredCodeBlockWrapLongLines,
  writeStoredLanguage,
  writeStoredResponseLanguage,
} from "@/context/app-shell-storage";
import { useAppShell } from "@/context/AppShellContext";
import { englishLabel } from "@/lib/english-labels";
import { apiFetch, apiUrl } from "@/shared/api/client";
import { applyExtensionPayload } from "@/lib/settings-extensions";
import {
  getStoredThemePreference,
  setTheme as applyThemePreference,
} from "@/lib/theme";
import type { IncompleteModel, ModelTestState } from "@/lib/model-settings";
import type { RegistryEdit } from "@/lib/provider-registry";
import type {
  Catalog,
  CatalogConnection,
  CatalogModel,
  CatalogProfile,
  ConnectionTarget,
  LlmContextWindowDetection,
  ModelCapabilityKey,
  ProviderOption,
  ServiceName,
  TaskKindInfo,
} from "@/lib/model-catalog-types";

export { CONNECTABLE_SERVICES } from "@/lib/model-catalog-types";
export type {
  ProviderRef,
  Discovery,
  ServiceName,
  ModelCapabilities,
  ModelCapabilityKey,
  ApiFormat,
  CatalogModel,
  LlmContextWindowDetection,
  CatalogProfile,
  CatalogService,
  CatalogTaskOverride,
  TaskKindInfo,
  CatalogConnection,
  ConnectionTargetService,
  ConnectionTarget,
  Catalog,
  ProviderOption,
} from "@/lib/model-catalog-types";

export {
  RESPONSE_LANGUAGE_OPTIONS,
  type ResponseLanguageOption,
} from "./response-language-options";

export type {
  UiSettings,
  SystemStatus,
  EmbeddingCapabilities,
  DiagnosticsResult,
  ServiceReadiness,
  DraftState,
  StoredDraft,
  TourStep,
  SettingsExtension,
} from "./types";

export {
  TOUR_STEPS,
  cloneCatalog,
  voiceService,
  generationService,
  defaultCatalog,
  getActiveProfile,
  getActiveModel,
  serviceConfigured,
  currentDiagnosticsResult,
  serviceReadiness,
  servicePendingApply,
} from "./catalog-helpers";

import type {
  CodeBlockUiSettings,
  DiagnosticsResult,
  DraftState,
  EmbeddingCapabilities,
  SettingsExtension,
  SettingsPayload,
  StoredDraft,
  SystemStatus,
  UiSettings,
  UiSettingsPatch,
} from "./types";
import {
  TOUR_STEPS,
  cloneCatalog,
  defaultCatalog,
  withoutUnconfirmedTheme,
} from "./catalog-helpers";
import { useCatalogActions } from "./useCatalogActions";
import { useDiagnostics } from "./useDiagnostics";
import { useDraftLifecycle } from "./useDraftLifecycle";

export function syncLoadedCodeBlockSettingsToAppShell(
  ui: Partial<CodeBlockUiSettings>,
): CodeBlockUiSettings {
  const normalized = {
    code_block_theme: normalizeCodeBlockTheme(ui.code_block_theme),
    code_block_show_line_numbers:
      ui.code_block_show_line_numbers === true ||
      String(ui.code_block_show_line_numbers).toLowerCase() === "true",
    code_block_wrap_long_lines:
      ui.code_block_wrap_long_lines === true ||
      String(ui.code_block_wrap_long_lines).toLowerCase() === "true",
  };

  writeStoredCodeBlockTheme(normalized.code_block_theme);
  writeStoredCodeBlockShowLineNumbers(normalized.code_block_show_line_numbers);
  writeStoredCodeBlockWrapLongLines(normalized.code_block_wrap_long_lines);

  return normalized;
}

export async function persistUiSettingsPatch(
  patch: UiSettingsPatch,
  fetcher: typeof apiFetch = apiFetch,
): Promise<void> {
  await fetcher(apiUrl("/api/settings/ui"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// ─── Context ───────────────────────────────────────────────────────────────

export type SettingsContextValue = {
  // State
  catalog: Catalog;
  draft: Catalog;
  status: SystemStatus | null;
  providers: Record<ServiceName, ProviderOption[]>;
  catalogEditable: boolean | null;
  settingsLoading: boolean;
  settingsError: string | null;
  reloadSettings: () => Promise<void>;
  hasUnsavedChanges: boolean;
  theme: UiSettings["theme"];
  language: UiSettings["language"];
  responseLanguage: UiSettings["response_language"];
  codeBlockTheme: UiSettings["code_block_theme"];
  codeBlockShowLineNumbers: UiSettings["code_block_show_line_numbers"];
  codeBlockWrapLongLines: UiSettings["code_block_wrap_long_lines"];
  contentFontScale: LearningDisplay["content_font_scale"];
  contentLineSpacing: LearningDisplay["content_line_spacing"];
  toast: string;
  setToast: (value: string) => void;
  /** A blank model Apply refused, so its own page can open that row. */
  focusModel: IncompleteModel | null;
  clearFocusModel: () => void;

  // UI prefs
  updateTheme: (next: UiSettings["theme"]) => Promise<void>;
  updateLanguage: (next: UiSettings["language"]) => Promise<void>;
  updateResponseLanguage: (
    next: UiSettings["response_language"],
  ) => Promise<void>;
  updateCodeBlockTheme: (next: CodeBlockThemeId) => Promise<void>;
  updateCodeBlockShowLineNumbers: (next: boolean) => Promise<void>;
  updateCodeBlockWrapLongLines: (next: boolean) => Promise<void>;

  updateContentFontScale: (
    next: LearningDisplay["content_font_scale"],
  ) => Promise<void>;
  updateContentLineSpacing: (
    next: LearningDisplay["content_line_spacing"],
  ) => Promise<void>;
  resetLearningText: () => Promise<void>;

  // Catalog mutation
  mutateCatalog: (mutator: (next: Catalog) => void) => void;
  addProfile: (service: ServiceName) => void;
  /** Omitting the id targets whatever is in use — the historical meaning. */
  removeActiveProfile: (service: ServiceName, profileId?: string) => void;
  addModel: (service: ServiceName, profileId?: string) => void;
  removeActiveModel: (
    service: ServiceName,
    profileId?: string,
    modelId?: string,
  ) => void;
  updateProfileField: (
    service: ServiceName,
    field: keyof CatalogProfile,
    value: string,
    profileId?: string,
  ) => void;
  updateModelField: (
    service: ServiceName,
    field: keyof CatalogModel,
    value: string,
    profileId?: string,
    modelId?: string,
  ) => void;
  updateModelBoolField: (
    service: ServiceName,
    field: keyof CatalogModel,
    value: boolean,
    profileId?: string,
    modelId?: string,
  ) => void;
  updateContextWindowField: (
    value: string,
    profileId?: string,
    modelId?: string,
  ) => void;
  updateReasoningEffort: (
    value: string,
    profileId?: string,
    modelId?: string,
  ) => void;
  /** `null` clears the override so the built-in tables decide again. */
  updateModelCapability: (
    service: ServiceName,
    key: ModelCapabilityKey,
    value: boolean | null,
    profileId?: string,
    modelId?: string,
  ) => void;

  // Connections + task models
  connectionTargets: ConnectionTarget[];
  /** The calls DeepTutor makes on its own, in the order the backend lists them. */
  taskKinds: TaskKindInfo[];
  connectionTarget: (provider: string) => ConnectionTarget | null;
  addConnection: (input: {
    provider: string;
    name: string;
    api_key: string;
    base_url: string;
  }) => CatalogConnection;
  updateConnectionField: (
    id: string,
    field: keyof CatalogConnection,
    value: string,
  ) => void;
  removeConnection: (id: string) => void;
  unlinkProfile: (service: ServiceName, profileId: string) => void;
  linkConnectionToServices: (
    connection: Pick<
      CatalogConnection,
      "id" | "provider" | "name" | "api_key" | "base_url"
    >,
    requests: { service: ServiceName; model: string }[],
  ) => { created: ServiceName[]; activated: ServiceName[] };
  llmContextDetection: LlmContextWindowDetection | null;
  applyDetectedContextWindow: () => void;

  // Save / apply
  saving: boolean;
  applying: boolean;
  saveDraft: () => Promise<boolean | null>;
  applyCatalog: () => Promise<void>;
  /** Promote one model service without applying unrelated Settings drafts. */
  applyService: (service: ServiceName) => Promise<boolean>;
  saveRegistry: (edit: RegistryEdit) => Promise<boolean>;
  saveProvider: (service: ServiceName, profileId: string) => Promise<boolean>;
  discardDraft: () => Promise<void>;
  /** Stage a named Settings preset as a reviewable draft. */
  stagePreset: (presetId: string) => Promise<boolean>;
  /** A draft parked on the server, waiting to be applied. */
  storedDraft: StoredDraft | null;
  draftState: DraftState;
  /** Bumped when a draft is discarded so pages re-read from the server. */
  draftRevision: number;
  pendingExtensionPayload: (key: string) => unknown;

  // Sub-page extension hooks.
  registerExtension: (key: string, ext: SettingsExtension | null) => void;

  // Diagnostics
  modelTests: Record<string, ModelTestState>;
  logs: string;
  testRunning: ServiceName | null;
  diagnosticsResults: Partial<Record<ServiceName, DiagnosticsResult>>;
  embeddingCapabilities: EmbeddingCapabilities | null;
  runDetailedTest: (
    service: ServiceName,
    selection?: { profileId: string; modelId?: string },
  ) => Promise<void>;

  // Helpers
  embeddingDefaultDim: (binding?: string) => string;

  // Tour
  tourStepIndex: number;
  startTour: () => void;
  advanceTour: () => void;
  goBackTour: () => void;
  skipTour: () => void;

  // Which leaf is on screen inside a merged category page.
  activeSection: string | null;
  setActiveSection: (key: string | null) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used inside <SettingsProvider>");
  }
  return ctx;
}

// ─── Provider ──────────────────────────────────────────────────────────────

export function SettingsProvider({ children }: { children: ReactNode }) {
  
  const router = useRouter();
  const {
    codeBlockTheme,
    codeBlockShowLineNumbers,
    codeBlockWrapLongLines,
  } = useAppShell();

  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [theme, setTheme] = useState<UiSettings["theme"]>("system");
  const serverThemeLoadedRef = useRef(false);
  const serverDisplayLoadedRef = useRef(false);
  const settingsGenerationRef = useRef(0);
  const captureSettingsOwnership = useCallback(() => {
    const owner = recoveryPrincipal();
    const generation = settingsGenerationRef.current;
    return () =>
      generation === settingsGenerationRef.current &&
      owner === recoveryPrincipal();
  }, []);
  const initialSettingsSettledRef = useRef(false);
  const awaitingInitialPrincipalRef = useRef(recoveryPrincipal() === null);
  const displayOwnerRef = useRef<string | null | undefined>(undefined);
  const [learningDisplay, setLearningDisplay] = useState(
    DEFAULT_LEARNING_DISPLAY,
  );
  const stageUiRef = useRef<(patch: Partial<UiSettings>) => Promise<void>>(
    async () => {},
  );
  const [language, setLanguage] = useState<UiSettings["language"]>("en");
  const [responseLanguage, setResponseLanguage] =
    useState<UiSettings["response_language"]>("en");
  const [catalog, setCatalog] = useState<Catalog>(defaultCatalog());
  const [draft, setDraft] = useState<Catalog>(defaultCatalog());
  const [catalogEditable, setCatalogEditable] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<
    Record<ServiceName, ProviderOption[]>
  >({
    llm: [],
    task: [],
    embedding: [],
    search: [],
    tts: [],
    stt: [],
    imagegen: [],
    videogen: [],
  });
  const [connectionTargets, setConnectionTargets] = useState<
    ConnectionTarget[]
  >([]);
  const [taskKinds, setTaskKinds] = useState<TaskKindInfo[]>([]);
  const [storedDraft, setStoredDraft] = useState<StoredDraft | null>(null);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [focusModel, setFocusModel] = useState<IncompleteModel | null>(null);
  const clearFocusModel = useCallback(() => setFocusModel(null), []);
  const [tourStepIndex, setTourStepIndex] = useState(-1);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const extensionsRef = useRef<Map<string, SettingsExtension>>(new Map());
  const pendingRef = useRef<Map<string, unknown>>(new Map());
  const [pendingSignature, setPendingSignature] = useState("{}");
  const syncPendingKeys = useCallback(() => {
    const entries = Array.from(pendingRef.current.entries()).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const next = JSON.stringify(Object.fromEntries(entries));
    setPendingSignature((current) => (current === next ? current : next));
  }, []);

  const registerExtension = useCallback(
    (key: string, ext: SettingsExtension | null) => {
      const map = extensionsRef.current;
      if (ext === null) {
        map.delete(key);
        return;
      }
      map.set(key, ext);
      if (ext.dirty) {
        if (ext.payload !== undefined) pendingRef.current.set(key, ext.payload);
      } else if (ext.payload != null) {
        pendingRef.current.delete(key);
      }
      syncPendingKeys();
    },
    [syncPendingKeys],
  );

  const pendingExtensionPayload = useCallback(
    (key: string) => pendingRef.current.get(key),
    [],
  );

  const clearPending = useCallback(
    (applied?: Map<string, unknown>) => {
      for (const [key, payload] of pendingRef.current) {
        if (!applied || (applied.has(key) && applied.get(key) === payload)) {
          pendingRef.current.delete(key);
        }
      }
      for (const [key, ext] of extensionsRef.current) {
        if (!applied || (applied.has(key) && applied.get(key) === ext.payload)) {
          ext.dirty = false;
        }
      }
      syncPendingKeys();
    },
    [syncPendingKeys],
  );

  const loadSettings = useCallback(async () => {
    const displayOwner = recoveryPrincipal();
    if (displayOwner) awaitingInitialPrincipalRef.current = false;
    const isCurrent = captureSettingsOwnership();
    setSettingsError(null);
    let settingsLoaded = false;
    try {
      const settingsResponse = await apiFetch(apiUrl("/api/settings"));
      if (!isCurrent()) return;
      if (!settingsResponse.ok) {
        throw new Error(
          `Settings fetch failed: HTTP ${settingsResponse.status}`,
        );
      }
      const payload = (await settingsResponse.json()) as SettingsPayload;
      if (!isCurrent()) return;
      if (payload.catalog) {
        setCatalog(payload.catalog);
        setDraft(cloneCatalog(payload.catalog));
        setCatalogEditable(true);
      } else {
        setCatalogEditable(false);
      }
      initialSettingsSettledRef.current = true;
      const loadedTheme = payload.ui.theme;
      const loadedDisplay = normalizeLearningDisplay(payload.ui);
      if (displayOwner === recoveryPrincipal()) {
        serverDisplayLoadedRef.current = true;
        displayOwnerRef.current = displayOwner;
        setLearningDisplay(loadedDisplay);
        publishLearningDisplay(loadedDisplay, displayOwner);
      }
      serverThemeLoadedRef.current = true;
      setTheme(loadedTheme);
      setLanguage(normalizeLanguage(payload.ui.language));
      const loadedResponseLanguage =
        payload.ui.response_language ?? payload.ui.language;
      setResponseLanguage(loadedResponseLanguage);
      writeStoredLanguage(normalizeLanguage(payload.ui.language));
      writeStoredResponseLanguage(loadedResponseLanguage);
      syncLoadedCodeBlockSettingsToAppShell(payload.ui);
      if (payload.providers) setProviders(payload.providers);
      if (payload.connection_targets)
        setConnectionTargets(payload.connection_targets);
      if (payload.task_kinds) setTaskKinds(payload.task_kinds);

      try {
        const draftResponse = await apiFetch(apiUrl("/api/settings/draft"));
        if (!isCurrent()) return;
        if (draftResponse.ok) {
          const stored = (await draftResponse.json()) as {
            draft: StoredDraft | null;
          };
          if (!isCurrent()) return;
          if (stored.draft) {
            setStoredDraft(stored.draft);
            if (stored.draft.catalog)
              setDraft(cloneCatalog(stored.draft.catalog));
            for (const [key, value] of Object.entries(
              stored.draft.extensions ?? {},
            )) {
              pendingRef.current.set(key, value);
            }
            syncPendingKeys();
            setSavedSignature(
              JSON.stringify({
                catalog: payload.catalog
                  ? (stored.draft.catalog ?? payload.catalog)
                  : null,
                extensions: JSON.stringify(
                  Object.fromEntries(
                    Array.from(pendingRef.current.entries()).sort(([a], [b]) =>
                      a < b ? -1 : a > b ? 1 : 0,
                    ),
                  ),
                ),
              }),
            );
            setDraftRevision((value) => value + 1);
          }
        }
      } catch {
        if (!isCurrent()) return;
      }
      if (!isCurrent()) return;
      const pendingUi = pendingRef.current.get("ui");
      if (
        loadedTheme &&
        extensionsRef.current.get("ui")?.dirty &&
        pendingUi &&
        typeof pendingUi === "object" &&
        !("theme" in pendingUi)
      ) {
        await stageUiRef.current({ theme: loadedTheme });
      }
      if (!isCurrent()) return;
      settingsLoaded = true;
    } catch (err) {
      if (!isCurrent()) return;
      console.error("Failed to load settings:", err);
      const message = err instanceof Error ? err.message : String(err);
      setSettingsError(message);
      setCatalogEditable((current) => (current === null ? false : current));
      initialSettingsSettledRef.current = true;
    }
    try {
      const statusResponse = await apiFetch(apiUrl("/api/system/status"));
      if (!isCurrent()) return;
      if (statusResponse.ok) {
        const payload = (await statusResponse.json()) as SystemStatus;
        if (!isCurrent()) return;
        setStatus(payload);
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error("Failed to load system status:", err);
      if (settingsLoaded) {
        setSettingsError(
          (current) =>
            current ??
            (err instanceof Error
              ? `System status unavailable: ${err.message}`
              : "System status unavailable."),
        );
      }
    }
  }, [captureSettingsOwnership, syncPendingKeys]);
  const loadSettingsRef = useRef(loadSettings);
  loadSettingsRef.current = loadSettings;

  useEffect(() => {
    if (serverThemeLoadedRef.current) return;
    const stored = getStoredThemePreference();
    if (stored) setTheme(stored);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const liveUi = useMemo<UiSettings>(
    () => ({
      ...learningDisplay,
      theme,
      language,
      response_language: responseLanguage,
      code_block_theme: codeBlockTheme,
      code_block_show_line_numbers: codeBlockShowLineNumbers,
      code_block_wrap_long_lines: codeBlockWrapLongLines,
    }),
    [
      learningDisplay,
      theme,
      language,
      responseLanguage,
      codeBlockTheme,
      codeBlockShowLineNumbers,
      codeBlockWrapLongLines,
    ],
  );

  const applyUi = useCallback((ui: Partial<UiSettings>) => {
    if (serverThemeLoadedRef.current && ui.theme) {
      setTheme(ui.theme);
      applyThemePreference(ui.theme);
    }
    if (ui.language) {
      const language = normalizeLanguage(ui.language);
      setLanguage(language);
      writeStoredLanguage(language);
    }
    if (ui.response_language) {
      setResponseLanguage(ui.response_language);
      writeStoredResponseLanguage(ui.response_language);
    }
    syncLoadedCodeBlockSettingsToAppShell(ui);
  }, []);

  const stageUi = useCallback(
    async (patch: Partial<UiSettings>) => {
      const merged: UiSettings = {
        ...liveUi,
        ...(pendingRef.current.get("ui") as Partial<UiSettings> | undefined),
        ...patch,
      };
      const next: Partial<UiSettings> = serverThemeLoadedRef.current
        ? merged
        : withoutUnconfirmedTheme(merged);
      const baseline: Partial<UiSettings> = serverThemeLoadedRef.current
        ? { ...liveUi }
        : withoutUnconfirmedTheme(liveUi);
      if (!serverDisplayLoadedRef.current) {
        const pending = pendingRef.current.get("ui") as
          | Partial<UiSettings>
          | undefined;
        for (const key of [
          "content_font_scale",
          "content_line_spacing",
        ] as const) {
          if (!(key in patch) && !(pending && key in pending)) delete next[key];
          delete baseline[key];
        }
      }
      registerExtension("ui", {
        dirty: JSON.stringify(next) !== JSON.stringify(baseline),
        payload: next,
        save: async () => {
          await applyExtensionPayload("ui", next);
        },
      });
    },
    [liveUi, registerExtension],
  );
  stageUiRef.current = stageUi;

  const updateTheme = useCallback(
    async (next: UiSettings["theme"]) => stageUi({ theme: next }),
    [stageUi],
  );
  const updateLanguage = useCallback(
    async (next: UiSettings["language"]) => stageUi({ language: next }),
    [stageUi],
  );
  const updateResponseLanguage = useCallback(
    async (next: UiSettings["response_language"]) =>
      stageUi({ response_language: next }),
    [stageUi],
  );
  const updateCodeBlockTheme = useCallback(
    async (next: CodeBlockThemeId) => stageUi({ code_block_theme: next }),
    [stageUi],
  );
  const updateCodeBlockShowLineNumbers = useCallback(
    async (next: boolean) => stageUi({ code_block_show_line_numbers: next }),
    [stageUi],
  );
  const updateCodeBlockWrapLongLines = useCallback(
    async (next: boolean) => stageUi({ code_block_wrap_long_lines: next }),
    [stageUi],
  );
  const updateContentFontScale = useCallback(
    async (next: LearningDisplay["content_font_scale"]) =>
      stageUi({ content_font_scale: next }),
    [stageUi],
  );
  const updateContentLineSpacing = useCallback(
    async (next: LearningDisplay["content_line_spacing"]) =>
      stageUi({ content_line_spacing: next }),
    [stageUi],
  );
  const resetLearningText = useCallback(
    async () => stageUi(DEFAULT_LEARNING_DISPLAY),
    [stageUi],
  );

  useEffect(() => {
    let request = 0;
    const onBoundary = () => {
      settingsGenerationRef.current += 1;
      setApplying(false);
      setSaving(false);
      const generation = ++request;
      const owner = recoveryPrincipal();
      serverDisplayLoadedRef.current = false;
      displayOwnerRef.current = owner;
      setLearningDisplay(DEFAULT_LEARNING_DISPLAY);
      const pending = pendingRef.current.get("ui") as
        | Partial<UiSettings>
        | undefined;
      if (pending) {
        const next = { ...pending };
        delete next.content_font_scale;
        delete next.content_line_spacing;
        pendingRef.current.set("ui", next);
        void stageUiRef.current({});
      }
      if (!owner) return;
      if (
        awaitingInitialPrincipalRef.current ||
        !initialSettingsSettledRef.current
      ) {
        awaitingInitialPrincipalRef.current = false;
        void loadSettingsRef.current();
        return;
      }
      void (async () => {
        try {
          const response = await apiFetch(apiUrl("/api/settings/display"), {
            skipAuthRedirect: true,
          });
          if (!response.ok) return;
          const display = normalizeLearningDisplay(await response.json());
          if (generation !== request || recoveryPrincipal() !== owner) return;
          serverDisplayLoadedRef.current = true;
          setLearningDisplay(display);
        } catch {
          /* An unavailable account starts at defaults. */
        }
      })();
    };
    window.addEventListener(RECOVERY_PRINCIPAL_CHANGED, onBoundary);
    if (!initialSettingsSettledRef.current) void loadSettingsRef.current();
    return () => {
      request += 1;
      settingsGenerationRef.current += 1;
      window.removeEventListener(RECOVERY_PRINCIPAL_CHANGED, onBoundary);
    };
  }, []);

  const mutateCatalog = useCallback((mutator: (next: Catalog) => void) => {
    setDraft((current) => {
      const next = cloneCatalog(current);
      mutator(next);
      return next;
    });
  }, []);

  const embeddingDefaultDim = useCallback(
    (binding?: string) => {
      const match = (providers.embedding || []).find(
        (p) => p.value === (binding || "openai"),
      );
      return match?.default_dim || "3072";
    },
    [providers.embedding],
  );

  const t = useCallback((key: string) => englishLabel(key), []) as unknown as Parameters<typeof useDiagnostics>[0]["t"];

  const diagnostics = useDiagnostics({ catalogEditable, draft, t });

  const catalogActions = useCatalogActions({
    draft,
    providers,
    connectionTargets,
    language,
    llmContextDetection: diagnostics.llmContextDetection,
    mutateCatalog,
    embeddingDefaultDim,
    setToast,
    t,
  });

  const envelopeSignature = useMemo(
    () =>
      JSON.stringify({
        catalog: catalogEditable ? draft : null,
        extensions: pendingSignature,
      }),
    [catalogEditable, draft, pendingSignature],
  );

  const differsFromLive = useMemo(
    () =>
      pendingSignature !== "{}" ||
      (catalogEditable === true &&
        JSON.stringify(catalog) !== JSON.stringify(draft)),
    [catalog, catalogEditable, draft, pendingSignature],
  );

  const envelopeSignatureRef = useRef(envelopeSignature);
  envelopeSignatureRef.current = envelopeSignature;

  const changedStoredDraft =
    storedDraft !== null &&
    savedSignature !== null &&
    envelopeSignature !== savedSignature;
  const draftState: DraftState =
    !differsFromLive && !changedStoredDraft
      ? "clean"
      : envelopeSignature === savedSignature
        ? "saved"
        : "unsaved";

  const hasUnsavedChanges = draftState === "unsaved";

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedChanges]);

  const draftLifecycle = useDraftLifecycle({
    catalog,
    draft,
    catalogEditable,
    learningDisplay,
    serverDisplayLoadedRef,
    displayOwnerRef,
    pendingRef,
    extensionsRef,
    envelopeSignatureRef,
    captureSettingsOwnership,
    syncPendingKeys,
    clearPending,
    applyUi,
    setLearningDisplay,
    setCatalog,
    setDraft,
    setStatus,
    setStoredDraft,
    setSavedSignature,
    setDraftRevision,
    setSaving,
    setApplying,
    setToast,
    setFocusModel,
    setModelTests: diagnostics.setModelTests,
    pushRoute: router.push,
    t,
  });

  // ── Tour ────────────────────────────────────────────────────────────────
  const startTour = useCallback(() => {
    if (TOUR_STEPS.length === 0) return;
    setTourStepIndex(0);
  }, []);

  const advanceTour = useCallback(() => {
    setTourStepIndex((idx) => {
      const nextIdx = idx + 1;
      return nextIdx >= TOUR_STEPS.length ? -1 : nextIdx;
    });
  }, []);

  const goBackTour = useCallback(() => {
    setTourStepIndex((idx) => (idx > 0 ? idx - 1 : idx));
  }, []);

  const skipTour = useCallback(() => {
    setTourStepIndex(-1);
  }, []);

  useEffect(() => {
    if (tourStepIndex < 0 || tourStepIndex >= TOUR_STEPS.length) return;
    const step = TOUR_STEPS[tourStepIndex];
    router.push(step.route);
  }, [tourStepIndex, router]);

  const settingsLoading = catalogEditable === null;

  const editedUi = useMemo(
    () => ({
      ...liveUi,
      ...(JSON.parse(pendingSignature).ui as Partial<UiSettings> | undefined),
    }),
    [liveUi, pendingSignature],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      catalog,
      draft,
      status,
      providers,
      catalogEditable,
      settingsLoading,
      settingsError,
      reloadSettings: loadSettings,
      hasUnsavedChanges,
      theme: editedUi.theme,
      language: editedUi.language,
      responseLanguage: editedUi.response_language,
      codeBlockTheme: editedUi.code_block_theme,
      codeBlockShowLineNumbers: editedUi.code_block_show_line_numbers,
      codeBlockWrapLongLines: editedUi.code_block_wrap_long_lines,
      contentFontScale: editedUi.content_font_scale,
      contentLineSpacing: editedUi.content_line_spacing,
      updateContentFontScale,
      updateContentLineSpacing,
      resetLearningText,
      toast,
      setToast,
      focusModel,
      clearFocusModel,
      updateTheme,
      updateLanguage,
      updateResponseLanguage,
      updateCodeBlockTheme,
      updateCodeBlockShowLineNumbers,
      updateCodeBlockWrapLongLines,
      mutateCatalog,
      ...catalogActions,
      connectionTargets,
      taskKinds,
      llmContextDetection: diagnostics.llmContextDetection,
      saving,
      applying,
      ...draftLifecycle,
      storedDraft,
      draftState,
      draftRevision,
      pendingExtensionPayload,
      registerExtension,
      logs: diagnostics.logs,
      testRunning: diagnostics.testRunning,
      modelTests: diagnostics.modelTests,
      diagnosticsResults: diagnostics.diagnosticsResults,
      embeddingCapabilities: diagnostics.embeddingCapabilities,
      runDetailedTest: diagnostics.runDetailedTest,
      embeddingDefaultDim,
      tourStepIndex,
      startTour,
      advanceTour,
      goBackTour,
      skipTour,
      activeSection,
      setActiveSection,
    }),
    [
      activeSection,
      advanceTour,
      applying,
      catalog,
      catalogActions,
      catalogEditable,
      clearFocusModel,
      connectionTargets,
      diagnostics.diagnosticsResults,
      diagnostics.embeddingCapabilities,
      diagnostics.llmContextDetection,
      diagnostics.logs,
      diagnostics.modelTests,
      diagnostics.runDetailedTest,
      diagnostics.testRunning,
      draft,
      draftLifecycle,
      draftRevision,
      draftState,
      editedUi,
      embeddingDefaultDim,
      focusModel,
      goBackTour,
      hasUnsavedChanges,
      loadSettings,
      mutateCatalog,
      pendingExtensionPayload,
      providers,
      registerExtension,
      resetLearningText,
      saving,
      settingsError,
      settingsLoading,
      skipTour,
      startTour,
      status,
      storedDraft,
      taskKinds,
      toast,
      tourStepIndex,
      updateCodeBlockShowLineNumbers,
      updateCodeBlockTheme,
      updateCodeBlockWrapLongLines,
      updateContentFontScale,
      updateContentLineSpacing,
      updateLanguage,
      updateResponseLanguage,
      updateTheme,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}
