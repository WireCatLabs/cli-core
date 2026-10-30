import assert from "node:assert/strict"
import { runBudget } from "../../background/budget.js"
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
 * unsynced calendar, a full list, a run the budget or a near deadline stops and the rerun that finishes it, and a page
 * token that expired between runs. Run it over the store the CLI uses.
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
      test("a series moved to another time keeps no slot at the old one", async ({ store, source, sync }) => {
        if (traits.expands === "in-changes") return
        putSeries(source, seriesOf("s"), [slot("s", AT), slot("s", AT + DAY), slot("s", AT + 2 * DAY)])
        await sync(NOW)
        const later = AT + 2 * HOUR
        putSeries(source, { ...seriesOf("s"), startsAt: later, endsAt: later + HOUR }, [
          slot("s", later),
          slot("s", later + DAY),
          slot("s", later + 2 * DAY),
        ])
        await sync(NOW + HOUR)
        const entries = await entriesOf(store)
        assert.deepEqual(
          [AT, AT + DAY, AT + 2 * DAY].map((at) => entries.get(slotId("s", at))?.status),
          ["cancelled", "cancelled", "cancelled"],
        )
        assert.deepEqual(
          [later, later + DAY, later + 2 * DAY].map((at) => entries.get(slotId("s", at))?.status),
          ["confirmed", "confirmed", "confirmed"],
        )
      }),
      test(
        "a failed page keeps the pages before it, and the next run goes on from the failed one",
        async ({ store, source, sync }) => {
          source.put("primary", single("e1"))
          const first = await sync(NOW)
          const calendarId = first.synced[0]?.calendarId as number
          source.put("primary", single("e2"), single("e3"))
          source.failAfter(1)
          const failed = await sync(NOW + HOUR)
          assert.deepEqual([failed.complete, failed.state], [false, "partial"])
          assert.match(failed.synced[0]?.error ?? "", /example provider failed/u)
          const held = (await cursorOf(store, calendarId))?.round
          assert.ok(held?.page)
          const again = await sync(NOW + 2 * HOUR)
          assert.equal(again.complete, true)
          assert.equal(source.calls.changes.at(-2)?.page, held.page)
          assert.deepEqual([...(await entriesOf(store)).keys()].sort(), ["e1", "e2", "e3"])
        },
        { pageSize: 1 },
      ),
      test(
        "a run the budget stops goes on next time and ends with the store one whole run gives",
        async ({ store, source, sync }) => {
          const fill = (one: FakeCalendarSource) => {
            one.put("primary", single("e0"))
            return one
          }
          const grow = (one: FakeCalendarSource) => {
            one.drop("primary", "e0")
            one.put("primary", single("e1"), single("e2", AT + HOUR), single("e3", AT + 2 * HOUR))
            const slots = [slot("s", AT), slot("s", AT + DAY), slot("s", AT + 2 * DAY)]
            if (traits.expands === "in-changes") one.put("primary", seriesOf("s"), ...slots)
            else one.put("primary", seriesOf("s"))
            if (traits.expands === "on-request") one.setOccurrences("s", slots)
          }
          const whole = await make()
          const reference = fill(fakeCalendarSource({ pageSize: 1, traits }))
          const expand = traits.expands === "local" ? { expand: exampleExpander } : {}
          const once = (at: number, extra: Partial<CalendarSyncOptions> = {}) =>
            syncCalendars(reference, whole.store, { accountId: whole.accountId, now: at, ...expand, ...extra })
          await once(NOW)
          grow(reference)
          assert.equal((await once(NOW + HOUR, { full: true })).state, "complete")

          fill(source)
          await sync(NOW)
          grow(source)
          const first = await sync(NOW + HOUR, { full: true, budget: runBudget({ requests: 2 }) })
          assert.deepEqual(
            [first.state, first.stopped, first.hint],
            ["partial", "requests", "run sync again to continue"],
          )
          assert.equal(first.synced[0]?.state, "partial")
          let runs = 1
          let last = first
          while (last.state === "partial" && runs < 30) {
            runs += 1
            last = await sync(NOW + HOUR + runs * 60_000, { budget: runBudget({ requests: 2 }) })
            if (last.state === "partial") assert.equal(last.complete, false)
          }
          assert.equal(last.state, "complete")
          assert.ok(runs > 2)
          const shape = async (one: EventStore) =>
            [...(await entriesOf(one)).values()]
              .map(({ externalId, status, deletedAt }) => `${externalId} ${status} ${deletedAt === null}`)
              .sort()
          assert.deepEqual(await shape(store), await shape(whole.store))
          const entries = await entriesOf(store)
          assert.equal(entries.get("e1")?.deletedAt, null)
          assert.notEqual(entries.get("e0")?.deletedAt ?? null, null)
        },
        { pageSize: 1 },
      ),
      test(
        "a rescan the budget stops still lists every calendar it did not reach in full on the next run",
        async ({ source, sync }) => {
          source.put("primary", single("e1"))
          source.put("team", single("t1"))
          await sync(NOW)
          const stopped = await sync(NOW + HOUR, { full: true, budget: runBudget({ requests: 2 }) })
          const rounds = (report: typeof stopped) =>
            Object.fromEntries(report.synced.map(({ externalId, round, state }) => [externalId, `${round} ${state}`]))
          assert.deepEqual(rounds(stopped), { primary: "full complete", team: "full partial" })
          assert.equal(
            (await sync(NOW + 2 * HOUR)).synced.find(({ externalId }) => externalId === "team")?.round,
            "full",
          )
          if (!traits.fullListOnly)
            assert.deepEqual(rounds(await sync(NOW + 3 * HOUR)), {
              primary: "changes complete",
              team: "changes complete",
            })
        },
        {
          calendars: ["primary", "team"].map((externalId) => ({
            externalId,
            title: externalId,
            timezone: "UTC",
            accessRole: "owner" as const,
            primary: externalId === "primary",
            syncByDefault: true,
          })),
        },
      ),
      test(
        "a deadline close by stops the run before its next request",
        async ({ source, sync }) => {
          source.put("primary", single("e1"), single("e2"))
          const endsAt = NOW + 30_000
          const clock = [NOW, NOW + 1_000, endsAt - 2_000]
          const budget = runBudget({ deadline: { endsAt, ms: 30_000 }, now: () => clock.shift() ?? endsAt })
          const stopped = await sync(NOW, { budget })
          assert.deepEqual([stopped.state, stopped.stopped, budget.used], ["partial", "deadline", 2])
          assert.equal(stopped.synced[0]?.saved, 1)
          const again = await sync(NOW + HOUR)
          assert.equal(again.state, "complete")
          assert.equal(again.synced[0]?.saved, 1)
        },
        { pageSize: 1 },
      ),
      test(
        "a page token that expired since the last run starts that calendar's round over, once",
        async ({ store, source, sync }) => {
          source.put("primary", single("e1"), single("e2"), single("e3"))
          const first = await sync(NOW, { budget: runBudget({ requests: 2 }) })
          assert.equal(first.state, "partial")
          source.expirePages()
          const again = await sync(NOW + HOUR)
          assert.equal(again.state, "complete")
          const calls = source.calls.changes.slice(1)
          assert.ok(calls[0]?.page)
          assert.equal(calls[1]?.page, undefined)
          assert.deepEqual([...(await entriesOf(store)).keys()].sort(), ["e1", "e2", "e3"])
          assert.equal((await cursorOf(store, again.synced[0]?.calendarId as number))?.round, null)
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
