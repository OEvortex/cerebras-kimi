import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { apiFetch, apiUrl, asJsonOrThrow } from "@/shared/api/client";
import {
  normalizeLearningDisplay,
  publishLearningDisplay,
  type LearningDisplay,
} from "@/lib/learning-display";
import { invalidateLLMOptionsCache } from "@/lib/llm-options";
import type { Catalog, ServiceName } from "@/lib/model-catalog-types";
import {
  firstIncompleteModel,
  modelTestFingerprint,
  modelTestKey,
  reconcileProviderSave,
  type IncompleteModel,
  type ModelTestState,
} from "@/lib/model-settings";
import { reconcileRegistrySave, type RegistryEdit } from "@/lib/provider-registry";
import { recoveryPrincipal } from "@/lib/recovery-principal";
import { applyExtensionPayload } from "@/lib/settings-extensions";
import { cloneCatalog } from "./catalog-helpers";
import type {
  SettingsExtension,
  StoredDraft,
  SystemStatus,
  UiSettings,
} from "./types";

type UseDraftLifecycleParams = {
  catalog: Catalog;
  draft: Catalog;
  catalogEditable: boolean | null;
  learningDisplay: LearningDisplay;
  serverDisplayLoadedRef: MutableRefObject<boolean>;
  displayOwnerRef: MutableRefObject<string | null | undefined>;
  pendingRef: MutableRefObject<Map<string, unknown>>;
  extensionsRef: MutableRefObject<Map<string, SettingsExtension>>;
  envelopeSignatureRef: MutableRefObject<string>;
  captureSettingsOwnership: () => () => boolean;
  syncPendingKeys: () => void;
  clearPending: (applied?: Map<string, unknown>) => void;
  applyUi: (ui: Partial<UiSettings>) => void;
  setLearningDisplay: Dispatch<SetStateAction<LearningDisplay>>;
  setCatalog: Dispatch<SetStateAction<Catalog>>;
  setDraft: Dispatch<SetStateAction<Catalog>>;
  setStatus: Dispatch<SetStateAction<SystemStatus | null>>;
  setStoredDraft: Dispatch<SetStateAction<StoredDraft | null>>;
  setSavedSignature: Dispatch<SetStateAction<string | null>>;
  setDraftRevision: Dispatch<SetStateAction<number>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setApplying: Dispatch<SetStateAction<boolean>>;
  setToast: Dispatch<SetStateAction<string>>;
  setFocusModel: Dispatch<SetStateAction<IncompleteModel | null>>;
  setModelTests: Dispatch<SetStateAction<Record<string, ModelTestState>>>;
  pushRoute: (href: string) => void;
};

