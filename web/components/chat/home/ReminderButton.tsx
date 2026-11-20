'use client'

import { AlarmClock, Check } from 'lucide-react'
import { usePathname } from '@/shared/router/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createCronJob } from '@/lib/cron-api'
import Tooltip from '@/shared/ui/Tooltip'
import { notify } from '@/lib/notifications'
import { activeWorkspaceId } from '@/lib/workspace-scope'
import { browserTimeZone } from '@/shared/lib/date'

/**
 * "Remind me" for the composer toolbar.
 *
 * Schedules one reminder into the cron service: one-off (30 min, 1 hour,
 * tonight, tomorrow 09:00) or repeating daily/weekly at 09:00. When the
 * conversation has its own session the reminder runs a turn there; from the
 * home screen it is notify-only and surfaces as an in-app toast plus a
 * desktop notification. Reminders also appear on the calendar.
 */

type Preset = 'in30' | 'in60' | 'tonight' | 'tomorrow'
type Repeat = 'once' | 'daily' | 'weekly'

function atFor(preset: Preset): Date {
  const now = new Date()
  if (preset === 'in30') return new Date(now.getTime() + 30 * 60_000)
  if (preset === 'in60') return new Date(now.getTime() + 60 * 60_000)
  const target = new Date(now)
  if (preset === 'tonight') {
    target.setHours(20, 0, 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return target
  }
  target.setDate(target.getDate() + 1)
  target.setHours(9, 0, 0, 0)
  return target
}

function isoLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

export default function ReminderButton({ className = '' }: { className?: string }) {
  
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [preset, setPreset] = useState<Preset>('in30')
  const [repeat, setRepeat] = useState<Repeat>('once')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)

  // The session a reminder should reply into, when the tab is in a conversation.
  const sessionId = /^\/chat\/([^/?#]+)/.exec(pathname ?? '')?.[1] ?? ''

  useEffect(() => {
    if (!open) return
    textRef.current?.focus()
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const save = useCallback(async () => {
    const message = text.trim()
    if (!message) {
      setError("Write what to remind you about.")
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload =
        repeat === 'once'
          ? { message, at: isoLocal(atFor(preset)) }
          : {
              message,
              cron_expr: repeat === 'daily' ? '0 9 * * *' : '0 9 * * 1',
              tz: browserTimeZone(),
            }
      await createCronJob({
        ...payload,
        session_id: sessionId,
        workspace_id: activeWorkspaceId(),
      })
      setOpen(false)
      setText('')
      notify(
        repeat === 'once'
          ? "Reminder set for {{when}}"
          : "Reminder set: every {{cadence}} at 09:00",
        { tone: 'success' }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the reminder.")
    } finally {
      setSaving(false)
    }
  }, [preset, repeat, sessionId, text])

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <Tooltip label={"Remind me"}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={"Remind me"}
        onClick={() => setOpen(value => !value)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors duration-150 ${
          open
            ? 'bg-[var(--primary)]/10 text-[var(--primary)]'
            : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]'
        }`}
      >
        <AlarmClock size={16} strokeWidth={1.7} className="shrink-0" />
        <span className="hidden whitespace-nowrap sm:inline">{"Remind me"}</span>
      </button>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label={"Remind me"}
          className="dt-popup-up absolute bottom-full left-0 z-50 mb-1.5 w-[300px] rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3 text-[13px] shadow-lg backdrop-blur-md"
        >
          <label className="mb-1.5 block text-[12px] font-medium text-[var(--muted-foreground)]">
            {"What should I remind you about?"}
          </label>
          <textarea
            ref={textRef}
            value={text}
            onChange={event => setText(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder={"Revise the water cycle for 20 minutes"}
            className="mb-2 w-full resize-none rounded-lg border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-[var(--primary)]"
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void save()
              }
            }}
          />

          {repeat === 'once' ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {(
                [
                  ['in30', "In 30 min"],
                  ['in60', "In 1 hour"],
                  ['tonight', "Tonight"],
                  ['tomorrow', "Tomorrow 9:00"],
                ] as [Preset, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPreset(value)}
                  aria-pressed={preset === value}
                  className={`rounded-full px-2.5 py-1 text-[12px] transition-colors ${
                    preset === value
                      ? 'bg-[var(--primary)]/12 text-[var(--primary)]'
                      : 'bg-[var(--muted)]/45 text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          <label className="mb-2 flex items-center gap-2 text-[12px] text-[var(--muted-foreground)]">
            <span>{"Repeat"}</span>
            <select
              value={repeat}
              onChange={event => setRepeat(event.target.value as Repeat)}
              className="rounded-md border border-[var(--border)] bg-[var(--popover)] px-1.5 py-1 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
            >
              {/* Native option popups ignore inherited colors in dark themes:
                  without explicit tokens Chrome paints a white list with light
                  text, making every choice invisible. */}
              <option value="once" className="bg-[var(--popover)] text-[var(--popover-foreground)]">
                {"Once"}
              </option>
              <option
                value="daily"
                className="bg-[var(--popover)] text-[var(--popover-foreground)]"
              >
                {"Daily at 09:00"}
              </option>
              <option
                value="weekly"
                className="bg-[var(--popover)] text-[var(--popover-foreground)]"
              >
                {"Weekly on Monday 09:00"}
              </option>
            </select>
          </label>

          {error ? <p className="mb-2 text-[12px] text-red-600">{error}</p> : null}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-[var(--muted-foreground)]">
              {sessionId ? "Replies in this conversation" : "Shows as a notification"}
            </span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-2.5 py-1 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-60"
            >
              <Check size={14} strokeWidth={2.2} />
              {saving ? "Saving…" : "Set reminder"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
