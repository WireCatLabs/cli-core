import { CliError } from "@wirecat/cli-base"
import { isCliFailure } from "../errors/failures.js"
import type { EntryInput, EventStore, StoredCalendar } from "../meetings/index.js"
import type { CalendarExpander, CalendarSource, SyncWindow } from "./source.js"

const DAY = 86_400_000

/** What the engine keeps in `EventStore.cursor`: the provider's token, the window it covers, the last full round. */
export interface CalendarCursor {
  v: 1
  token: string | null
  window: SyncWindow
  fullAt: number
}

export const parseCalendarCursor = (value: string | null): CalendarCursor | null => {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as Partial<CalendarCursor> | null
    if (
      parsed?.v !== 1 ||
      (parsed.token !== null && typeof parsed.token !== "string") ||
      typeof parsed.fullAt !== "number" ||
      typeof parsed.window?.from !== "number" ||
      typeof parsed.window.to !== "number"
    )
      return null
    return { v: 1, token: parsed.token, window: parsed.window, fullAt: parsed.fullAt }
  } catch {
    return null
  }
}

/**
 * One year back and three months ahead (NEED-1706), from the start of today in UTC. Whole days, so the window moves
 * once a day: a source whose cursor holds the window lists everything again once a day, not on every run.
 */
export const calendarSyncWindow = (now: number): SyncWindow => {
  const day = new Date(now)
  const [year, month, date] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()]
  return { from: Date.UTC(year - 1, month, date), to: Date.UTC(year, month + 3, date) }
}

export interface CalendarSyncOptions {
  /** The calendar account; never a default. */
  accountId: number
  now?: number
  /** List every synced calendar's window again instead of reading changes. */
  full?: boolean
  /** Instead of `calendarSyncWindow(now)`. */
  window?: SyncWindow
  /** Required for a source with `expands: "local"`. */
  expand?: CalendarExpander
}

export interface CalendarSyncResult {
  calendarId: number
  externalId: string
  title: string | null
  /** `full`: the whole window was listed and entries it did not return were marked; `changes`: only what changed. */
  round: "full" | "changes"
  /** The cursor was dead, so the round became a full one. */
  reset: boolean
  saved: number
  removed: number
  occurrences: number
  /** Entries a full round did not return, now marked deleted. */
  unseen: number
  /** Set when the calendar failed; its cursor stays where it was, so the next run retries the same changes. */
  error?: string
}

export interface CalendarSyncReport {
  provider: string
  accountId: number
  window: SyncWindow
  /** Calendars the provider listed. */
  calendars: number
  synced: CalendarSyncResult[]
  /** Listed calendars the owner does not sync (`calendars sync <id>` turns one on). */
  notSynced: { calendarId: number; externalId: string; title: string | null }[]
  /** Every synced calendar finished. */
  complete: boolean
}

/** What one round read and saved; the token is the source's next cursor. */
interface Round {
  token: string | null
  saved: number
  removed: number
  series: EntryInput[]
}

const roundOf = async (
  source: CalendarSource,
  store: EventStore,
  calendar: StoredCalendar,
  cursor: string | null,
  window: SyncWindow,
  now: number,
): Promise<Round | "reset"> => {
  const round: Round = { token: null, saved: 0, removed: 0, series: [] }
  const seen = new Set<string>()
  let page: string | undefined
  for (;;) {
    const result = await source.changes(calendar, { cursor, window, ...(page === undefined ? {} : { page }) })
    if ("reset" in result) return "reset"
    if (result.entries.length) {
      await store.saveEntries(calendar.id, result.entries, now)
      round.saved += result.entries.length
      for (const entry of result.entries) if (entry.kind === "series") round.series.push(entry)
    }
    if (result.removed.length) round.removed += await store.removeEntries(calendar.id, result.removed, now)
    if (result.nextPage === undefined) {
      round.token = result.cursor ?? null
      return round
    }
    if (seen.has(result.nextPage))
      throw new CliError("invalid_response", `${source.provider} returned the same page twice`)
    seen.add(result.nextPage)
    page = result.nextPage
  }
}

