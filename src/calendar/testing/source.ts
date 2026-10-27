import { CliError } from "@wirecat/cli-base"
import type { CalendarInput, EntryInput, StoredCalendar } from "../../meetings/index.js"
import type { BusyTimes, CalendarSource, CalendarSourceTraits, ChangeResult, SyncWindow } from "../source.js"

export interface FakeCalendarSourceOptions {
  provider?: string
  traits?: Partial<CalendarSourceTraits>
  calendars?: CalendarInput[]
  /** Entries per page of `changes()`. */
  pageSize?: number
}

/**
 * A provider held in memory. Every `put` and `remove` is one change; the cursor names the last change it saw, so a
 * later `changes()` returns only what came after it. A source whose cursor holds the window refuses a cursor asked
 * for another window, as Graph's delta link would silently keep the old one.
 */
export interface FakeCalendarSource extends CalendarSource {
  /** Adds or replaces entries of one calendar, by `externalId`. */
  put(calendar: string, ...entries: EntryInput[]): void
  /** Deletes entries at the provider and reports them in the next round's `removed`. */
  remove(calendar: string, ...externalIds: string[]): void
  /** Deletes entries without a word: only a full list notices. */
  drop(calendar: string, ...externalIds: string[]): void
  /** What `occurrences()` returns for a series (`expands: "on-request"`). */
  setOccurrences(seriesExternalId: string, entries: EntryInput[]): void
  /** Every cursor given out so far is dead: the next round with one gets `{ reset: true }`. */
  expireCursors(): void
  /** Every page token given out so far is dead, as one held too long: asking for it gets `{ reset: true }`. */
  expirePages(): void
  /** The `changes()` call after this many more succeeds throws once. */
  failAfter(calls: number): void
  /** A person's busy times, or the provider's refusal to say; a person never set is `notFound`. */
  setBusy(person: string, busy: SyncWindow[] | { error: string }): void
  readonly calls: {
    changes: { calendar: string; cursor: string | null; page?: string; window: SyncWindow }[]
    occurrences: string[]
  }
}

const DEFAULT_TRAITS: CalendarSourceTraits = { expands: "on-request", cursorHoldsWindow: false, fullListOnly: false }

const inside = (entry: EntryInput, window: SyncWindow) =>
  entry.kind === "series" ||
  entry.startsAt == null ||
  (entry.startsAt < window.to && (entry.endsAt ?? entry.startsAt + 1) > window.from)

