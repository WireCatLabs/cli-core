import { CliError } from "@wirecat/cli-base"
import { type BudgetStop, type RunBudget, runBudget } from "../background/budget.js"
import { progressLine, progressOf } from "../background/checkpoints.js"
import { isCliFailure } from "../errors/failures.js"
import type { EntryInput, EventStore, SeriesSlots, StoredCalendar } from "../meetings/index.js"
import type { CalendarExpander, CalendarSource, SyncWindow } from "./source.js"

const DAY = 86_400_000
/**
 * How far the window's far end may move before a full round asks every series for its slots again. In between it asks
 * only the series that changed, so a series that did not change lacks slots up to this far behind the window's end.
 */
const SLOTS_EVERY = 7 * DAY
/** Series whose slots one transaction saves: a short one, so another process waits for the lock briefly. */
const BATCH_SERIES = 50
const BATCH_SLOTS = 250

/**
 * A round that stopped before its end: where its listing is, and the series still to ask for their slots. A rerun
 * goes on from here with the same window and the same token, since a provider's page token belongs to that query.
 */
export interface PendingRound {
  full: boolean
  /** The token the round reads changes after; `null` for a full list. */
  from: string | null
  window: SyncWindow
  /** Entries a full round has not seen since this moment are the ones it marks. */
  startedAt: number
  /** The round became full because the cursor was dead. */
  reset: boolean
  /** The next page to read; `null` for the first. */
  page: string | null
  listed: boolean
  /** The token the last page gave, once `listed`. */
  next: string | null
  /** Series still to ask for their slots (`expands: "on-request"`). */
  series: string[]
  /** A full round asks every series it lists; otherwise only those that changed. Absent reads as true. */
  everySeries?: boolean
}

/** What the engine keeps in `EventStore.cursor`. Version 1 had no `round`, `updatedAt` or `done`. */
export interface CalendarCursor {
  v: 2
  /** The provider's token after the last finished round. */
  token: string | null
  window: SyncWindow
  /** When the last full round started; 0 before the first. */
  fullAt: number
  /** When the cursor was last saved: a status whose age keeps growing is a sync that is not moving. */
  updatedAt: number | null
  /** Entries saved by the round in progress, or by the last round. */
  done: number
  round: PendingRound | null
  /** Entries an older build marked deleted outside its window are back (`EventStore.restoreUnseen`). */
  restored?: true
  /** The window's end when a full round last asked every series for its slots. */
  slotsTo?: number
}

const isWindow = (value: unknown): value is SyncWindow =>
  typeof (value as SyncWindow | undefined)?.from === "number" && typeof (value as SyncWindow).to === "number"

const isToken = (value: unknown): value is string | null => value === null || typeof value === "string"

const roundOf = (value: unknown): PendingRound | null | undefined => {
  if (value === null || value === undefined) return null
  const round = value as Partial<PendingRound>
  if (
    typeof round.full !== "boolean" ||
    !isToken(round.from) ||
    !isWindow(round.window) ||
    typeof round.startedAt !== "number" ||
    typeof round.reset !== "boolean" ||
    !isToken(round.page) ||
    typeof round.listed !== "boolean" ||
    !isToken(round.next) ||
    !Array.isArray(round.series) ||
    round.series.some((id) => typeof id !== "string") ||
    (round.everySeries !== undefined && typeof round.everySeries !== "boolean")
  )
    return undefined
  const { full, from, window, startedAt, reset, page, listed, next, series, everySeries } = round as PendingRound
  return {
    full,
    from,
    window,
    startedAt,
    reset,
    page,
    listed,
    next,
    series,
    ...(everySeries === false ? { everySeries } : {}),
  }
}