const occurrencesOf = async (
  source: CalendarSource,
  store: EventStore,
  calendar: StoredCalendar,
  series: EntryInput[],
  window: SyncWindow,
  now: number,
  expand: CalendarExpander | undefined,
): Promise<number> => {
  if (source.traits.expands === "in-changes") return 0
  let saved = 0
  for (const one of series) {
    if (one.status === "cancelled") continue
    const slots =
      source.traits.expands === "local"
        ? await (expand as CalendarExpander)(one, window)
        : await (source.occurrences as NonNullable<CalendarSource["occurrences"]>)(calendar, one.externalId, window)
    if (!slots.length) continue
    await store.saveEntries(calendar.id, slots, now)
    saved += slots.length
  }
  return saved
}

const syncOne = async (
  source: CalendarSource,
  store: EventStore,
  calendar: StoredCalendar,
  { full: asked, window, now, expand }: { full: boolean; window: SyncWindow; now: number; expand?: CalendarExpander },
): Promise<CalendarSyncResult> => {
  const stored = parseCalendarCursor(await store.cursor(calendar.id))
  const windowMoved = stored !== null && (stored.window.from !== window.from || stored.window.to !== window.to)
  // A full round once a day also asks every series for its slots again, which an incremental round does only for
  // the series that changed (foundation §6.2 step 7).
  let full =
    asked ||
    source.traits.fullListOnly ||
    stored === null ||
    stored.token === null ||
    (source.traits.cursorHoldsWindow && windowMoved) ||
    now - stored.fullAt >= DAY
  let reset = false
  let round = await roundOf(source, store, calendar, full ? null : (stored?.token ?? null), window, now)
  if (round === "reset") {
    if (full) throw new CliError("invalid_response", `${source.provider} refused a full list as a dead cursor`)
    reset = true
    full = true
    await store.setCursor(calendar.id, null, now)
    round = await roundOf(source, store, calendar, null, window, now)
    if (round === "reset")
      throw new CliError("invalid_response", `${source.provider} refused a full list as a dead cursor`)
  }
  const occurrences = await occurrencesOf(source, store, calendar, round.series, window, now, expand)
  const unseen = full ? await store.markUnseen(calendar.id, now, window, now) : 0
  const cursor: CalendarCursor = { v: 1, token: round.token, window, fullAt: full ? now : (stored?.fullAt ?? now) }
  await store.setCursor(calendar.id, JSON.stringify(cursor), now)
  return {
    calendarId: calendar.id,
    externalId: calendar.externalId,
    title: calendar.title,
    round: full ? "full" : "changes",
    reset,
    saved: round.saved,
    removed: round.removed,
    occurrences,
    unseen,
  }
}

/**
 * Brings one calendar account's synced calendars up to date (foundation §6.2): the calendar list first, then for
 * each synced calendar its changes since the cursor, or a full list of the window, then the slots of the series that
 * changed. Each calendar's cursor is saved last, only when all of it saved; a calendar that fails keeps its old one
 * and the others go on.
 */
export const syncCalendars = async (
  source: CalendarSource,
  store: EventStore,
  options: CalendarSyncOptions,
): Promise<CalendarSyncReport> => {
  const now = options.now ?? Date.now()
  const window = options.window ?? calendarSyncWindow(now)
  if (source.traits.expands === "local" && !options.expand)
    throw new CliError("configuration_error", `${source.provider} needs a local expander for its repeating events`)
  if (source.traits.expands === "on-request" && !source.occurrences)
    throw new CliError("configuration_error", `${source.provider} expands on request but has no occurrences()`)
  const listed = await store.saveCalendars(options.accountId, await source.calendars(), now)
  const report: CalendarSyncReport = {
    provider: source.provider,
    accountId: options.accountId,
    window,
    calendars: listed.length,
    synced: [],
    notSynced: [],
    complete: true,
  }
  for (const calendar of listed) {
    if (!calendar.synced) {
      report.notSynced.push({ calendarId: calendar.id, externalId: calendar.externalId, title: calendar.title })
      continue
    }
    try {
      report.synced.push(
        await syncOne(source, store, calendar, {
          full: options.full === true,
          window,
          now,
          ...(options.expand ? { expand: options.expand } : {}),
        }),
      )
    } catch (error) {
      report.complete = false
      report.synced.push({
        calendarId: calendar.id,
        externalId: calendar.externalId,
        title: calendar.title,
        round: options.full ? "full" : "changes",
        reset: false,
        saved: 0,
        removed: 0,
        occurrences: 0,
        unseen: 0,
        // An adapter's own failure says what went wrong; anything else may carry a request URL with a token in it.
        error: isCliFailure(error) ? error.message : "the calendar could not be synced",
      })
    }
  }
  return report
}
