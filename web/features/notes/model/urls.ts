/** Same policy as the persisted note schema; never render executable URLs. */
export function safeNoteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Browsers can fold control characters into a scheme, and a leading `//`
  // turns a path into a protocol-relative URL pointing at another origin.
  if (/[\x00-\x1f\x7f]/.test(trimmed) || trimmed.startsWith('//')) return null
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  // Only http(s)/mailto may navigate; bare relative paths resolve against our
  // own origin and are safe. Everything else (javascript:, data:, …) is not.
  if (scheme && !/^(https?|mailto):/i.test(trimmed)) return null
  return trimmed
}
