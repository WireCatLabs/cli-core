import { CliError } from "@wirecat/cli-base"
import { dayBoundary, zonedMoment } from "@wirecat/cli-base/query"
import type { EventStore, StoredCalendar } from "../meetings/index.js"
import { calendarIn, plusDays } from "./reads.js"
import type { BusyTimes, CalendarSource, SyncWindow } from "./source.js"

export const BUSY_QUERY_HELP = `
Words, any order:
  today | week            today, or today and the next six days, in your time zone
  from:<date> to:<date>   from the start of one day through the end of another (or a time with a zone)
  calendar:<id>           one of the account's calendars, by its id or the provider's id; repeat for more
  person:<email>          someone else, by email address; repeat for more
Without a time word: this week. Without calendar:, every calendar that syncs.`

/** Google's `calendarExpansionMax` tops out at 50; Graph's getSchedule takes 100. */
const MOST = 50
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/u
const MINUTE = 60_000

export interface BusyQuery {
  window: SyncWindow
  calendars: StoredCalendar[]
  people: string[]
}

const localDate = (at: number, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)

const span = (text: string) => ({ start: 0, end: text.length })

export const busyQuery = async (
  words: readonly string[],
  context: { store: EventStore; accountId: number; zone: string; now: number },
): Promise<BusyQuery> => {
  const today = localDate(context.now, context.zone)
  const day = (date: string) => dayBoundary(date, context.zone, false, span(date))
  let from: number | undefined
  let to: number | undefined
  const calendars: StoredCalendar[] = []
  const people = new Set<string>()
  for (const word of words) {
    const [, field, value = ""] = /^([a-z]+):(.+)$/u.exec(word) ?? []
    if (word === "today" || word === "week") {
      from = day(today)
      to = day(plusDays(today, word === "today" ? 1 : 7))
    } else if (field === "from") from = zonedMoment(value, context.zone, span(value))
    else if (field === "to") to = zonedMoment(value, context.zone, span(value), { end: true }) + 1
    else if (field === "calendar") {
      const calendar = await calendarIn(context.store, context.accountId, value)
      if (!calendars.some(({ id }) => id === calendar.id)) calendars.push(calendar)
    } else if (field === "person") {
      const email = value.trim().toLowerCase()
      if (!EMAIL.test(email)) throw new CliError("validation_error", `${value} is not an email address`)
      people.add(email)
    } else
      throw new CliError("validation_error", `${word} is not a calendars busy word${BUSY_QUERY_HELP}`, {
        reason: "query.unknown_word",
      })
  }
  from ??= day(today)
  to ??= from === day(today) ? day(plusDays(today, 7)) : from + 7 * 86_400_000
  if (to <= from) throw new CliError("validation_error", "the window ends before it starts")
  const asked = calendars.length
    ? calendars
    : (await context.store.calendars(context.accountId)).filter(({ synced, deletedAt }) => synced && !deletedAt)
  if (asked.length === 0 && people.size === 0)
    throw new CliError("validation_error", "no calendar syncs yet; name one with calendar:<id>, or a person:<email>", {
      reason: "busy.no-calendars",
    })
  if (asked.length + people.size > MOST)
    throw new CliError("validation_error", `at most ${MOST} calendars and people at once`)
  return { window: { from, to }, calendars: asked, people: [...people] }
}

export interface WorkingHours {
  /** Minutes after local midnight. */
  start: number
  end: number
}

export const workingHoursOf = (text: string): WorkingHours => {
  const match = HOURS.exec(text.trim())
  const [start, end] = match ? [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])] : []
  if (start === undefined || end === undefined || end <= start || end > 24 * 60)
    throw new CliError("validation_error", "working hours are HH:MM-HH:MM in your time zone, such as 09:00-17:00")
  return { start, end }
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`

/** Each weekday's working hours as moments in `zone`, so a day that changes its clock is still read in local time. */
const workingSpans = (window: SyncWindow, hours: WorkingHours, zone: string): SyncWindow[] => {
  const spans: SyncWindow[] = []
  const last = localDate(window.to - 1, zone)
  for (let date = localDate(window.from, zone); date <= last; date = plusDays(date, 1)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const at = (minutes: number) =>
      minutes === 24 * 60
        ? dayBoundary(plusDays(date, 1), zone, false, span(date))
        : zonedMoment(`${date}T${clock(minutes)}`, zone, span(date))
    spans.push({ from: at(hours.start), to: at(hours.end) })
  }
  return spans
}

/**
 * The stretches of at least `minutes` inside working hours on weekdays, after `now`, that no busy time touches.
 * A stretch is returned whole; the caller picks where in it to put the meeting.
 */
export const freeSlots = (
  busy: readonly SyncWindow[],
  window: SyncWindow,
  options: { minutes: number; hours: WorkingHours; zone: string; now: number },
): SyncWindow[] => {
  const taken = [...busy].sort((a, b) => a.from - b.from)
  const slots: SyncWindow[] = []
  for (const day of workingSpans(window, options.hours, options.zone)) {
    let cursor = Math.max(day.from, window.from, options.now)
    const end = Math.min(day.to, window.to)
    for (const one of taken) {
      if (one.to <= cursor || one.from >= end) continue
      if (one.from - cursor >= options.minutes * MINUTE) slots.push({ from: cursor, to: one.from })
      cursor = Math.max(cursor, one.to)
    }
    if (end - cursor >= options.minutes * MINUTE) slots.push({ from: cursor, to: end })
  }
  return slots
}

const iso = (at: number) => new Date(at).toISOString()
const times = ({ from, to }: SyncWindow) => ({ start: iso(from), end: iso(to) })

/**
 * `calendars busy`: the provider's busy times for the query, and with `slot` the free stretches every calendar and
 * person shares. Nothing is stored, and a person appears only by the address the caller gave.
 */
export const busyAnswer = async (
  source: CalendarSource,
  query: BusyQuery,
  options: { zone: string; now: number; slot?: { minutes: number; hours: WorkingHours } },
) => {
  if (!source.freeBusy) throw new CliError("configuration_error", "this calendar provider cannot tell busy times")
  const answered = await source.freeBusy({
    calendars: query.calendars.map(({ externalId }) => externalId),
    people: query.people,
    window: query.window,
  })
  const byId = new Map<string, BusyTimes>(answered.map((one) => [one.id, one]))
  const missing = (id: string): BusyTimes => byId.get(id) ?? { id, busy: [], error: "notAnswered" }
  const rows = [
    ...query.calendars.map((calendar) => ({ calendar: String(calendar.id), ...missing(calendar.externalId) })),
    ...query.people.map((person) => ({ person, ...missing(person) })),
  ]
  const unknown = rows.filter(({ error }) => error !== undefined).map(({ id }) => id)
  return {
    ...times(query.window),
    timezone: options.zone,
    calendars: rows.map(({ busy, error, ...row }) => ({
      ...row,
      busy: busy.map(times),
      ...(error === undefined ? {} : { error }),
    })),
    ...(options.slot
      ? {
          slots: freeSlots(
            rows.flatMap(({ busy }) => busy),
            query.window,
            { ...options.slot, zone: options.zone, now: options.now },
          ).map(times),
          // Free here means free in every calendar the provider answered for: these were not.
          ...(unknown.length ? { unknown } : {}),
        }
      : {}),
  }
}
