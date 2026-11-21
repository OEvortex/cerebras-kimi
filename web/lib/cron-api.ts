import { apiFetch } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'

/**
 * Scheduled reminders (`/api/cron`). A job is one of: a one-off `at` time, a
 * fixed `every_seconds` interval, or a `cron_expr`. Jobs created from a chat
 * turn carry the session their result lands in; jobs created here are
 * notify-only and surface through `/api/cron/reports`.
 */

export type CronKind = 'at' | 'every' | 'cron'

export interface CronJob {
  id: string
  name: string
  message: string
  kind: CronKind
  at_ms: number | null
  every_seconds: number | null
  expr: string | null
  tz: string | null
  enabled: boolean
  session_id: string
  workspace_id: string
  next_run_at_ms: number | null
  last_status: string | null
  last_error: string | null
}

export interface CronReport {
  id: string
  job_id: string
  name: string
  text: string
  status: string
  /** Epoch seconds. */
  at: number
}

export interface CreateCronJob {
  message: string
  name?: string
  /** ISO 8601 moment; the browser's local zone is used when it has no offset. */
  at?: string
  every_seconds?: number
  cron_expr?: string
  tz?: string
  session_id?: string
  workspace_id?: string
}

const endpoint = '/api/cron'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${endpoint}${path}`, {
    cache: 'no-store',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = String((await response.json())?.detail ?? '')
    } catch {
      /* no body */
    }
    throw new Error(detail || `Reminder request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export function createCronJob(payload: CreateCronJob) {
  return json<{ job: CronJob; ok: boolean }>('/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function recentCronReports(since: number, signal?: AbortSignal) {
  return json<{ reports: CronReport[] }>(
    `/reports?since=${encodeURIComponent(String(Math.max(0, Math.floor(since))))}&limit=20`,
    { signal }
  )
}

/** Same-origin URL the calendar's reminder runtime can poll. */