export const fakeCalendarSource = (options: FakeCalendarSourceOptions = {}): FakeCalendarSource => {
  const traits = { ...DEFAULT_TRAITS, ...options.traits }
  const pageSize = options.pageSize ?? 50
  const calendars = options.calendars ?? [
    {
      externalId: "primary",
      title: "Example work",
      timezone: "UTC",
      accessRole: "owner",
      primary: true,
      syncByDefault: true,
    },
  ]
  const held = new Map<string, Map<string, EntryInput>>()
  const log: { version: number; calendar: string; put?: EntryInput; removed?: string }[] = []
  const occurrences = new Map<string, EntryInput[]>()
  const people = new Map<string, SyncWindow[] | { error: string }>()
  let version = 0
  let deadBefore = 0
  let pages = 0
  let failIn: number | null = null
  const calls: FakeCalendarSource["calls"] = { changes: [], occurrences: [] }

  const of = (calendar: string) => {
    if (!held.has(calendar)) held.set(calendar, new Map())
    return held.get(calendar) as Map<string, EntryInput>
  }
  const token = (window: SyncWindow) =>
    traits.fullListOnly ? null : `v${version}${traits.cursorHoldsWindow ? `@${window.from}-${window.to}` : ""}`

  return {
    provider: options.provider ?? "example-calendar",
    traits,
    calls,
    async calendars() {
      return calendars.map((one) => ({ ...one }))
    },
    async changes(calendar: StoredCalendar, { cursor, page, window }): Promise<ChangeResult> {
      calls.changes.push({ calendar: calendar.externalId, cursor, window, ...(page === undefined ? {} : { page }) })
      if (failIn !== null && failIn-- === 0) {
        failIn = null
        throw new CliError("provider_error", "example provider failed")
      }
      let entries: EntryInput[]
      let removed: string[] = []
      if (cursor === null || traits.fullListOnly) entries = [...of(calendar.externalId).values()]
      else {
        const [, seen, holds] = /^v(\d+)(?:@(.*))?$/u.exec(cursor) ?? []
        if (seen === undefined || Number(seen) < deadBefore) return { reset: true }
        if (traits.cursorHoldsWindow && holds !== `${window.from}-${window.to}`)
          throw new CliError("validation_error", "this cursor holds another window")
        const after = log.filter((one) => one.version > Number(seen) && one.calendar === calendar.externalId)
        const changed = new Map<string, EntryInput>()
        for (const one of after) if (one.put) changed.set(one.put.externalId, one.put)
        removed = after.flatMap(({ removed }) => (removed === undefined ? [] : [removed]))
        entries = [...changed.values()].filter(({ externalId }) => !removed.includes(externalId))
      }
      if (cursor === null || traits.fullListOnly) entries = entries.filter((entry) => inside(entry, window))
      const [, generation, offset] = /^p(\d+):(\d+)$/u.exec(page ?? `p${pages}:0`) ?? []
      if (Number(generation) !== pages) return { reset: true }
      const from = Number(offset)
      const slice = entries.slice(from, from + pageSize)
      const more = from + pageSize < entries.length
      return {
        entries: slice.map((entry) => structuredClone(entry)),
        removed: from === 0 ? removed : [],
        ...(more ? { nextPage: `p${pages}:${from + pageSize}` } : { cursor: token(window) }),
      }
    },
    ...(traits.expands === "on-request"
      ? {
          async occurrences(_calendar: StoredCalendar, seriesExternalId: string, window: SyncWindow) {
            calls.occurrences.push(seriesExternalId)
            return (occurrences.get(seriesExternalId) ?? [])
              .filter((entry) => inside(entry, window))
              .map((entry) => structuredClone(entry))
          },
        }
      : {}),
    async freeBusy({ calendars: asked, people: persons, window }) {
      const taken = (busy: SyncWindow[]) =>
        busy
          .filter(({ from, to }) => from < window.to && to > window.from)
          .map(({ from, to }) => ({ from: Math.max(from, window.from), to: Math.min(to, window.to) }))
      return [
        ...asked.map(
          (id): BusyTimes => ({
            id,
            busy: taken(
              [...of(id).values()]
                .filter((entry) => entry.status !== "cancelled" && entry.transparency !== "transparent")
                .flatMap(({ startsAt, endsAt }) =>
                  startsAt == null || endsAt == null ? [] : [{ from: startsAt, to: endsAt }],
                ),
            ),
          }),
        ),
        ...persons.map((id): BusyTimes => {
          const busy = people.get(id) ?? { error: "notFound" }
          return Array.isArray(busy) ? { id, busy: taken(busy) } : { id, busy: [], error: busy.error }
        }),
      ]
    },
    setBusy(person, busy) {
      people.set(person, busy)
    },
    put(calendar, ...entries) {
      for (const entry of entries) {
        of(calendar).set(entry.externalId, structuredClone(entry))
        log.push({ version: ++version, calendar, put: structuredClone(entry) })
      }
    },
    remove(calendar, ...externalIds) {
      for (const externalId of externalIds) {
        of(calendar).delete(externalId)
        log.push({ version: ++version, calendar, removed: externalId })
      }
    },
    drop(calendar, ...externalIds) {
      for (const externalId of externalIds) of(calendar).delete(externalId)
    },
    setOccurrences(seriesExternalId, entries) {
      occurrences.set(seriesExternalId, entries)
    },
    expirePages() {
      pages += 1
    },
    expireCursors() {
      deadBefore = ++version
    },
    failAfter(n) {
      failIn = n
    },
  }
}
