import type { ResponseLanguage } from "@/context/languages";

export type ResponseLanguageOption = {
  value: ResponseLanguage;
  label: string;
};

/**
 * Every reply language the backend accepts, in a light module so pickers can
 * offer the full list without importing the settings store.
 */
export const RESPONSE_LANGUAGE_OPTIONS: readonly ResponseLanguageOption[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese (Simplified)" },
  { value: "zh-tw", label: "Chinese (Traditional)" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ru", label: "Russian" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "ar", label: "Arabic" },
  { value: "pl", label: "Polish" },
  { value: "uk", label: "Ukrainian" },
  { value: "ms", label: "Malay" },
  { value: "vi", label: "Vietnamese" },
  { value: "tr", label: "Turkish" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
];
