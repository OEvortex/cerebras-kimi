import type { AppLanguage } from "@/context/languages";

export type ToolAvailabilityLanguage = AppLanguage;

export type ToolAvailabilityCopy = {
  badge: string;
  detail: string;
  href?: string;
};

export function toolEffectiveEnabled(
  savedEnabled: boolean,
  available: boolean,
  comingSoon: boolean,
): boolean {
  return savedEnabled && available && !comingSoon;
}

export function toolAvailabilityCopy(
  reason: string | null | undefined,
  _language: ToolAvailabilityLanguage,
): ToolAvailabilityCopy {
  if (reason === "search_provider_not_configured") {
    return {
      badge: "Not configured",
      detail:
        "Choose a provider in Search settings first. DuckDuckGo needs no API key.",
      href: "/settings#search",
    };
  }
  if (reason === "search_credentials_missing") {
    return {
      badge: "Credentials missing",
      detail:
        "The selected search provider needs credentials. Check Search settings.",
      href: "/settings#search",
    };
  }
  return {
    badge: "Unavailable",
    detail: "This tool's runtime service is unavailable.",
  };
}
