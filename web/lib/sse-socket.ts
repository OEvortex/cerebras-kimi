/**
 * WebSocket-shaped client over REST + SSE.
 *
 * The backend no longer exposes /ws. This class keeps the old socket surface
 * (`onopen` / `onmessage` / `onclose` / `send`) so the turn protocol, the legacy
 * feature channels and ReconnectingWebSocket keep working unchanged:
 *
 *   - `send(payload)` POSTs the same JSON the WebSocket carried to
 *     `/api/realtime/commands`.
 *   - inbound notifications arrive on `/api/realtime/events` as named SSE
 *     events and are re-emitted as `{data}` frames, byte-for-byte what the
 *     WebSocket transport delivered after the backend's event unwrapping.
 *
 * A path passed to the constructor may be `/ws`, `/ws/books`, an absolute
 * `ws(s)://…/ws` URL, or an already-migrated `/api/realtime/...` URL.
 */

import { scopedUrl } from '@/lib/workspace-scope'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

export interface SseSocketLike {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: ((error: unknown) => void) | null
  send(data: string): boolean
  close(): void
}

function newClientId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

/** Map a legacy WS path onto the REST command + SSE event endpoints. */
function realtimeEndpoints(path: string): {
  eventsUrl: string
  commandsUrl: string
  channel: string
} {
  let route = path
  if (/^(wss?|https?):\/\//i.test(path)) {
    try {
      const parsed = new URL(path)
      route = `${parsed.pathname}${parsed.search}`
    } catch {
      route = path
    }
  }
  if (route.startsWith('/api/realtime/')) {
    const eventsUrl = route.includes('/events')
      ? route
      : route.replace(/\/commands.*$/, '/events')
    const commandsUrl = route.includes('/commands')
      ? route
      : route.replace(/\/events.*$/, '/commands')
    return { eventsUrl: scopedUrl(eventsUrl), commandsUrl: scopedUrl(commandsUrl), channel: '' }
  }
  const [pathname, query = ''] = route.split('?')
  const channel = pathname.startsWith('/ws/') ? pathname.slice('/ws/'.length) : ''
  const params = new URLSearchParams(query)
  const commands = new URLSearchParams()
  if (channel) commands.set('channel', channel)
  for (const [key, value] of params) if (key !== 'dt_workspace') commands.set(key, value)
  const suffix = commands.toString()
  return {
    eventsUrl: scopedUrl('/api/realtime/events'),
    commandsUrl: scopedUrl(`/api/realtime/commands${suffix ? `?${suffix}` : ''}`),
    channel,
  }
}

export class SseSocket implements SseSocketLike {
  readyState = CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null

  readonly clientId = newClientId()
  private readonly endpoints: ReturnType<typeof realtimeEndpoints>
  private source: EventSource | null = null
  private sendChain: Promise<unknown> = Promise.resolve()
  private sending = false
  private opened = false
  private closed = false

  constructor(path: string) {
    this.endpoints = realtimeEndpoints(path)
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
    let source: EventSource
    try {
      source = new EventSource(
        `${this.endpoints.eventsUrl}${this.join('client_id', this.clientId)}`,
        { withCredentials: true },
      )
    } catch (error) {
      this.onerror?.(error)
      this.readyState = CLOSED
      this.onclose?.()
      return
    }
    this.source = source
    const forward = (event: MessageEvent<string>) => {
      if (this.closed || this.source !== source) return
      this.onmessage?.({ data: event.data })
    }
    source.addEventListener('ready', () => {
      if (this.closed || this.source !== source || this.opened) return
      this.opened = true
      this.readyState = OPEN
      this.onopen?.()
    })
    for (const name of ['turn_event', 'session_update', 'legacy_event', 'message']) {
      source.addEventListener(name, forward as EventListener)
    }
    source.onerror = (error) => {
      if (this.closed || this.source !== source) return
      this.onerror?.(error)
      // Let the owner decide whether to reconnect. EventSource's own retry
      // would race with ReconnectingWebSocket / TurnRuntimeClient backoff.
      source.close()
      this.source = null
      this.readyState = CLOSED
      this.onclose?.()
    }
  }

  private join(key: string, value: string): string {
    const separator = this.endpoints.eventsUrl.includes('?') ? '&' : '?'
    return `${separator}${key}=${encodeURIComponent(value)}`
  }

  send(data: string): boolean {
    if (this.closed || this.readyState !== OPEN) return false
    // Serialize POSTs: the backend queues events in arrival order, and fetch
    // dispatch order alone does not guarantee that. The first send is issued
    // synchronously so commands behave like WebSocket.send().
    const post = async () => {
      if (this.closed) return
      try {
        const separator = this.endpoints.commandsUrl.includes('?') ? '&' : '?'
        const response = await fetch(
          `${this.endpoints.commandsUrl}${separator}client_id=${encodeURIComponent(this.clientId)}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: data,
          },
        )
        if (!response.ok && this.source) this.onerror?.(new Error(`command → ${response.status}`))
      } catch (error) {
        if (!this.closed) this.onerror?.(error)
      }
    }
    if (!this.sending) {
      this.sending = true
      this.sendChain = post().finally(() => {
        this.sending = false
      })
    } else {
      this.sendChain = this.sendChain.then(post)
    }
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = CLOSED
    this.source?.close()
    this.source = null
    // Best-effort server-side cleanup; the hub also reclaims idle clients.
    void fetch(
      `/api/realtime/clients/${encodeURIComponent(this.clientId)}`,
      { method: 'DELETE', credentials: 'include', keepalive: true },
    ).catch(() => {})
  }
}

export function sseSocketFactory(path: string): SseSocketLike {
  return new SseSocket(path)
}
