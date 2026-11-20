import type {
  Catalog,
  CatalogModel,
  CatalogProfile,
  ServiceName,
} from "@/lib/model-catalog-types";
import { browserStorage } from "@/shared/storage";
import type {
  DiagnosticsResult,
  ServiceReadiness,
  TourStep,
  UiSettings,
} from "./types";

export const DIAGNOSTICS_RESULTS_KEY = "deeptutor.settings.diagnosticsResults.v1";

export const TOUR_STEPS: TourStep[] = [
  {
    target: "tour-status",
    route: "/settings/status",
    titleKey: "settingsTour.status.title",
    descKey: "settingsTour.status.desc",
  },
  {
    target: "tour-page-heading",
    route: "/settings/appearance",
    titleKey: "settingsTour.appearance.title",
    descKey: "settingsTour.appearance.desc",
  },
  {
    target: "tour-page-heading",
    route: "/settings/network",
    titleKey: "settingsTour.network.title",
    descKey: "settingsTour.network.desc",
  },
  {
    target: "tour-page-heading",
    route: "/settings/llm",
    titleKey: "settingsTour.models.title",
    descKey: "settingsTour.models.desc",
  },
  {
    target: "tour-page-heading",
    route: "/settings/knowledge",
    titleKey: "settingsTour.knowledge.title",
    descKey: "settingsTour.knowledge.desc",
  },
  {
    target: "tour-page-heading",
    route: "/settings/starters",
    titleKey: "settingsTour.chat.title",
    descKey: "settingsTour.chat.desc",
  },
  {
    target: "tour-page-heading",
    route: "/settings/memory",
    titleKey: "settingsTour.memory.title",
    descKey: "settingsTour.memory.desc",
  },
];

/** Drop theme so an unconfirmed placeholder cannot be staged or applied. */
export function withoutUnconfirmedTheme(
  ui: UiSettings,
): Omit<UiSettings, "theme"> {
  const { theme: _theme, ...rest } = ui;
  return rest;
}

export function cloneCatalog(catalog: Catalog): Catalog {
  return JSON.parse(JSON.stringify(catalog)) as Catalog;
}

/** TTS/STT share the catalog shape but configure audio providers. */
export function voiceService(service: ServiceName): boolean {
  return service === "tts" || service === "stt";
}

/** imagegen/videogen share the catalog shape but configure media generation. */
export function generationService(service: ServiceName): boolean {
  return service === "imagegen" || service === "videogen";
}

/** Services whose model entry should prefill from the provider's default model. */
export function prefillsDefaultModel(service: ServiceName): boolean {
  return voiceService(service) || generationService(service);
}

export function defaultCatalog(): Catalog {
  return {
    version: 1,
    connections: [],
    services: {
      llm: { active_profile_id: null, active_model_id: null, profiles: [] },
      task: {
        active_profile_id: null,
        active_model_id: null,
        profiles: [],
      },
      embedding: {
        active_profile_id: null,
        active_model_id: null,
        profiles: [],
      },
      search: { active_profile_id: null, profiles: [] },
      tts: { active_profile_id: null, active_model_id: null, profiles: [] },
      stt: { active_profile_id: null, active_model_id: null, profiles: [] },
      imagegen: {
        active_profile_id: null,
        active_model_id: null,
        profiles: [],
      },
      videogen: {
        active_profile_id: null,
        active_model_id: null,
        profiles: [],
      },
    },
  };
}

export function getActiveProfile(
  catalog: Catalog,
  serviceName: ServiceName,
): CatalogProfile | null {
  const service = catalog.services[serviceName];
  return (
    service.profiles.find(
      (profile) => profile.id === service.active_profile_id,
    ) ??
    service.profiles[0] ??
    null
  );
}

export function getActiveModel(
  catalog: Catalog,
  serviceName: ServiceName,
): CatalogModel | null {
  if (serviceName === "search") return null;
  const service = catalog.services[serviceName];
  const profile = getActiveProfile(catalog, serviceName);
  if (!profile) return null;
  return (
    profile.models.find((model) => model.id === service.active_model_id) ??
    profile.models[0] ??
    null
  );
}

export function serviceConfigured(
  catalog: Catalog,
  serviceName: ServiceName,
): boolean {
  return serviceName === "search"
    ? Boolean(getActiveProfile(catalog, serviceName)?.provider)
    : Boolean(getActiveModel(catalog, serviceName)?.model);
}

export function currentDiagnosticsResult(
  catalog: Catalog,
  serviceName: ServiceName,
  diagnosticsResults: Partial<Record<ServiceName, DiagnosticsResult>>,
): DiagnosticsResult | null {
  const service = catalog.services[serviceName];
  const diagnostics = diagnosticsResults[serviceName];
  if (!diagnostics) return null;
  const profileId = service.active_profile_id ?? null;
  const modelId =
    serviceName === "search" ? null : (service.active_model_id ?? null);
  return diagnostics.profileId === profileId && diagnostics.modelId === modelId
    ? diagnostics
    : null;
}

export function serviceReadiness(
  catalog: Catalog,
  serviceName: ServiceName,
  diagnosticsResults: Partial<Record<ServiceName, DiagnosticsResult>>,
): ServiceReadiness {
  if (!serviceConfigured(catalog, serviceName)) return "not_configured";
  const diagnostics = currentDiagnosticsResult(
    catalog,
    serviceName,
    diagnosticsResults,
  );
  if (diagnostics?.state === "failed") return "failed";
  if (diagnostics?.state === "success") return "passed";
  return "untested";
}

export function servicePendingApply(
  catalog: Catalog,
  draft: Catalog,
  service: ServiceName,
): boolean {
  return (
    JSON.stringify(catalog.services[service]) !==
    JSON.stringify(draft.services[service])
  );
}

export function nextModelName(
  models: CatalogModel[],
  language: UiSettings["language"],
): string {
  const prefix = "Model ";
  const used = new Set(models.map((model) => model.name.trim()));
  let index = models.length + 1;
  while (used.has(`${prefix}${index}`)) {
    index += 1;
  }
  return `${prefix}${index}`;
}

export function readStoredDiagnosticsResults(): Partial<
  Record<ServiceName, DiagnosticsResult>
> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      browserStorage.readRaw("session", DIAGNOSTICS_RESULTS_KEY) || "{}",
    ) as Partial<Record<ServiceName, DiagnosticsResult>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredDiagnosticsResults(
  diagnosticsResults: Partial<Record<ServiceName, DiagnosticsResult>>,
): void {
  try {
    browserStorage.writeRaw(
      "session",
      DIAGNOSTICS_RESULTS_KEY,
      JSON.stringify(diagnosticsResults),
    );
  } catch {
    // Session storage is an enhancement for cross-route feedback only.
  }
}

export function targetProfile(
  next: Catalog,
  service: ServiceName,
  profileId?: string,
): CatalogProfile | null {
  return profileId
    ? (next.services[service].profiles.find((item) => item.id === profileId) ??
        null)
    : getActiveProfile(next, service);
}

export function targetModel(
  next: Catalog,
  service: ServiceName,
  profileId?: string,
  modelId?: string,
): CatalogModel | null {
  if (!profileId && !modelId) return getActiveModel(next, service);
  const profile = targetProfile(next, service, profileId);
  if (!profile) return null;
  return modelId
    ? (profile.models.find((item) => item.id === modelId) ?? null)
    : (profile.models[0] ?? null);
}
