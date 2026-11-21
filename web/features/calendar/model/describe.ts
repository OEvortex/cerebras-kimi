import { addDays, dateKey, formatDate, formatTime } from './dates'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Reminder offsets are minutes before the start. All-day events start at
 * midnight, so their offsets read as a clock time: -540 is 09:00 on the
 * day, 900 is 09:00 the day before.
 */

function clockAfterMidnight(minutes: number, locale: string): string {
  return formatTime(new Date(2000, 0, 1, 0, minutes), locale)
}

export function describeReminder(
  minutes: number,
  allDay: boolean,
  locale: string
): string {
  if (allDay) {
    if (minutes <= 0)
      return `On the day at ${clockAfterMidnight(-minutes, locale)}`
    const days = Math.ceil(minutes / 1440)
    const time = clockAfterMidnight(days * 1440 - minutes, locale)
    return days === 1
      ? `The day before at ${time}`
      : `${days} days before at ${time}`
  }
  if (minutes === 0) return "At the start time"
  if (minutes % 10080 === 0) return `${minutes / 10080} weeks before`
  if (minutes % 1440 === 0) return `${minutes / 1440} days before`
  if (minutes % 60 === 0) return `${minutes / 60} hours before`
  return `${minutes} minutes before`
}

/** "Sat, Oct 17 · 09:00 – 10:00", "Oct 17 – 19", "Oct 17 22:00 – Oct 18 01:00". */
export function describeWhen(start: Date, end: Date, allDay: boolean, locale: string): string {
  const day = (date: Date) =>
    formatDate(date, locale, { month: 'short', day: 'numeric', weekday: 'short' })
  if (allDay) {
    const last = addDays(end, -1)
    return dateKey(last) <= dateKey(start) ? day(start) : `${day(start)} – ${day(last)}`
  }
  const lastMoment = new Date(Math.max(start.getTime(), end.getTime() - 1))
  if (dateKey(lastMoment) === dateKey(start))
    return `${day(start)} · ${formatTime(start, locale)} – ${formatTime(end, locale)}`
  return `${day(start)} ${formatTime(start, locale)} – ${day(end)} ${formatTime(end, locale)}`
}

export function describeEvery(seconds: number): string {
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} days`
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hours`
  return `Every ${Math.max(1, Math.round(seconds / 60))} minutes`
}
