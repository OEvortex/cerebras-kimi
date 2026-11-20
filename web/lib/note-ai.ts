import { apiFetch, apiUrl } from '@/shared/api/client'

/** AI edits for a note page's selection and whole page. */

export type AiEditMode = 'rewrite' | 'shorten' | 'expand' | 'none'

export const AI_EDIT_MODES: { mode: AiEditMode; label: string }[] = [
  { mode: 'rewrite', label: 'Rewrite' },
  { mode: 'shorten', label: 'Shorten' },
  { mode: 'expand', label: 'Expand' },
]

interface StreamEvent {
  type?: string
  stage?: string
  content?: string
  detail?: string
  edited_text?: string
}

/** One SSE frame → the name of the event and its JSON payload. */
function parseFrame(frame: string): { event: string; data: StreamEvent } | null {
  let event = 'message'
  const data: string[] = []
  for (const raw of frame.split(/\r?\n/)) {
    if (raw.startsWith('event:')) event = raw.slice(6).trim()
    else if (raw.startsWith('data:')) data.push(raw.slice(5).trimStart())
  }
  if (!data.length) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) as StreamEvent }
  } catch {
    return null
  }
}

/**
 * Edit the selected text and stream the result.
 *
 * Resolves with the replacement Markdown once the model finishes. `onDelta`
 * receives each chunk so the panel can show the draft being written.
 */
export async function streamSelectionEdit({
  selectedText,
  instruction,
  mode,
  signal,
  onDelta,
}: {
  selectedText: string
  instruction: string
  mode: AiEditMode
  signal?: AbortSignal
  onDelta?: (text: string) => void
}): Promise<string> {
  const response = await apiFetch(apiUrl('/api/documents/actions/edit-react/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ selected_text: selectedText, instruction, mode, tools: [] }),
  })
  if (!response.ok) {
    const detail = await response
      .json()
      .then(body => String(body?.detail ?? ''))
      .catch(() => '')
    throw new Error(detail || `Edit failed (${response.status})`)
  }
  if (!response.body) throw new Error('The edit stream was empty.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let edited: string | null = null
  let failure = ''

  const handle = (frame: string) => {
    const parsed = parseFrame(frame)
    if (!parsed) return
    if (parsed.event === 'stream' && parsed.data.type === 'content')
      onDelta?.(parsed.data.content ?? '')
    else if (parsed.event === 'result') edited = parsed.data.edited_text ?? ''
    else if (parsed.event === 'error') failure = parsed.data.detail || 'Edit failed.'
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      handle(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) handle(buffer.trim())

  if (failure) throw new Error(failure)
  if (edited === null) throw new Error('The edit finished without a result.')
  return edited
}

/** Annotate a whole page: `[term]` and `<statement>` markers, nothing else. */
export async function autoMarkPage(text: string, signal?: AbortSignal): Promise<string> {
  const response = await apiFetch(apiUrl('/api/documents/actions/automark'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ text }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(String(body?.detail || `Annotation failed (${response.status})`))
  return String(body?.marked_text ?? '')
}
