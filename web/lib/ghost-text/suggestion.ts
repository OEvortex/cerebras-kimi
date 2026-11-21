/**
 * Turning a raw greedy continuation into something worth showing.
 *
 * Kept out of the worker so the rule can be unit-tested without loading
 * onnxruntime: skipping whole words here was what kept the ghost text
 * invisible even when the model produced a good continuation.
 */

/** Below this, a suggestion is noise (a lone "a" or a stray fragment). */
export const GHOST_MIN_CHARS = 3;

export function finalizeSuggestion(raw: string): string {
  // Only trailing whitespace goes: byte-level BPE may end mid-word, but that
  // is far less annoying than discarding a whole continuation.
  const trimmed = raw.trimEnd();
  if (trimmed.length < GHOST_MIN_CHARS) return "";
  return trimmed;
}
