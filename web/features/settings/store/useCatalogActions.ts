import { useCallback } from "react";
import {
  CONNECTABLE_SERVICES,
  type Catalog,
  type CatalogConnection,
  type CatalogModel,
  type CatalogProfile,
  type ConnectionTarget,
  type LlmContextWindowDetection,
  type ModelCapabilityKey,
  type ProviderOption,
  type ServiceName,
} from "@/lib/model-catalog-types";
import { detachProfileConnection } from "@/lib/model-settings";
import { setModelReasoningEffort } from "@/lib/reasoning-effort";
import {
  getActiveModel,
  nextModelName,
  prefillsDefaultModel,
  targetModel,
  targetProfile,
} from "./catalog-helpers";
import type { UiSettings } from "./types";

type UseCatalogActionsParams = {
  draft: Catalog;
  providers: Record<ServiceName, ProviderOption[]>;
  connectionTargets: ConnectionTarget[];
  language: UiSettings["language"];
  llmContextDetection: LlmContextWindowDetection | null;
  mutateCatalog: (mutator: (next: Catalog) => void) => void;
  embeddingDefaultDim: (binding?: string) => string;
  setToast: (value: string) => void;
};

export function useCatalogActions({
  draft,
  providers,
  connectionTargets,
  language,
  llmContextDetection,
  mutateCatalog,
  embeddingDefaultDim,
  setToast,
}: UseCatalogActionsParams) {
  const addProfile = useCallback(
    (service: ServiceName) => {
      mutateCatalog((next) => {
        const target = next.services[service];
        const profileId = `${service}-profile-${Date.now()}`;
        const defaultBinding = service === "search" ? undefined : "openai";
        const defaultProvider = service === "search" ? "brave" : undefined;
        const providerKey =
          service === "search" ? defaultProvider : defaultBinding;
        const providerOption = (providers[service] || []).find(
          (p) => p.value === providerKey,
        );
        const providerLabel =
          providerOption?.label ?? providerKey ?? "New Profile";
        const profile: CatalogProfile = {
          id: profileId,
          name: providerLabel,
          binding: defaultBinding,
          provider: defaultProvider,
          base_url: providerOption?.base_url ?? "",
          api_key: "",
          api_version: "",
          extra_headers: service === "search" ? undefined : {},
          wire_api: service === "llm" ? "auto" : undefined,
          api_format:
            service === "llm" || service === "task" ? "auto" : undefined,
          proxy: service === "search" ? "" : undefined,
          models: [],
        };
        if (service !== "search") {
          const modelId = `${service}-model-${Date.now()}`;
          const modelName = nextModelName([], language);
          profile.models.push({
            id: modelId,
            name: modelName,
            model: prefillsDefaultModel(service)
              ? (providerOption?.default_model ?? "")
              : "",
            ...(service === "embedding"
              ? {
                  dimension: embeddingDefaultDim(),
                  send_dimensions: true,
                }
              : {}),
            ...(service === "tts"
              ? {
                  voice: "",
                  response_format: "",
                }
              : {}),
          });
          if (!target.active_profile_id) target.active_model_id = modelId;
        }
        target.profiles.push(profile);
        if (!target.active_profile_id) target.active_profile_id = profileId;
      });
    },
    [embeddingDefaultDim, language, mutateCatalog, providers],
  );

  const removeActiveProfile = useCallback(
    (service: ServiceName, profileId?: string) => {
      mutateCatalog((next) => {
        const target = next.services[service];
        const doomed = profileId ?? target.active_profile_id;
        target.profiles = target.profiles.filter(
          (profile) => profile.id !== doomed,
        );
        if (target.active_profile_id === doomed) {
          target.active_profile_id = target.profiles[0]?.id ?? null;
          if (service !== "search") {
            target.active_model_id =
              target.profiles[0]?.models?.[0]?.id ?? null;
          }
        }
      });
    },
    [mutateCatalog],
  );

  const addModel = useCallback(
    (service: ServiceName, profileId?: string) => {
      if (service === "search") return;
      mutateCatalog((next) => {
        const target = next.services[service];
        const profile = profileId
          ? (target.profiles.find((item) => item.id === profileId) ?? null)
          : (target.profiles.find(
              (item) => item.id === target.active_profile_id,
            ) ?? null);
        if (!profile) return;
        const providerOption = (providers[service] || []).find(
          (p) => p.value === profile.binding,
        );
        const modelId = `${service}-model-${Date.now()}`;
        const modelName = nextModelName(profile.models, language);
        profile.models.push({
          id: modelId,
          name: modelName,
          model: prefillsDefaultModel(service)
            ? (providerOption?.default_model ?? "")
            : "",
          ...(service === "embedding"
            ? {
                dimension: embeddingDefaultDim(profile.binding),
                send_dimensions: true,
              }
            : {}),
          ...(service === "tts"
            ? {
                voice: "",
                response_format: "",
              }
            : {}),
        });
        if (
          profile.id === target.active_profile_id &&
          !target.active_model_id
        ) {
          target.active_model_id = modelId;
        }
      });
    },
    [embeddingDefaultDim, language, mutateCatalog, providers],
  );

  const connectionTarget = useCallback(
    (provider: string) =>
      connectionTargets.find((target) => target.provider === provider) ?? null,
    [connectionTargets],
  );

  const addConnection = useCallback(
    (input: {
      provider: string;
      name: string;
      api_key: string;
      base_url: string;
    }) => {
      const connection: CatalogConnection = {
        id: `conn-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: input.name.trim() || input.provider,
        provider: input.provider,
        api_key: input.api_key,
        base_url: input.base_url.trim(),
        api_version: "",
        extra_headers: {},
      };
      mutateCatalog((next) => {
        next.connections = [...(next.connections ?? []), { ...connection }];
      });
      return connection;
    },
    [mutateCatalog],
  );

  const updateConnectionField = useCallback(
    (id: string, field: keyof CatalogConnection, value: string) => {
      mutateCatalog((next) => {
        const connection = (next.connections ?? []).find(
          (item) => item.id === id,
        );
        if (connection) (connection as Record<string, unknown>)[field] = value;
      });
    },
    [mutateCatalog],
  );

  const removeConnection = useCallback(
    (id: string) => {
      mutateCatalog((next) => {
        for (const service of CONNECTABLE_SERVICES) {
          for (const profile of next.services[service].profiles) {
            if (profile.connection_id === id)
              detachProfileConnection(next, service, profile);
          }
        }
        next.connections = (next.connections ?? []).filter(
          (item) => item.id !== id,
        );
      });
    },
    [mutateCatalog],
  );

  const unlinkProfile = useCallback(
    (service: ServiceName, profileId: string) => {
      mutateCatalog((next) => {
        const profile = next.services[service].profiles.find(
          (item) => item.id === profileId,
        );
        if (profile) detachProfileConnection(next, service, profile);
      });
    },
    [mutateCatalog],
  );

  const linkConnectionToServices = useCallback(
    (
      connection: Pick<
        CatalogConnection,
        "id" | "provider" | "name" | "api_key" | "base_url"
      >,
      requests: { service: ServiceName; model: string }[],
    ) => {
      const target = connectionTargets.find(
        (item) => item.provider === connection.provider,
      );
      const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const base = connection.base_url.trim().replace(/\/+$/, "");
      const plan = requests.flatMap((request, index) => {
        const spec = target?.services[request.service];
        if (!spec) return [];
        return [
          {
            service: request.service,
            spec,
            profileId: `${request.service}-profile-${stamp}${index}`,
            modelId: `${request.service}-model-${stamp}${index}`,
            model: request.model || spec.default_model || "",
            baseUrl: base
              ? request.service === "embedding"
                ? `${base}/embeddings`
                : base
              : spec.base_url,
            activate: draft.services[request.service].profiles.length === 0,
          },
        ];
      });

      mutateCatalog((next) => {
        for (const item of plan) {
          const bucket = next.services[item.service];
          bucket.profiles.push({
            id: item.profileId,
            name: connection.name,
            connection_id: connection.id,
            binding: item.spec.provider,
            base_url: item.baseUrl,
            api_key: connection.api_key,
            api_version: "",
            extra_headers: {},
            models: [
              {
                id: item.modelId,
                name: item.model || item.spec.provider,
                model: item.model,
                ...(item.service === "embedding"
                  ? {
                      dimension: item.spec.default_dim || "",
                      send_dimensions: true,
                    }
                  : {}),
                ...(item.service === "tts"
                  ? {
                      voice: "",
                      response_format: "",
                    }
                  : {}),
              },
            ],
          });
          if (item.activate) {
            bucket.active_profile_id = item.profileId;
            bucket.active_model_id = item.modelId;
          }
        }
      });

      return {
        created: plan.map((item) => item.service),
        activated: plan
          .filter((item) => item.activate)
          .map((item) => item.service),
      };
    },
    [connectionTargets, draft, mutateCatalog],
  );

  const removeActiveModel = useCallback(
    (service: ServiceName, profileId?: string, modelId?: string) => {
      if (service === "search") return;
      mutateCatalog((next) => {
        const target = next.services[service];
        const profile = profileId
          ? (target.profiles.find((item) => item.id === profileId) ?? null)
          : (target.profiles.find(
              (item) => item.id === target.active_profile_id,
            ) ?? null);
        if (!profile) return;
        const doomed = modelId ?? target.active_model_id;
        profile.models = profile.models.filter((item) => item.id !== doomed);
        if (target.active_model_id === doomed) {
          target.active_model_id =
            profile.id === target.active_profile_id
              ? (profile.models[0]?.id ?? null)
              : target.active_model_id;
        }
      });
    },
    [mutateCatalog],
  );

  const updateProfileField = useCallback(
    (
      service: ServiceName,
      field: keyof CatalogProfile,
      value: string,
      profileId?: string,
    ) => {
      mutateCatalog((next) => {
        const profile = targetProfile(next, service, profileId);
        if (!profile) return;
        (profile[field] as string | undefined) = value;
      });
    },
    [mutateCatalog],
  );

  const updateModelField = useCallback(
    (
      service: ServiceName,
      field: keyof CatalogModel,
      value: string,
      profileId?: string,
      modelId?: string,
    ) => {
      if (service === "search") return;
      mutateCatalog((next) => {
        const model = targetModel(next, service, profileId, modelId);
        if (!model) return;
        (model[field] as string | undefined) = value;
      });
    },
    [mutateCatalog],
  );

  const updateModelBoolField = useCallback(
    (
      service: ServiceName,
      field: keyof CatalogModel,
      value: boolean,
      profileId?: string,
      modelId?: string,
    ) => {
      if (service === "search") return;
      mutateCatalog((next) => {
        const model = targetModel(next, service, profileId, modelId);
        if (!model) return;
        (model[field] as boolean | undefined) = value;
      });
    },
    [mutateCatalog],
  );

  const updateContextWindowField = useCallback(
    (value: string, profileId?: string, modelId?: string) => {
      const normalized = value.replace(/[^\d]/g, "");
      mutateCatalog((next) => {
        const model = targetModel(next, "llm", profileId, modelId);
        if (!model) return;
        if (normalized) {
          model.context_window = normalized;
          model.context_window_source = "manual";
          delete model.context_window_detected_at;
        } else {
          delete model.context_window;
          delete model.context_window_source;
          delete model.context_window_detected_at;
        }
      });
    },
    [mutateCatalog],
  );

  const updateReasoningEffort = useCallback(
    (value: string, profileId?: string, modelId?: string) => {
      mutateCatalog((next) => {
        const model = targetModel(next, "llm", profileId, modelId);
        if (!model) return;
        setModelReasoningEffort(model, value);
      });
    },
    [mutateCatalog],
  );

  const updateModelCapability = useCallback(
    (
      service: ServiceName,
      key: ModelCapabilityKey,
      value: boolean | null,
      profileId?: string,
      modelId?: string,
    ) => {
      if (service === "search") return;
      mutateCatalog((next) => {
        const model = targetModel(next, service, profileId, modelId);
        if (!model) return;
        const capabilities = { ...(model.capabilities ?? {}) };
        if (value === null) delete capabilities[key];
        else capabilities[key] = value;
        if (Object.keys(capabilities).length === 0) delete model.capabilities;
        else model.capabilities = capabilities;
      });
    },
    [mutateCatalog],
  );

  const applyDetectedContextWindow = useCallback(() => {
    if (!llmContextDetection || llmContextDetection.source === "default") return;
    mutateCatalog((next) => {
      const target = next.services.llm;
      if (
        target.active_profile_id !== llmContextDetection.profileId ||
        target.active_model_id !== llmContextDetection.modelId
      ) {
        return;
      }
      const model = getActiveModel(next, "llm");
      if (!model) return;
      model.context_window = String(llmContextDetection.contextWindow);
      model.context_window_source = llmContextDetection.source;
      if (llmContextDetection.detectedAt) {
        model.context_window_detected_at = llmContextDetection.detectedAt;
      } else {
        delete model.context_window_detected_at;
      }
    });
    setToast("Detected context window written to draft");
  }, [llmContextDetection, mutateCatalog, setToast]);

  return {
    addProfile,
    removeActiveProfile,
    addModel,
    removeActiveModel,
    connectionTarget,
    addConnection,
    updateConnectionField,
    removeConnection,
    unlinkProfile,
    linkConnectionToServices,
    updateProfileField,
    updateModelField,
    updateModelBoolField,
    updateContextWindowField,
    updateReasoningEffort,
    updateModelCapability,
    applyDetectedContextWindow,
  };
}
