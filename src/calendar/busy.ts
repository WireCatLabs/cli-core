import { CliError } from "@wirecat/cli-base"
import {
  dayBoundary,
  type Predicate,
  type QueryRegistry,
  queryError,
  queryFieldsOf,
  zonedMoment,
} from "@wirecat/cli-base/query"
import { LIST_QUERY_GUIDE, listQuery, nativeTermLists, type QueryWords, typedQuery } from "../cli/list-query.js"
import type { EventStore, StoredCalendar } from "../meetings/index.js"
import { calendarBusy } from "./cli/answers.js"
import { calendarIn, plusDays, timeWindow } from "./reads.js"
import type { BusyTimes, CalendarSource, SyncWindow } from "./source.js"

/** Google answers for 50 calendars at most (`calendarExpansionMax`, reference/freebusy/query). */
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

const BUSY = "calendars busy"

const bound = (field: string, side: "lower" | "upper", example: string) => (node: Predicate) => {
  const open = node.operator === "range" && (side === "lower" ? node.upper === "*" : node.value === "*")
  if (!open)
    queryError(
      "query.unsupported-operator",
      node.span,
      `${field} takes only ${side === "lower" ? "the window's start" : "the window's end"}, such as ${example}`,
      { command: BUSY, guide: LIST_QUERY_GUIDE },
    )
}

/**
 * `calendars busy`'s query: the window by the answer's own `start` and `end`, and whom to ask. `calendar` and
 * `person` repeat, and every one named is asked: the free stretches are those they all share.
 */
export const BUSY_QUERY: QueryRegistry = {
  entity: "calendar_busy",
  backend: "native",
  fields: queryFieldsOf(calendarBusy, {
    native: ["start", "end", "calendar", "person"],
    relations: {
      calendar: {
        type: "kw",
        example: "calendar:3",
        relation: "one of the account's calendars, by its id or the provider's id; repeat for more",
      },
      person: { type: "kw", example: "person:ana@example.com", relation: "someone else, by address; repeat for more" },
    },
    examples: { start: "start>=2026-11-02", end: "end<=2026-11-06" },
    validate: {
      start: bound("start", "lower", "start>=2026-11-02"),
      end: bound("end", "upper", "end<=2026-11-06"),
    },
  }).map((field) =>
    field.native
      ? { ...field, operators: field.type === "time" ? (["range"] as const) : (["term", "phrase"] as const) }
      : field,
  ),
}

export const BUSY_QUERY_NOTE =
  "\nWithout start: from the start of today, in your time zone. Without end: seven days after the start. " +
  "Without calendar: every calendar that syncs."

export const busyQuery = async (
  query: QueryWords,
  context: { store: EventStore; accountId: number; zone: string; now: number },
): Promise<BusyQuery> => {
  const { zone, now } = context
  const today = localDate(now, zone)
  let from: number | undefined
  let to: number | undefined
  const calendars: StoredCalendar[] = []
  const people = new Set<string>()
  const terms = nativeTermLists(listQuery(typedQuery(query), BUSY_QUERY, BUSY), BUSY, ["calendar", "person"])
  for (const [field, nodes] of terms)
    for (const node of nodes) {
      if (field === "start") from = timeWindow(node, zone, now).lower
      else if (field === "end") to = timeWindow(node, zone, now).upper
      else if (field === "calendar") {
        const calendar = await calendarIn(context.store, context.accountId, node.value)
        if (!calendars.some(({ id }) => id === calendar.id)) calendars.push(calendar)
      } else if (field === "person") {
        const email = node.value.trim().toLowerCase()
        if (!EMAIL.test(email)) throw new CliError("validation_error", `${node.value} is not an email address`)
        people.add(email)
      }
    }
  from ??= dayBoundary(today, zone, false, span(today))
  to ??= from + 7 * 86_400_000
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
