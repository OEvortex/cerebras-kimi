import type { ResponseLanguage } from "@/context/languages";

export type ResponseLanguageOption = {
  value: ResponseLanguage;
  label: string;
};

/** English is the only supported reply language. */
export const RESPONSE_LANGUAGE_OPTIONS: readonly ResponseLanguageOption[] = [
  { value: "en", label: "English" },
];
