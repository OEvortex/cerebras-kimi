/** The app ships one interface language. */
export type AppLanguage = "en";

/** Stored values that used to mean another interface language. */
export function normalizeLanguage(_value: unknown): AppLanguage {
  return "en";
}

/** Model output is always English. */
export type ResponseLanguage = "en";
