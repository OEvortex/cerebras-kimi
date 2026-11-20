/** The app ships one interface language. */
export type AppLanguage = "en";

/** Stored values that used to mean another interface language. */
export function normalizeLanguage(_value: unknown): AppLanguage {
  return "en";
}

/** Model output can use more languages than the app UI. */
export type ResponseLanguage =
  | "en"
  | "zh"
  | "zh-tw"
  | "ja"
  | "ko"
  | "es"
  | "fr"
  | "de"
  | "ru"
  | "pt"
  | "it"
  | "ar"
  | "pl"
  | "uk"
  | "ms"
  | "vi"
  | "tr"
  | "hi"
  | "hu";
