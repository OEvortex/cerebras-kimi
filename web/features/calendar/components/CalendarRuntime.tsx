'use client'

import { useModules } from '@/hooks/useModules'
import { browserStorage } from '@/shared/storage'
import { useEffect, type ReactNode } from 'react'

import { notify } from '@/lib/notifications'
import { recentCronReports } from '@/lib/cron-api'
import { startCalendarSync, useCalendarRevision } from '../store/calendar-store'
import { listOccurrences } from '../transport/api'
import { browserTimeZone, formatTime } from '../model/dates'

/** Reminders work anywhere in the signed-in app while a tab is open. */
export default function CalendarRuntime({ children }: { children: ReactNode }) {
  
  const { modules } = useModules()
  const enabled = Boolean(modules?.some(module => module.id === 'calendar' && module.enabled))
  const revision = useCalendarRevision()
  useEffect(() => {
    if (enabled) return startCalendarSync()
  }, [enabled])
  // Scheduled reminders fire in the backend; poll the report buffer so an open
  // tab shows them without reloading the conversation they landed in.
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const key = 'deeptutor.cron.reminders'
    let since = Date.now() / 1000
    const seen = (): Record<string, number> => {
      try {
        return JSON.parse(browserStorage.readRaw('local', key) ?? '{}') as Record<string, number>
      } catch {
        return {}
      }
    }
    let running = false
    const check = async () => {
      if (running) return
      running = true
      try {
        const result = await recentCronReports(since, controller.signal)
        if (controller.signal.aborted) return
        const now = Date.now()
        let delivered = seen()
        for (const report of result.reports) {
          since = Math.max(since, report.at + 0.001)
          if (delivered[report.id]) continue
          delivered = Object.fromEntries(
            Object.entries(delivered).filter(([, at]) => at > now - 2 * 86400_000)
          )
          delivered[report.id] = now
          // A reminder text is already the finished message; title is the job.
          notify(report.text || report.name, { durationMs: 15000 })
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              const notification = new Notification(report.name || "Reminder", {
                body: report.text,
                tag: report.id,
              })
              notification.onclick = () => {
                window.focus()
                notification.close()
              }
            } catch {}
          }
        }
        browserStorage.writeRaw('local', key, JSON.stringify(delivered))
      } catch {
        /* Offline or no cron service: retry on the next tick. */
      } finally {
        running = false
      }
    }
    void check()
    const timer = setInterval(() => void check(), 30_000)
    const focus = () => void check()
    window.addEventListener('focus', focus)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [enabled])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let running = false
    const check = async () => {
      if (running) return
      running = true
      try {
        const now = Date.now()
        const result = await listOccurrences(
          {
            start: new Date(now - 86400_000).toISOString(),
            end: new Date(now + 29 * 86400_000).toISOString(),
            tz: browserTimeZone(),
          },
          controller.signal
        )
        if (controller.signal.aborted) return
        for (const occurrence of result.occurrences) {
          const start = new Date(occurrence.start).getTime()
          for (const [index, minutes] of occurrence.reminders.entries()) {
            const due = new Date(occurrence.reminder_times[index]).getTime()
            if (!Number.isFinite(due)) continue
            if (due > now || due < now - 90_000) continue
            const deliver = () => {
              if (controller.signal.aborted) return
              const key = 'deeptutor.calendar.reminders'
              let seen: Record<string, number> = {}
              try {
                seen = JSON.parse(browserStorage.readRaw('local', key) ?? '{}')
              } catch {}
              const id = `${occurrence.id}:${occurrence.start}:${minutes}`
              if (seen[id]) return
              seen = Object.fromEntries(
                Object.entries(seen).filter(([, time]) => time > now - 2 * 86400_000)
              )
              seen[id] = now
              try {
                browserStorage.writeRaw('local', key, JSON.stringify(seen))
              } catch {}
              const title = occurrence.title || "(No title)"
              const message = occurrence.all_day
                ? title
                : `${title} · ${formatTime(new Date(start), "en")}`
              notify(message, { durationMs: 15000 })
              if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                try {
                  const notification = new Notification(title, { body: message, tag: id })
                  notification.onclick = () => {
                    window.focus()
                    notification.close()
                  }
                } catch {}
              }
            }
            if (navigator.locks)
              await navigator.locks.request('deeptutor-calendar-reminder', deliver)
            else deliver()
          }
        }
      } catch {
        /* Network failures retry on focus or the next tick. */
      } finally {
        running = false
      }
    }
    void check()
    const timer = setInterval(() => void check(), 30_000)
    const focus = () => void check()
    window.addEventListener('focus', focus)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [revision, "en", enabled])
  return children
}