export const parseCalendarCursor = (value: string | null): CalendarCursor | null => {
  if (value === null) return null
  try {
    const cursor = JSON.parse(value) as (Omit<Partial<CalendarCursor>, "v"> & { v?: number }) | null
    if (
      (cursor?.v !== 1 && cursor?.v !== 2) ||
      !isToken(cursor.token) ||
      typeof cursor.fullAt !== "number" ||
      !isWindow(cursor.window)
    )
      return null
    const { token, window, fullAt } = cursor
    if (cursor.v === 1) return { v: 2, token, window, fullAt, updatedAt: null, done: 0, round: null }
    const round = roundOf(cursor.round)
    if (
      round === undefined ||
      (cursor.updatedAt !== null && typeof cursor.updatedAt !== "number") ||
      typeof cursor.done !== "number"
    )
      return null
    return {
      v: 2,
      token,
      window,
      fullAt,
      updatedAt: cursor.updatedAt ?? null,
      done: cursor.done,
      round,
      ...(cursor.restored === true ? { restored: true as const } : {}),
      ...(typeof cursor.slotsTo === "number" ? { slotsTo: cursor.slotsTo } : {}),
    }
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
  /** Start every synced calendar over with a full list of the window, dropping a round in progress. */
  full?: boolean
  /** Instead of `calendarSyncWindow(now)`. */
  window?: SyncWindow
  /** Required for a source with `expands: "local"`. */
  expand?: CalendarExpander
  /** Asked before every request to the source; without one the run goes until every calendar is done. */
  budget?: RunBudget
  /** The run's signal, checked before each save: a cancelled run stops after its current step and keeps its work. */
  signal?: AbortSignal
}

export interface CalendarSyncResult {
  calendarId: number
  externalId: string
  title: string | null
  /** `full`: the whole window was listed and entries it did not return were marked; `changes`: only what changed. */
  round: "full" | "changes"
  /** The cursor was dead, so the round became a full one. */
  reset: boolean
  /** `partial`: the round stopped before its end and the next run goes on from there. */
  state: "partial" | "complete"
  /** What this run saved. */
  saved: number
  removed: number
  occurrences: number
  /** Entries a full round did not return, now marked deleted. */
  unseen: number
  /** Set when the calendar failed; its cursor stays at its last saved page, so the next run goes on from there. */
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
  /** Every synced calendar finished its round and none failed. */
  complete: boolean
  state: "partial" | "complete"
  /** Why the run stopped early: its request budget, its deadline, or a cancel. */
  stopped?: BudgetStop
  /** What this run did, so a partial run still shows that it moves. */
  progress: {
    calendars: number
    calendarsDone: number
    /** Requests made to the source: the calendar list, each page, each series' slots. */
    requests: number
    /** Entries and slots saved. */
    saved: number
    /** Pages read and series expanded, each saved in the cursor: 0 means this run moved nothing on. */
    steps: number
  }
  hint?: string
}

const CONTINUE = "run sync again to continue"

interface Plan {
  source: CalendarSource
  store: EventStore
  calendar: StoredCalendar
  window: SyncWindow
  now: number
  expand: CalendarExpander | undefined
  budget: RunBudget
  signal: AbortSignal | undefined
  /** Called on each page or series saved. */
  moved: () => void
}

const freshRound = (
  full: boolean,
  from: string | null,
  window: SyncWindow,
  now: number,
  reset = false,
  everySeries = true,
): PendingRound => ({
  full,
  from: full ? null : from,
  window,
  startedAt: now,
  reset,
  page: null,
  listed: false,
  next: null,
  series: [],
  ...(everySeries ? {} : { everySeries }),
})

/** The round in progress, or the one this run starts: a full one when due or the only kind the source has. */
const roundFor = (
  source: CalendarSource,
  stored: CalendarCursor | null,
  { window, now }: { window: SyncWindow; now: number },
): PendingRound => {
  if (stored?.round) return stored.round
  const windowMoved = stored !== null && (stored.window.from !== window.from || stored.window.to !== window.to)
  const full =
    source.traits.fullListOnly ||
    stored === null ||
    stored.token === null ||
    (source.traits.cursorHoldsWindow && windowMoved) ||
    now - stored.fullAt >= DAY
  // The daily full round asks only the series that changed, and every series once the window's end moved on far
  // enough that their new slots matter (foundation §6.2 step 7).
  const everySeries = !full || stored?.slotsTo === undefined || window.to - stored.slotsTo >= SLOTS_EVERY
  return freshRound(full, stored?.token ?? null, window, now, false, everySeries)
}

const deadList = (provider: string) =>
  new CliError("invalid_response", `${provider} refused a full list as a dead cursor`)

/**
 * One calendar's round, saved after every page and every series, so a stop — the budget, a cancel, a kill — loses
 * at most the step it was on. Returns why it stopped, or `null` when the round finished.
 */
const syncOne = async (
  { source, store, calendar, window, now, expand, budget, signal, moved }: Plan,
  stored: CalendarCursor | null,
  result: CalendarSyncResult,
): Promise<BudgetStop | null> => {
  let cursor: CalendarCursor = stored ?? {
    v: 2,
    token: null,
    window,
    fullAt: 0,
    updatedAt: null,
    done: 0,
    round: null,
    restored: true,
  }
  if (stored !== null && !stored.restored) {
    // Up to 0.488.0 a full list also marked entries outside its window, which no later list returns to unmark.
    await store.restoreUnseen(calendar.id, calendarSyncWindow, now)
    cursor = { ...cursor, restored: true }
  }
  let round = roundFor(source, stored, { window, now })
  if (round !== stored?.round) cursor = { ...cursor, done: 0 }
  const show = () => Object.assign(result, { round: round.full ? "full" : "changes", reset: round.reset })
  show()
  const save = async (finished?: Partial<CalendarCursor>) => {
    cursor = { ...cursor, round, updatedAt: now, ...finished }
    await store.setCursor(calendar.id, JSON.stringify(cursor), now)
  }
  /**
   * Series' slots and the cursor in one transaction. A series' slots replace its stored ones in the window: a slot it
   * no longer has, moved or dropped, is cancelled; one kept as stored counts as seen by this round.
   */
  const commit = async (groups: SeriesSlots[]) => {
    const count = groups.reduce((sum, { slots }) => sum + (slots?.length ?? 0), 0)
    cursor = { ...cursor, round, updatedAt: now, done: cursor.done + count }
    const { saved, removed } = await store.saveSlots(calendar.id, groups, round.window, JSON.stringify(cursor), now)
    result.occurrences += saved
    result.removed += removed
  }
  /** A series this full round need not ask: the same version as stored, with its slots in the window stored. */
  const unchanged = async (entry: EntryInput) => {
    if (!round.full || round.everySeries !== false || !entry.etag) return false
    const held = await store.entry(calendar.id, entry.externalId)
    return (
      held !== null &&
      held.etag === entry.etag &&
      held.deletedAt === null &&
      (await store.slotsOf(calendar.id, entry.externalId, round.window)).length > 0
    )
  }
  const stop = () => budget.take()
  let restarted = false
  const seen = new Set<string>()
  while (!round.listed) {
    const why = stop()
    if (why) return why
    const page = await source.changes(calendar, {
      cursor: round.from,
      window: round.window,
      ...(round.page === null ? {} : { page: round.page }),
    })
    if ("reset" in page) {
      // A page token held since an earlier run may have expired; the provider says how long none of them last.
      if (round.page !== null && !restarted) {
        restarted = true
        round = freshRound(round.full, round.from, round.window, now, round.reset, round.everySeries !== false)
      } else if (round.full) throw deadList(source.provider)
      else {
        round = freshRound(true, null, window, now, true)
        cursor = { ...cursor, token: null }
      }
      cursor = { ...cursor, done: 0 }
      show()
      await save()
      continue
    }
    if (signal?.aborted) return "cancelled"
    const groups: SeriesSlots[] = []
    const listed = page.entries.filter((entry) => entry.kind === "series" && entry.status !== "cancelled")
    const kept = new Set<string>()
    if (source.traits.expands === "on-request")
      for (const entry of listed) if (await unchanged(entry)) kept.add(entry.externalId)
    if (page.entries.length) {
      await store.saveEntries(calendar.id, page.entries, now)
      result.saved += page.entries.length
      cursor = { ...cursor, done: cursor.done + page.entries.length }
      for (const entry of listed) {
        if (source.traits.expands === "local")
          groups.push({ series: entry.externalId, slots: await (expand as CalendarExpander)(entry, round.window) })
        else if (kept.has(entry.externalId)) groups.push({ series: entry.externalId, slots: null })
        else if (source.traits.expands === "on-request" && !round.series.includes(entry.externalId))
          round = { ...round, series: [...round.series, entry.externalId] }
      }
    }
    if (page.removed.length) result.removed += await store.removeEntries(calendar.id, page.removed, now)
    if (page.nextPage === undefined) round = { ...round, page: null, listed: true, next: page.cursor ?? null }
    else {
      if (seen.has(page.nextPage))
        throw new CliError("invalid_response", `${source.provider} returned the same page twice`)
      seen.add(page.nextPage)
      round = { ...round, page: page.nextPage }
    }
    await commit(groups)
    moved()
  }
  const occurrences = source.occurrences as NonNullable<CalendarSource["occurrences"]>
  let batch: SeriesSlots[] = []
  // Whatever stops the loop — the budget, a cancel, a failed request — the series asked so far are kept.
  const flush = async () => {
    if (!batch.length) return
    const done = new Set(batch.map(({ series }) => series))
    round = { ...round, series: round.series.filter((one) => !done.has(one)) }
    const groups = batch
    batch = []
    await commit(groups)
  }
  try {
    for (const series of [...round.series]) {
      const why = stop()
      if (why) return why
      const slots = await occurrences.call(source, calendar, series, round.window)
      if (signal?.aborted) return "cancelled"
      batch.push({ series, slots })
      moved()
      if (batch.length >= BATCH_SERIES || batch.reduce((sum, one) => sum + (one.slots?.length ?? 0), 0) >= BATCH_SLOTS)
        await flush()
    }
  } finally {
    await flush()
  }
  if (signal?.aborted) return "cancelled"
  result.unseen = round.full ? await store.markUnseen(calendar.id, round.startedAt, round.window, now) : 0
  await save({
    token: round.next,
    window: round.window,
    fullAt: round.full ? round.startedAt : cursor.fullAt,
    round: null,
    ...(round.full && round.everySeries !== false ? { slotsTo: round.window.to } : {}),
  })
  result.state = "complete"
  return null
}

/**
 * Brings one calendar account's synced calendars up to date (foundation §6.2): the calendar list first, then for
 * each synced calendar its changes since the cursor, or a full list of the window, then the slots of the series that
 * changed. Every page is saved as it comes, with the round's position in the cursor, so a run the budget stops, or
 * one that fails, goes on from there next time. Calendars with a round in progress go first, then the longest unsynced.
 */
export const syncCalendars = async (
  source: CalendarSource,
  store: EventStore,
  options: CalendarSyncOptions,
): Promise<CalendarSyncReport> => {
  const now = options.now ?? Date.now()
  const window = options.window ?? calendarSyncWindow(now)
  const budget = options.budget ?? runBudget()
  if (source.traits.expands === "local" && !options.expand)
    throw new CliError("configuration_error", `${source.provider} needs a local expander for its repeating events`)
  if (source.traits.expands === "on-request" && !source.occurrences)
    throw new CliError("configuration_error", `${source.provider} expands on request but has no occurrences()`)
  const report: CalendarSyncReport = {
    provider: source.provider,
    accountId: options.accountId,
    window,
    calendars: 0,
    synced: [],
    notSynced: [],
    complete: true,
    state: "complete",
    progress: { calendars: 0, calendarsDone: 0, requests: 0, saved: 0, steps: 0 },
  }
  const finish = (stopped: BudgetStop | null) => {
    report.progress = {
      calendars: report.synced.length,
      calendarsDone: report.synced.filter((one) => one.state === "complete").length,
      requests: budget.used,
      saved: report.synced.reduce((sum, one) => sum + one.saved + one.occurrences, 0),
      steps,
    }
    report.complete = report.synced.every((one) => one.state === "complete" && one.error === undefined)
    report.state = report.complete && stopped === null ? "complete" : "partial"
    if (stopped) report.stopped = stopped
    if (report.state === "partial") {
      report.complete = false
      report.hint = CONTINUE
    }
    return report
  }
  let steps = 0
  let stopped = budget.take()
  if (stopped) return finish(stopped)
  const listed = await store.saveCalendars(options.accountId, await source.calendars(), now)
  report.calendars = listed.length
  const synced: { calendar: StoredCalendar; stored: CalendarCursor | null }[] = []
  for (const calendar of listed) {
    if (calendar.synced) synced.push({ calendar, stored: parseCalendarCursor(await store.cursor(calendar.id)) })
    else report.notSynced.push({ calendarId: calendar.id, externalId: calendar.externalId, title: calendar.title })
  }
  const rank = ({ stored }: (typeof synced)[number]) => [stored?.round && !options.full ? 0 : 1, stored?.updatedAt ?? 0]
  synced.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return (x[0] as number) - (y[0] as number) || (x[1] as number) - (y[1] as number)
  })
  if (options.full)
    // Every calendar keeps the rescan as its round in progress, so one this run does not reach starts it next time.
    for (const one of synced) {
      const round = freshRound(true, null, window, now)
      const fresh = { v: 2 as const, token: null, window, fullAt: 0, updatedAt: null, restored: true as const }
      one.stored = { ...(one.stored ?? fresh), done: 0, round }
      await store.setCursor(one.calendar.id, JSON.stringify(one.stored), now)
    }
  for (const { calendar, stored } of synced) {
    const planned = roundFor(source, stored, { window, now })
    const result: CalendarSyncResult = {
      calendarId: calendar.id,
      externalId: calendar.externalId,
      title: calendar.title,
      round: planned.full ? "full" : "changes",
      reset: planned.reset,
      state: "partial",
      saved: 0,
      removed: 0,
      occurrences: 0,
      unseen: 0,
    }
    report.synced.push(result)
    if (stopped) continue
    try {
      stopped = await syncOne(
        {
          source,
          store,
          calendar,
          window,
          now,
          expand: options.expand,
          budget,
          signal: options.signal,
          moved: () => {
            steps += 1
          },
        },
        stored,
        result,
      )
    } catch (error) {
      if (options.signal?.aborted) {
        stopped = "cancelled"
        continue
      }
      // An adapter's own failure says what went wrong; anything else may carry a request URL with a token in it.
      result.error = isCliFailure(error) ? error.message : "the calendar could not be synced"
    }
  }
  return finish(stopped)
}

/**
 * Each synced calendar's sync in the WC-LIFE-14 shape: `done` counts the entries its current or last round saved,
 * `total` is null since no provider says how many a window holds, and `cursor_age_ms` growing on a `partial` one
 * means nothing is moving it.
 */
export const calendarStatus = async (
  store: EventStore,
  accountId: number,
  { profile, now }: { profile: string; now: number },
) => {
  const items = []
  for (const calendar of await store.calendars(accountId)) {
    if (!calendar.synced || calendar.deletedAt !== null) continue
    const cursor = parseCalendarCursor(await store.cursor(calendar.id))
    const progress = progressOf({
      job: `calendar ${calendar.id}`,
      profile,
      done: cursor?.done ?? 0,
      complete: cursor !== null && cursor.round === null,
      ...(cursor?.updatedAt == null ? {} : { updatedAt: new Date(cursor.updatedAt).toISOString() }),
      now: new Date(now),
    })
    items.push({
      calendar_id: String(calendar.id),
      external_id: calendar.externalId,
      title: calendar.title,
      round: cursor?.round ? (cursor.round.full ? "full" : "changes") : null,
      ...progress,
      line: progressLine(progress),
    })
  }
  return { items, page: 1, limit: Math.max(1, items.length), hasMore: false }
}
