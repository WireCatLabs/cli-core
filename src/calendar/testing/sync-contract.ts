import assert from "node:assert/strict"
import type { ContractCase, EntryInput, EventStore, StoredEntry } from "../../meetings/index.js"
import type { CalendarExpander, CalendarSourceTraits, SyncWindow } from "../source.js"
import { type CalendarSyncOptions, parseCalendarCursor, syncCalendars } from "../sync.js"
import { type FakeCalendarSource, type FakeCalendarSourceOptions, fakeCalendarSource } from "./source.js"

/** A fresh, empty store and one calendar account in it. */
export interface CalendarSyncFixture {
  store: EventStore
  accountId: number
}

/** Every combination of the source traits: the engine must handle each. */
export const CALENDAR_TRAIT_COMBINATIONS: readonly CalendarSourceTraits[] = (
  ["on-request", "in-changes", "local"] as const
).flatMap((expands) =>
  [false, true].flatMap((cursorHoldsWindow) =>
    [false, true].map((fullListOnly) => ({ expands, cursorHoldsWindow, fullListOnly })),
  ),
)

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 27, 9)
const AT = NOW + DAY

const single = (externalId: string, at = AT, extra: Partial<EntryInput> = {}): EntryInput => ({
  externalId,
  kind: "single",
  status: "confirmed",
  title: "Example review",
  startsAt: at,
  endsAt: at + HOUR,
  ...extra,
})

const utc = (at: number) => new Date(at).toISOString().replace(/[-:]|\.\d{3}/gu, "")
const slotId = (series: string, at: number) => `${series}_${utc(at)}`
const slot = (series: string, at: number, status: EntryInput["status"] = "confirmed"): EntryInput => ({
  ...single(slotId(series, at), at, { status }),
  kind: "occurrence",
  seriesExternalId: series,
  originalStartsAt: at,
  icalUid: `${series}@example.com`,
})

/** Daily slots of `RRULE:FREQ=DAILY;COUNT=n`; an `EXDATE` slot comes back cancelled. Enough for the contract. */
const exampleExpander: CalendarExpander = (series, window) => {
  const count = Number(/COUNT=(\d+)/u.exec(series.recurrence?.find((line) => line.startsWith("RRULE")) ?? "")?.[1])
  const skipped = new Set(
    (series.recurrence ?? []).filter((line) => line.startsWith("EXDATE")).map((line) => line.split(":")[1]),
  )
  return Array.from({ length: count }, (_, n) => (series.startsAt as number) + n * DAY)
    .filter((at) => at >= window.from && at < window.to)
    .map((at) => slot(series.externalId, at, skipped.has(utc(at)) ? "cancelled" : "confirmed"))
}

const seriesOf = (externalId: string, exdates: number[] = []): EntryInput => ({
  ...single(externalId),
  kind: "series",
  icalUid: `${externalId}@example.com`,
  recurrence: ["RRULE:FREQ=DAILY;COUNT=3", ...exdates.map((at) => `EXDATE:${utc(at)}`)],
})

/** Every stored entry that belongs to an event, found through the store's own reads. */
const entriesOf = async (store: EventStore): Promise<Map<string, StoredEntry>> => {
  const found = new Map<string, StoredEntry>()
  for (const event of await store.events({ limit: 1000 }))
    for (const entry of (await store.event(event.id))?.entries ?? []) found.set(entry.externalId, entry)
  return found
}

const nameOf = ({ expands, cursorHoldsWindow, fullListOnly }: CalendarSourceTraits) =>
  `[expands ${expands}${cursorHoldsWindow ? ", cursor holds the window" : ""}${fullListOnly ? ", full list only" : ""}]`

/**
 * The sync engine over `fakeCalendarSource`, once for each trait combination: changes after a cursor, removal by id,
 * a dead cursor, a window that moved, each way of expanding a series and a slot cancelled later, a failed page, an
 * unsynced calendar and a full list. Run it over the store the CLI uses.
 */
