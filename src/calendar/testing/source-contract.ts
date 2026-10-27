import assert from "node:assert/strict"
import type { ContractCase, EntryInput, StoredCalendar } from "../../meetings/index.js"
import type { CalendarSource, ChangePage, SyncWindow } from "../source.js"

/**
 * One adapter over recorded responses, fresh for each case. Recorded fixtures answer by request, so a second round
 * with the first round's cursor returns the recorded changes; a source that holds state changes it in `afterFullList`.
 */
export interface CalendarSourceFixture {
  source: CalendarSource
  window: SyncWindow
  /** A cursor the provider refuses; absent for a source with `fullListOnly`. */
  deadCursor?: string
  /** Called once after the first full list, before the second round. */
  afterFullList?: () => void | Promise<void>
  /** Every `externalId` the second round holds, entries and removed ids together; absent skips that case. */
  changed?: string[]
  /** An entry the second round moved outside the window: never reported as removed. */
  movedOut?: string
  /**
   * A slot of a series cancelled at the provider: a cancelled entry or a removed id, or for `expands: "local"` an
   * EXDATE line of its series.
   */
  cancelledSlot?: { seriesExternalId: string; originalStartsAt: number }
}

const STATUS = ["confirmed", "tentative", "cancelled"]
const RESPONSE = ["needs-action", "accepted", "tentative", "declined", "delegated"]
const EVENT_TYPE = ["default", "out-of-office", "focus", "working-location", "birthday", "from-mail"]
const TRANSPARENCY = ["opaque", "transparent"]
const VISIBILITY = ["default", "public", "private", "confidential"]
const RECURRENCE_LINE = /^(RRULE|RDATE|EXDATE|EXRULE)[:;]\S/u
const SECRET = /\b(?:passcode|password|pin)\s*[:=#]\s*\S|[?&](?:pwd|passcode|pin)=/iu

const zoneOk = (zone: string | null | undefined) => {
  if (zone == null) return true
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const storedOf = (calendar: Awaited<ReturnType<CalendarSource["calendars"]>>[number]): StoredCalendar => ({
  id: 1,
  accountId: 1,
  externalId: calendar.externalId,
  title: calendar.title,
  timezone: calendar.timezone,
  accessRole: calendar.accessRole,
  primary: calendar.primary,
  synced: true,
  seenAt: null,
  deletedAt: null,
})

interface Listed {
  calendar: StoredCalendar
  entries: EntryInput[]
  removed: string[]
  cursor: string | null
}

const round = async (
  source: CalendarSource,
  calendar: StoredCalendar,
  cursor: string | null,
  window: SyncWindow,
): Promise<Listed | "reset"> => {
  const listed: Listed = { calendar, entries: [], removed: [], cursor: null }
  let page: string | undefined
  for (let pages = 0; pages < 1000; pages++) {
    const result = await source.changes(calendar, { cursor, window, ...(page === undefined ? {} : { page }) })
    if ("reset" in result) return "reset"
    const { entries, removed, nextPage, cursor: next } = result as ChangePage
    listed.entries.push(...entries)
    listed.removed.push(...removed)
    if (nextPage === undefined) {
      listed.cursor = next ?? null
      return listed
    }
    page = nextPage
  }
  throw new assert.AssertionError({ message: "the source never stopped paging" })
}

const fullList = async (fixture: CalendarSourceFixture): Promise<Listed> => {
  const [first] = await fixture.source.calendars()
  assert.ok(first, "the source lists at least one calendar")
  const listed = await round(fixture.source, storedOf(first), null, fixture.window)
  assert.notEqual(listed, "reset", "a full list is never a reset")
  return listed as Listed
}

/** The entries and every series' slots, as the engine would see them. */
const everything = async (fixture: CalendarSourceFixture, listed: Listed): Promise<EntryInput[]> => {
  const slots: EntryInput[] = []
  if (fixture.source.traits.expands === "on-request")
    for (const series of listed.entries.filter(({ kind, status }) => kind === "series" && status !== "cancelled"))
      slots.push(...((await fixture.source.occurrences?.(listed.calendar, series.externalId, fixture.window)) ?? []))
  return [...listed.entries, ...slots]
}

/**
 * Every adapter runs this over recorded provider responses (foundation §6.3): calendar ids, all-day and repeating
 * entries, neutral words, zones, no meeting secret, RFC 5545 lines, a dead cursor and a second round.
 */
export const calendarSourceContract = (
  make: () => CalendarSourceFixture | Promise<CalendarSourceFixture>,
): ContractCase[] => {
  const test = (name: string, check: (fixture: CalendarSourceFixture) => Promise<void>): ContractCase => ({
    name,
    async run() {
      await check(await make())
    },
  })
  return [
    test("calendars have stable, distinct ids", async ({ source }) => {
      const ids = (await source.calendars()).map(({ externalId }) => externalId)
      assert.ok(ids.length > 0 && ids.every((id) => id.trim() !== ""))
      assert.equal(new Set(ids).size, ids.length)
      assert.deepEqual(
        (await source.calendars()).map(({ externalId }) => externalId),
        ids,
      )
    }),
    test("traits agree with the methods the source has", async ({ source, deadCursor }) => {
      assert.equal(typeof source.occurrences === "function", source.traits.expands === "on-request")
      assert.equal(deadCursor === undefined, source.traits.fullListOnly)
    }),
    test("only neutral words, IANA zones and RFC 5545 lines reach the entries", async (fixture) => {
      for (const entry of await everything(fixture, await fullList(fixture))) {
        const where = `entry ${entry.externalId}`
        assert.ok(STATUS.includes(entry.status), `${where}: status ${entry.status}`)
        for (const [value, allowed] of [
          [entry.ownResponse, RESPONSE],
          [entry.eventType, EVENT_TYPE],
          [entry.transparency, TRANSPARENCY],
          [entry.visibility, VISIBILITY],
          ...(entry.participants ?? []).map(({ response }) => [response, RESPONSE] as const),
        ] as const)
          assert.ok(value == null || allowed.includes(value), `${where}: ${value} is not a neutral word`)
        assert.ok(zoneOk(entry.timezone), `${where}: ${entry.timezone} is not an IANA zone`)
        for (const line of entry.recurrence ?? []) assert.match(line, RECURRENCE_LINE, `${where}: ${line}`)
      }
    }),
    test("no join link query, passcode or PIN anywhere in the output", async (fixture) => {
      for (const entry of await everything(fixture, await fullList(fixture))) {
        if (entry.joinUrl) assert.equal(new URL(entry.joinUrl).search, "", `entry ${entry.externalId}: join link`)
        assert.doesNotMatch(JSON.stringify(entry), SECRET, `entry ${entry.externalId}: a meeting secret`)
      }
    }),
    test("all-day entries carry dates with an exclusive end; slots are UTC milliseconds", async (fixture) => {
      for (const entry of await everything(fixture, await fullList(fixture))) {
        const where = `entry ${entry.externalId}`
        if (entry.allDay) {
          assert.match(entry.startDate ?? "", /^\d{4}-\d{2}-\d{2}$/u, `${where}: start date`)
          assert.ok((entry.endDate ?? "") > (entry.startDate ?? ""), `${where}: the end date is exclusive`)
        }
        if (entry.startsAt != null && entry.endsAt != null) assert.ok(entry.endsAt >= entry.startsAt, where)
        if (entry.kind === "occurrence") {
          assert.ok(Number.isSafeInteger(entry.originalStartsAt), `${where}: original start in milliseconds`)
          if (entry.allDay) assert.equal((entry.originalStartsAt as number) % 86_400_000, 0, `${where}: midnight UTC`)
        }
      }
    }),
    test("a series and its occurrences share one iCalendar UID", async (fixture) => {
      const all = await everything(fixture, await fullList(fixture))
      const uids = new Map(all.filter(({ kind }) => kind === "series").map((one) => [one.externalId, one.icalUid]))
      for (const entry of all.filter(({ kind }) => kind === "occurrence")) {
        const uid = entry.seriesExternalId ? uids.get(entry.seriesExternalId) : undefined
        if (uid && entry.icalUid) assert.equal(entry.icalUid, uid, `entry ${entry.externalId}`)
      }
    }),
    test("a cancelled slot arrives as a cancelled entry or a removed id, never silently", async (fixture) => {
      if (!fixture.cancelledSlot) return
      const { seriesExternalId, originalStartsAt } = fixture.cancelledSlot
      const listed = await fullList(fixture)
      const all = await everything(fixture, listed)
      const slot = all.find(
        (one) => one.seriesExternalId === seriesExternalId && one.originalStartsAt === originalStartsAt,
      )
      // A source the engine expands locally says it with an EXDATE line of the series instead.
      const excluded =
        fixture.source.traits.expands === "local" &&
        all.some(
          (one) =>
            one.kind === "series" &&
            one.externalId === seriesExternalId &&
            (one.recurrence ?? []).some((line) => line.startsWith("EXDATE")),
        )
      assert.ok(
        excluded || slot?.status === "cancelled" || (slot !== undefined && listed.removed.includes(slot.externalId)),
        "the cancelled slot is missing",
      )
    }),
    test("a dead cursor gives a reset", async (fixture) => {
      if (fixture.deadCursor === undefined) return
      const [first] = await fixture.source.calendars()
      assert.equal(
        await round(fixture.source, storedOf(first as NonNullable<typeof first>), fixture.deadCursor, fixture.window),
        "reset",
      )
    }),
    test("a second round with the cursor returns only the changes", async (fixture) => {
      if (fixture.source.traits.fullListOnly) return
      const listed = await fullList(fixture)
      assert.notEqual(listed.cursor, null, "the last page carries a cursor")
      await fixture.afterFullList?.()
      const second = await round(fixture.source, listed.calendar, listed.cursor, fixture.window)
      assert.notEqual(second, "reset")
      const { entries, removed } = second as Listed
      if (fixture.changed)
        assert.deepEqual(
          [...entries.map(({ externalId }) => externalId), ...removed].sort(),
          [...fixture.changed].sort(),
        )
      if (fixture.movedOut) assert.ok(!removed.includes(fixture.movedOut), "an entry outside the window is no removal")
    }),
  ]
}