export function useDraftLifecycle({
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
  setModelTests,
  pushRoute,
}: UseDraftLifecycleParams) {
  const draftEnvelope = useCallback(
    () => ({
      catalog: catalogEditable ? draft : null,
      extensions: Object.fromEntries(pendingRef.current.entries()),
    }),
    [catalogEditable, draft, pendingRef],
  );

  const saveDraft = useCallback(async (): Promise<boolean | null> => {
    const isCurrent = captureSettingsOwnership();
    setSaving(true);
    const signature = envelopeSignatureRef.current;
    try {
      const response = await apiFetch(apiUrl("/api/settings/draft"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftEnvelope()),
      });
      if (!isCurrent()) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        draft: StoredDraft | null;
      };
      if (!isCurrent()) return null;
      setStoredDraft(payload.draft ?? null);
      setSavedSignature(signature);
      setToast("Draft saved — not applied yet");
      return true;
    } catch (err) {
      if (!isCurrent()) return null;
      setToast(
        `Could not save the draft: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }, [captureSettingsOwnership, draftEnvelope, envelopeSignatureRef, setSavedSignature, setSaving, setStoredDraft, setToast]);

  const applyService = useCallback(
    async (service: ServiceName): Promise<boolean> => {
      setApplying(true);
      try {
        const response = await apiFetch(apiUrl("/api/settings/apply/service"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service,
            config: draft.services[service],
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as {
          catalog: Catalog;
          draft: StoredDraft | null;
        };
        const appliedService = cloneCatalog(payload.catalog).services[service];
        setCatalog(payload.catalog);
        setDraft((current) => {
          const next = cloneCatalog(current);
          if (
            JSON.stringify(current.services[service]) ===
            JSON.stringify(draft.services[service])
          ) {
            next.services[service] = appliedService;
          }
          return next;
        });
        setStoredDraft(payload.draft ?? null);
        setSavedSignature(null);
        invalidateLLMOptionsCache();
        try {
          const statusResponse = await apiFetch(apiUrl("/api/system/status"));
          if (statusResponse.ok) {
            setStatus((await statusResponse.json()) as SystemStatus);
          }
        } catch {
          // Status refresh failure must not fail a completed apply.
        }
        setToast("Applied");
        return true;
      } catch (err) {
        setToast(
          `Could not apply: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      } finally {
        setApplying(false);
      }
    },
    [draft.services, setApplying, setCatalog, setDraft, setSavedSignature, setStatus, setStoredDraft, setToast],
  );

  const saveRegistry = useCallback(
    async (edit: RegistryEdit): Promise<boolean> => {
      setApplying(true);
      try {
        const response = await apiFetch(
          apiUrl("/api/settings/apply/registry"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(edit),
          },
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof payload.detail === "string"
              ? payload.detail
              : `HTTP ${response.status}`,
          );
        }
        setCatalog(payload.catalog);
        setDraft((current) =>
          reconcileRegistrySave(current, draft, payload.catalog, edit),
        );
        const normalized = reconcileRegistrySave(
          draft,
          draft,
          payload.catalog,
          edit,
        );
        setModelTests((current) => {
          const next = { ...current };
          for (const [key, result] of Object.entries(next)) {
            const [service, profileId, modelId] = JSON.parse(key) as [
              ServiceName,
              string,
              string | null,
            ];
            if (
              result.fingerprint ===
              modelTestFingerprint(draft, service, profileId, modelId)
            ) {
              next[key] = {
                ...result,
                fingerprint: modelTestFingerprint(
                  normalized,
                  service,
                  profileId,
                  modelId,
                ),
              };
            }
          }
          return next;
        });
        setStoredDraft(payload.draft ?? null);
        setSavedSignature(null);
        invalidateLLMOptionsCache();
        setToast("Applied");
        return true;
      } catch (error) {
        setToast(
          `Could not apply: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        setApplying(false);
      }
    },
    [draft, setApplying, setCatalog, setDraft, setModelTests, setSavedSignature, setStoredDraft, setToast],
  );

  const saveProvider = useCallback(
    async (service: ServiceName, profileId: string): Promise<boolean> => {
      const profile = draft.services[service].profiles.find(
        (item) => item.id === profileId,
      );
      if (!profile) return false;
      const connection = draft.connections?.find(
        (item) => item.id === profile.connection_id,
      );
      const activate =
        draft.services[service].active_profile_id === profileId &&
        (service !== "task" ||
          !["inherit", "reference"].includes(
            draft.services.task.mode ?? "profiles",
          ));
      setApplying(true);
      try {
        const response = await apiFetch(
          apiUrl("/api/settings/apply/provider"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              service,
              profile,
              connection,
              activate,
              active_model_id: draft.services[service].active_model_id,
            }),
          },
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof payload.detail === "string"
              ? payload.detail
              : `HTTP ${response.status}`,
          );
        }
        const live = payload.catalog as Catalog;
        setCatalog(live);
        setDraft((current) =>
          reconcileProviderSave(current, draft, live, service, profileId),
        );
        const normalized = reconcileProviderSave(
          draft,
          draft,
          live,
          service,
          profileId,
        );
        setModelTests((current) => {
          const next = { ...current };
          const modelIds =
            service === "search"
              ? [undefined]
              : profile.models.map((model) => model.id);
          for (const modelId of modelIds) {
            const key = modelTestKey(service, profileId, modelId);
            const result = next[key];
            if (
              result?.fingerprint ===
              modelTestFingerprint(draft, service, profileId, modelId)
            ) {
              next[key] = {
                ...result,
                fingerprint: modelTestFingerprint(
                  normalized,
                  service,
                  profileId,
                  modelId,
                ),
              };
            }
          }
          return next;
        });
        setStoredDraft(payload.draft ?? null);
        setSavedSignature(null);
        invalidateLLMOptionsCache();
        setToast("Provider saved");
        return true;
      } catch (error) {
        setToast(
          `Could not apply: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        setApplying(false);
      }
    },
    [draft, setApplying, setCatalog, setDraft, setModelTests, setSavedSignature, setStoredDraft, setToast],
  );

  const applyCatalog = useCallback(async () => {
    const displayOwner = recoveryPrincipal();
    const isCurrent = captureSettingsOwnership();
    if (catalogEditable) {
      const incomplete = firstIncompleteModel(draft);
      if (incomplete) {
        setToast(
          `Add a model ID for ${incomplete.name || "New model"} on the ${(incomplete.page.labelKey)} page before applying changes.`,
        );
        setFocusModel(incomplete);
        pushRoute(
          `${incomplete.page.path}?profile=${encodeURIComponent(incomplete.profileId)}&model=${encodeURIComponent(incomplete.modelId)}`,
        );
        return;
      }
    }

    setApplying(true);
    const applyingExtensions = Array.from(
      pendingRef.current,
      ([key, payload]) => {
        const ext = extensionsRef.current.get(key);
        return { key, payload, save: ext?.dirty ? ext.save : null };
      },
    );
    try {
      const uiPayload = applyingExtensions.find(({ key }) => key === "ui")
        ?.payload as Partial<UiSettings> | undefined;
      if (
        uiPayload &&
        ("content_font_scale" in uiPayload ||
          "content_line_spacing" in uiPayload) &&
        displayOwnerRef.current !== undefined &&
        displayOwnerRef.current !== displayOwner
      ) {
        throw new Error(
          "Your account changed. Reload settings before applying learning text.",
        );
      }
      const draftResponse = await apiFetch(apiUrl("/api/settings/draft"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftEnvelope()),
      });

      if (!isCurrent()) return;
      await asJsonOrThrow(draftResponse);
      if (!isCurrent()) return;

      for (const { key, payload, save } of applyingExtensions) {
        if (!isCurrent()) return;
        if (save) await save();
        else await applyExtensionPayload(key, payload);
        if (!isCurrent()) return;
        if (key === "ui") applyUi(payload as UiSettings);
      }

      if (!isCurrent()) return;
      if (catalogEditable) {
        const response = await apiFetch(apiUrl("/api/settings/apply"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!isCurrent()) return;
        const payload = await asJsonOrThrow(response);
        if (!isCurrent()) return;
        if (!payload.catalog) {
          throw new Error("Missing catalog in apply response");
        }
        setCatalog(payload.catalog);
        setDraft(cloneCatalog(payload.catalog));
        invalidateLLMOptionsCache();
        try {
          const statusResponse = await apiFetch(apiUrl("/api/system/status"));
          if (!isCurrent()) return;
          if (statusResponse.ok) {
            const status = (await statusResponse.json()) as SystemStatus;
            if (!isCurrent()) return;
            setStatus(status);
          }
        } catch {
          if (!isCurrent()) return;
        }
      } else {
        const response = await apiFetch(apiUrl("/api/settings/draft"), {
          method: "DELETE",
        });
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      if (!isCurrent()) return;
      const appliedUi = applyingExtensions.find(({ key }) => key === "ui")
        ?.payload as Partial<UiSettings> | undefined;
      if (
        displayOwner === recoveryPrincipal() &&
        appliedUi &&
        ("content_font_scale" in appliedUi ||
          "content_line_spacing" in appliedUi)
      ) {
        let display = normalizeLearningDisplay({
          ...learningDisplay,
          ...appliedUi,
        });
        if (!serverDisplayLoadedRef.current) {
          const response = await apiFetch(apiUrl("/api/settings/display"));
          if (!isCurrent()) return;
          display = normalizeLearningDisplay(await asJsonOrThrow(response));
          if (!isCurrent()) return;
          serverDisplayLoadedRef.current = true;
        }
        setLearningDisplay(display);
        publishLearningDisplay(display, displayOwner);
      }
      if (!isCurrent()) return;
      clearPending(
        new Map(applyingExtensions.map(({ key, payload }) => [key, payload])),
      );
      setStoredDraft(null);
      setSavedSignature(null);
      setDraftRevision((value) => value + 1);
      setToast("Applied");
    } catch (err) {
      if (!isCurrent()) return;
      setToast(
        `Could not apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (isCurrent()) setApplying(false);
    }
  }, [applyUi, captureSettingsOwnership, catalogEditable, clearPending, displayOwnerRef, draft, draftEnvelope, extensionsRef, learningDisplay, pendingRef, pushRoute, serverDisplayLoadedRef, setApplying, setCatalog, setDraft, setDraftRevision, setFocusModel, setLearningDisplay, setSavedSignature, setStatus, setStoredDraft, setToast]);

  const stagePreset = useCallback(
    async (presetId: string): Promise<boolean> => {
      const isCurrent = captureSettingsOwnership();
      setSaving(true);
      try {
        const response = await apiFetch(
          apiUrl(`/api/settings/presets/${presetId}/draft`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draftEnvelope()),
          },
        );
        if (!isCurrent()) return false;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as {
          draft: StoredDraft | null;
        };
        if (!isCurrent()) return false;
        const stored = payload.draft;
        const pending = new Map(Object.entries(stored?.extensions ?? {}));

        pendingRef.current.clear();
        for (const [key, value] of pending.entries()) {
          pendingRef.current.set(key, value);
        }
        syncPendingKeys();
        if (stored?.catalog) setDraft(cloneCatalog(stored.catalog));
        setStoredDraft(stored);
        setSavedSignature(
          JSON.stringify({
            catalog: catalogEditable ? (stored?.catalog ?? draft) : null,
            extensions: JSON.stringify(Object.fromEntries(pending.entries())),
          }),
        );
        setDraftRevision((value) => value + 1);
        setToast("Preset loaded as a draft — review before applying");
        return true;
      } catch (err) {
        if (!isCurrent()) return false;
        setToast(
          `Could not load the preset: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      } finally {
        if (isCurrent()) setSaving(false);
      }
    },
    [captureSettingsOwnership, catalogEditable, draft, draftEnvelope, pendingRef, setDraft, setDraftRevision, setSavedSignature, setSaving, setStoredDraft, setToast, syncPendingKeys],
  );

  const discardDraft = useCallback(async () => {
    const isCurrent = captureSettingsOwnership();
    setApplying(true);
    try {
      const response = await apiFetch(apiUrl("/api/settings/draft"), {
        method: "DELETE",
      });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      clearPending();
      setStoredDraft(null);
      setSavedSignature(null);
      setDraft(cloneCatalog(catalog));
      setToast("Draft discarded");
      setDraftRevision((value) => value + 1);
    } catch (err) {
      if (!isCurrent()) return;
      setToast(
        `Could not discard the draft: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (isCurrent()) setApplying(false);
    }
  }, [captureSettingsOwnership, catalog, clearPending, setApplying, setDraft, setDraftRevision, setSavedSignature, setStoredDraft, setToast]);

  return {
    saveDraft,
    applyService,
    saveRegistry,
    saveProvider,
    applyCatalog,
    stagePreset,
    discardDraft,
  };
}