export const calendarSyncContract = (make: () => CalendarSyncFixture | Promise<CalendarSyncFixture>): ContractCase[] =>
  CALENDAR_TRAIT_COMBINATIONS.flatMap((traits) => {
    const test = (
      name: string,
      check: (
        context: CalendarSyncFixture & {
          source: FakeCalendarSource
          sync: (at: number, options?: Partial<CalendarSyncOptions>) => ReturnType<typeof syncCalendars>
        },
      ) => Promise<void>,
      options: Omit<FakeCalendarSourceOptions, "traits"> = {},
    ): ContractCase => ({
      name: `${name} ${nameOf(traits)}`,
      async run() {
        const fixture = await make()
        const source = fakeCalendarSource({ ...options, traits })
        const sync = (at: number, extra: Partial<CalendarSyncOptions> = {}) =>
          syncCalendars(source, fixture.store, {
            accountId: fixture.accountId,
            now: at,
            ...(traits.expands === "local" ? { expand: exampleExpander } : {}),
            ...extra,
          })
        await check({ ...fixture, source, sync })
      },
    })
    const cursorOf = async (store: EventStore, calendarId: number) =>
      parseCalendarCursor(await store.cursor(calendarId))
    const putSeries = (source: FakeCalendarSource, series: EntryInput, slots: EntryInput[]) => {
      if (traits.expands === "in-changes") source.put("primary", series, ...slots)
      else source.put("primary", series)
      if (traits.expands === "on-request") source.setOccurrences(series.externalId, slots)
    }

    return [
      test("the first run lists the window; the next reads only what changed", async ({ store, source, sync }) => {
        source.put("primary", single("e1"), single("e2"))
        const first = await sync(NOW)
        const [one] = first.synced
        assert.deepEqual([one?.round, one?.saved, first.complete], ["full", 2, true])
        const cursor = await cursorOf(store, one?.calendarId as number)
        assert.equal(cursor?.fullAt, NOW)
        assert.equal(cursor?.token === null, traits.fullListOnly)
        source.put("primary", single("e3"))
        const second = (await sync(NOW + HOUR)).synced[0]
        assert.equal(second?.round, traits.fullListOnly ? "full" : "changes")
        assert.equal(second?.saved, traits.fullListOnly ? 3 : 1)
        assert.equal(source.calls.changes.at(-1)?.cursor === null, traits.fullListOnly)
        assert.deepEqual([...(await entriesOf(store)).keys()].sort(), ["e1", "e2", "e3"])
      }),
      test("an entry the provider deletes is cancelled, or marked when only a full list shows it", async ({
        store,
        source,
        sync,
      }) => {
        source.put("primary", single("e1"))
        await sync(NOW)
        source.remove("primary", "e1")
        const after = (await sync(NOW + HOUR)).synced[0]
        const entry = (await entriesOf(store)).get("e1")
        if (traits.fullListOnly) {
          assert.equal(after?.unseen, 1)
          assert.equal(entry?.deletedAt, NOW + HOUR)
        } else {
          assert.equal(after?.removed, 1)
          assert.deepEqual([entry?.status, entry?.deletedAt], ["cancelled", null])
        }
      }),
      test("a dead cursor is forgotten and the window listed again", async ({ store, source, sync }) => {
        source.put("primary", single("e1"))
        await sync(NOW)
        source.expireCursors()
        source.put("primary", single("e2"))
        const after = (await sync(NOW + HOUR)).synced[0]
        assert.equal(after?.round, "full")
        assert.equal(after?.reset, !traits.fullListOnly)
        assert.deepEqual(
          source.calls.changes.slice(traits.fullListOnly ? -1 : -2).map(({ cursor }) => cursor === null),
          traits.fullListOnly ? [true] : [false, true],
        )
        assert.equal((await cursorOf(store, after?.calendarId as number))?.fullAt, NOW + HOUR)
        assert.deepEqual([...(await entriesOf(store)).keys()].sort(), ["e1", "e2"])
      }),
      test("a window that moved means a full round only when the cursor holds the window", async ({
        store,
        source,
        sync,
      }) => {
        const window: SyncWindow = { from: NOW - 30 * DAY, to: NOW + 30 * DAY }
        source.put("primary", single("e1"))
        await sync(NOW, { window })
        const moved = await sync(NOW + HOUR, { window: { from: window.from + DAY, to: window.to + DAY } })
        assert.equal(moved.complete, true)
        assert.equal(moved.synced[0]?.round, traits.cursorHoldsWindow || traits.fullListOnly ? "full" : "changes")
        assert.deepEqual((await cursorOf(store, moved.synced[0]?.calendarId as number))?.window, {
          from: window.from + DAY,
          to: window.to + DAY,
        })
      }),
      test("a series' slots come as the source expands them", async ({ store, source, sync }) => {
        const slots = [slot("s", AT), slot("s", AT + DAY, "cancelled"), slot("s", AT + 2 * DAY)]
        putSeries(source, seriesOf("s", [AT + DAY]), slots)
        const report = (await sync(NOW)).synced[0]
        assert.equal(report?.occurrences, traits.expands === "in-changes" ? 0 : 3)
        assert.deepEqual(source.calls.occurrences, traits.expands === "on-request" ? ["s"] : [])
        const entries = await entriesOf(store)
        assert.deepEqual(
          [slotId("s", AT), slotId("s", AT + 2 * DAY)].map((id) => entries.get(id)?.status),
          ["confirmed", "confirmed"],
        )
        assert.equal(entries.get(slotId("s", AT))?.seriesExternalId, "s")
      }),
      test("a slot cancelled after it was stored is cancelled, never deleted", async ({ store, source, sync }) => {
        putSeries(source, seriesOf("s"), [slot("s", AT), slot("s", AT + DAY), slot("s", AT + 2 * DAY)])
        await sync(NOW)
        if (traits.expands === "in-changes") source.put("primary", slot("s", AT + DAY, "cancelled"))
        else
          putSeries(source, seriesOf("s", [AT + DAY]), [
            slot("s", AT),
            slot("s", AT + DAY, "cancelled"),
            slot("s", AT + 2 * DAY),
          ])
        await sync(NOW + HOUR)
        const entry = (await entriesOf(store)).get(slotId("s", AT + DAY))
        assert.deepEqual([entry?.status, entry?.deletedAt], ["cancelled", null])
        const event = await store.event(entry?.eventId as number)
        assert.equal(event?.event.status, "cancelled")
      }),
      test(
        "a failed page keeps the old cursor, and the next run reads the same changes again",
        async ({ store, source, sync }) => {
          source.put("primary", single("e1"))
          const first = await sync(NOW)
          const calendarId = first.synced[0]?.calendarId as number
          const before = await store.cursor(calendarId)
          source.put("primary", single("e2"), single("e3"))
          source.failAfter(1)
          const failed = await sync(NOW + HOUR)
          assert.equal(failed.complete, false)
          assert.match(failed.synced[0]?.error ?? "", /example provider failed/u)
          assert.equal(await store.cursor(calendarId), before)
          const again = await sync(NOW + 2 * HOUR)
          assert.equal(again.complete, true)
          assert.deepEqual([...(await entriesOf(store)).keys()].sort(), ["e1", "e2", "e3"])
        },
        { pageSize: 1 },
      ),
      test(
        "a calendar the owner does not sync is listed and never read",
        async ({ source, sync }) => {
          const report = await sync(NOW)
          assert.deepEqual(
            report.notSynced.map(({ externalId }) => externalId),
            ["team"],
          )
          assert.deepEqual(new Set(source.calls.changes.map(({ calendar }) => calendar)), new Set(["primary"]))
        },
        {
          calendars: [
            {
              externalId: "primary",
              title: "Work",
              timezone: "UTC",
              accessRole: "owner",
              primary: true,
              syncByDefault: true,
            },
            {
              externalId: "team",
              title: "Team",
              timezone: null,
              accessRole: "reader",
              primary: false,
              syncByDefault: false,
            },
          ],
        },
      ),
      test("a full run marks what the provider dropped without a word", async ({ store, source, sync }) => {
        source.put("primary", single("e1"), single("e2"))
        await sync(NOW)
        source.drop("primary", "e2")
        const after = (await sync(NOW + HOUR, { full: true })).synced[0]
        assert.deepEqual([after?.round, after?.unseen], ["full", 1])
        const entries = await entriesOf(store)
        assert.deepEqual([entries.get("e1")?.deletedAt, entries.get("e2")?.deletedAt], [null, NOW + HOUR])
      }),
    ]
  })
