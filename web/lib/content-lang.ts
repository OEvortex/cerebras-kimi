/**
 * All assistant content is English. Return the explicit English language tag
 * so rendered content never inherits a different locale from its surroundings.
 */
export function contentLang(
  _language: string | undefined,
): string | undefined {
  return "en";
}
