import assert from "node:assert/strict"
import type { EntryInput, EventStore } from "../event-store.js"
import type { ContractCase } from "../store.js"

/** A fresh, empty store and one calendar account in it. */
export interface EventStoreFixture {
  store: EventStore
  accountId: number
}

const HOUR = 3_600_000
/** "Now" in every case: entries before it have happened. */
export const CONTRACT_NOW = 1_000 * HOUR

const single = (externalId: string, at: number, extra: Partial<EntryInput> = {}): EntryInput => ({
  externalId,
  kind: "single",
  status: "confirmed",
  title: "Example review",
  startsAt: at,
  endsAt: at + HOUR,
  ...extra,
})

export const eventStoreContract = (make: () => EventStoreFixture | Promise<EventStoreFixture>): ContractCase[] => {
  const test = (name: string, check: (fixture: EventStoreFixture & { calendar: number }) => Promise<void>) => ({
    name,
    async run() {
      const fixture = await make()
      const [calendar] = await fixture.store.saveCalendars(
        fixture.accountId,
        [
          {
            externalId: "primary",
            title: "Work",
            timezone: "UTC",
            accessRole: "owner",
            primary: true,
            syncByDefault: true,
          },
        ],
        1,
      )
      await check({ ...fixture, calendar: (calendar as { id: number }).id })
    },
  })
  const second = async ({ store, accountId }: EventStoreFixture, externalId = "personal") =>
    (
      (
        await store.saveCalendars(
          accountId,
          [
            {
              externalId,
              title: externalId,
              timezone: "UTC",
              accessRole: "owner",
              primary: false,
              syncByDefault: true,
            },
          ],
          1,
        )
      )[0] as { id: number }
    ).id
  const later = CONTRACT_NOW + 24 * HOUR
  const earlier = CONTRACT_NOW - 24 * HOUR

  return [
    test("a new calendar syncs as its adapter decides, and a later list keeps the owner's choice", async ({
      store,
      accountId,
    }) => {
      await store.saveCalendars(
        accountId,
        [
          {
            externalId: "team",
            title: "Team",
            timezone: null,
            accessRole: "reader",
            primary: false,
            syncByDefault: false,
          },
        ],
        2,
      )
      assert.deepEqual(
        (await store.calendars(accountId)).map(({ externalId, synced }) => [externalId, synced]),
        [
          ["primary", true],
          ["team", false],
        ],
      )
      const team = (await store.calendars(accountId)).find(({ externalId }) => externalId === "team")
      await store.setCalendarSynced(team?.id as number, true, 3)
      await store.saveCalendars(
        accountId,
        [
          {
            externalId: "team",
            title: "Team",
            timezone: null,
            accessRole: "free-busy",
            primary: false,
            syncByDefault: false,
          },
        ],
        4,
      )
      const again = (await store.calendars(accountId)).find(({ externalId }) => externalId === "team")
      assert.deepEqual([again?.synced, again?.accessRole], [true, "free-busy"])
    }),
    test("calendar words are kept in their neutral spelling", async ({ store, calendar }) => {
      const [entry] = await store.saveEntries(
        calendar,
        [
          single("ooo", later, {
            eventType: "out-of-office",
            ownResponse: "needs-action",
            participants: [{ email: "alice@example.com", response: "delegated" }],
          }),
        ],
        2,
      )
      assert.deepEqual([entry?.eventType, entry?.ownResponse], ["out-of-office", "needs-action"])
      const details = await store.event(entry?.eventId as number)
      assert.equal(details?.participants[0]?.response, "delegated")
    }),
    test("rule 1: the same calendar and id is the same entry; a change keeps the old values", async ({
      store,
      calendar,
    }) => {
      const [first] = await store.saveEntries(calendar, [single("e1", later)], 2)
      const [again] = await store.saveEntries(calendar, [single("e1", later + HOUR, { title: "Moved review" })], 3)
      assert.equal(again?.id, first?.id)
      assert.equal(again?.eventId, first?.eventId)
      const details = await store.event(first?.eventId as number)
      assert.equal(details?.event.title, "Moved review")
      assert.equal(details?.event.startsAt, later + HOUR)
      assert.equal(details?.event.origin, "calendar")
      assert.deepEqual(
        details?.revisions.map(({ title, startsAt }) => [title, startsAt]),
        [["Example review", later]],
      )
    }),
    test("rule 2: a plain occurrence and the exception of its slot are one entry, the series in any order", async ({
      store,
      calendar,
    }) => {
      const slot = later
      const occurrence = (externalId: string, extra: Partial<EntryInput> = {}): EntryInput =>
        single(externalId, slot, { kind: "occurrence", seriesExternalId: "s1", originalStartsAt: slot, ...extra })
      const [plain] = await store.saveEntries(calendar, [occurrence("s1_slot")], 2)
      await store.saveEntries(
        calendar,
        [{ ...single("s1", earlier), kind: "series", recurrence: ["RRULE:FREQ=WEEKLY"], recurrenceEndsAt: null }],
        3,
      )
      const [exception] = await store.saveEntries(
        calendar,
        [occurrence("s1_moved", { exception: true, startsAt: slot + HOUR, endsAt: slot + 2 * HOUR })],
        4,
      )
      assert.equal(exception?.id, plain?.id)
      assert.notEqual(exception?.seriesEntryId, null)
      const details = await store.event(exception?.eventId as number)
      assert.equal(details?.event.startsAt, slot + HOUR)
      assert.notEqual(details?.event.eventSeriesId, null)
    }),
    test("rule 3: another calendar's copy with the same iCalUID is the same event", async (fixture) => {
      const { store, calendar } = fixture
      const other = await second(fixture)
      const [work] = await store.saveEntries(calendar, [single("w1", later, { icalUid: "uid-1@example.com" })], 2)
      const [home] = await store.saveEntries(other, [single("p1", later, { icalUid: "uid-1@example.com" })], 3)
      assert.equal(home?.eventId, work?.eventId)
      assert.equal((await store.event(work?.eventId as number))?.entries.length, 2)
    }),
    test("rule 5: otherwise a new event of origin calendar; a slot cancelled before it was stored is none", async ({
      store,
      calendar,
    }) => {
      const [one, two, gone] = await store.saveEntries(
        calendar,
        [single("a", later), single("b", later), single("c", later, { status: "cancelled" })],
        2,
      )
      assert.notEqual(one?.eventId, two?.eventId)
      assert.equal(gone?.eventId, null)
      assert.equal((await store.events({ from: later, to: later + HOUR })).length, 2)
    }),
    test("two candidates: no link and one review entry, kept through a second sync and an owner's decision", async (fixture) => {
      const { store, calendar } = fixture
      const other = await second(fixture)
      const third = await second(fixture, "third")
      const [a] = await store.saveEntries(calendar, [single("a", later, { icalUid: "first" })], 2)
      const [b] = await store.saveEntries(other, [single("b", later, { icalUid: "second" })], 2)
      await store.saveEntries(calendar, [single("a", later, { icalUid: "shared" })], 3)
      await store.saveEntries(other, [single("b", later, { icalUid: "shared" })], 3)
      const [c] = await store.saveEntries(third, [single("c", later, { icalUid: "shared" })], 4)
      assert.equal(c?.eventId, null)
      await store.saveEntries(third, [single("c", later, { icalUid: "shared" })], 5)
      const open = await store.reviews({ status: "open" })
      assert.equal(open.length, 1)
      assert.deepEqual(
        open[0]?.candidates,
        [a?.eventId, b?.eventId].sort((x, y) => (x as number) - (y as number)),
      )
      await store.resolveReview(open[0]?.id as number, { choose: b?.eventId as number }, 6)
      await store.saveEntries(third, [single("c", later, { icalUid: "shared" })], 7)
      const [after] = await store.saveEntries(third, [single("c", later, { icalUid: "shared" })], 8)
      assert.equal(after?.eventId, b?.eventId)
      assert.deepEqual(
        (await store.reviews()).map(({ status }) => status),
        ["linked"],
      )
    }),
    test("the owner's unlink holds: no rule links the entry again", async ({ store, calendar }) => {
      const [entry] = await store.saveEntries(calendar, [single("a", later)], 2)
      await store.unlinkEntry(entry?.id as number, 3)
      const [again] = await store.saveEntries(calendar, [single("a", later, { title: "Renamed" })], 4)
      assert.equal(again?.eventId, null)
      await store.linkEntry(entry?.id as number, entry?.eventId as number, 5)
      const [linked] = await store.saveEntries(calendar, [single("a", later)], 6)
      assert.equal(linked?.eventId, entry?.eventId)
    }),
    test("a deleted single event: past stays as history, future is cancelled", async ({ store, calendar }) => {
      const [past, future] = await store.saveEntries(calendar, [single("p", earlier), single("f", later)], 2)
      await store.saveEntries(
        calendar,
        [single("p", earlier, { status: "cancelled" }), single("f", later, { status: "cancelled" })],
        CONTRACT_NOW,
      )
      const happened = (await store.event(past?.eventId as number))?.event
      assert.equal(happened?.sourceDeletedAt, CONTRACT_NOW)
      assert.notEqual(happened?.status, "cancelled")
      assert.equal(happened?.title, "Example review")
      const cancelled = (await store.event(future?.eventId as number))?.event
      assert.equal(cancelled?.status, "cancelled")
      assert.equal(cancelled?.sourceDeletedAt, null)
    }),
    test("a whole series deleted: its entries cancel, past occurrences stay, future ones cancel", async ({
      store,
      calendar,
    }) => {
      const series: EntryInput = {
        ...single("s", earlier - HOUR),
        kind: "series",
        icalUid: "series@example.com",
        recurrence: ["RRULE:FREQ=DAILY"],
      }
      const occurrence = (at: number): EntryInput =>
        single(`s_${at}`, at, { kind: "occurrence", seriesExternalId: "s", originalStartsAt: at })
      const [, past, future] = await store.saveEntries(calendar, [series, occurrence(earlier), occurrence(later)], 2)
      await store.saveEntries(calendar, [{ ...series, status: "cancelled" }], CONTRACT_NOW)
      const before = await store.event(past?.eventId as number)
      assert.equal(before?.event.sourceDeletedAt, CONTRACT_NOW)
      assert.equal(before?.entries[0]?.status, "cancelled")
      const after = await store.event(future?.eventId as number)
      assert.equal(after?.event.status, "cancelled")
    }),
    test("entries removed by id: past stays as history, future cancels, a series cancels its slots", async ({
      store,
      calendar,
    }) => {
      const series: EntryInput = { ...single("s", earlier - HOUR), kind: "series", recurrence: ["RRULE:FREQ=DAILY"] }
      const slot = (at: number): EntryInput =>
        single(`s_${at}`, at, { kind: "occurrence", seriesExternalId: "s", originalStartsAt: at })
      const [past, future, , , slotLater] = await store.saveEntries(
        calendar,
        [single("p", earlier), single("f", later), series, slot(earlier), slot(later)],
        2,
      )
      assert.equal(await store.removeEntries(calendar, ["p", "f", "s", "unknown"], CONTRACT_NOW), 3)
      const happened = (await store.event(past?.eventId as number))?.event
      assert.equal(happened?.sourceDeletedAt, CONTRACT_NOW)
      assert.equal(happened?.title, "Example review")
      assert.equal((await store.event(future?.eventId as number))?.event.status, "cancelled")
      const occurrence = await store.event(slotLater?.eventId as number)
      assert.deepEqual([occurrence?.event.status, occurrence?.entries[0]?.status], ["cancelled", "cancelled"])
      assert.equal(occurrence?.entries[0]?.deletedAt, null)
      assert.equal(await store.removeEntries(calendar, ["p"], CONTRACT_NOW + 1), 0)
    }),
    test("a calendar's cursor is its own, and null forgets it", async (fixture) => {
      const { store, calendar } = fixture
      const other = await second(fixture)
      assert.equal(await store.cursor(calendar), null)
      const value = JSON.stringify({ v: 1, token: "token-1", window: { from: earlier, to: later }, fullAt: 2 })
      await store.setCursor(calendar, value, 2)
      await store.setCursor(other, "other", 2)
      assert.equal(await store.cursor(calendar), value)
      await store.setCursor(calendar, null, 3)
      assert.equal(await store.cursor(calendar), null)
      assert.equal(await store.cursor(other), "other")
    }),
    test("a full list marks the entries it did not return, plain occurrences only inside the window", async ({
      store,
      calendar,
    }) => {
      const outside = later + 30 * 24 * HOUR
      const [kept, gone, far] = await store.saveEntries(
        calendar,
        [
          single("kept", later),
          single("gone", later),
          single("far", outside, { kind: "occurrence", seriesExternalId: "x", originalStartsAt: outside }),
        ],
        2,
      )
      await store.saveEntries(calendar, [single("kept", later)], 10)
      assert.equal(await store.markUnseen(calendar, 10, { from: earlier, to: later + 24 * HOUR }, 11), 1)
      const entries = new Map(
        (await store.event(gone?.eventId as number))?.entries.map((entry) => [entry.externalId, entry]),
      )
      assert.equal(entries.get("gone")?.deletedAt, 11)
      assert.notEqual(await store.event(gone?.eventId as number), null)
      assert.equal((await store.event(kept?.eventId as number))?.entries[0]?.deletedAt, null)
      assert.equal((await store.event(far?.eventId as number))?.entries[0]?.deletedAt, null)
    }),
    test("participants are kept by address; a room is listed and is no contact", async ({ store, calendar }) => {
      const [entry] = await store.saveEntries(
        calendar,
        [
          single("a", later, {
            participants: [
              { email: "Alice@Example.com", name: "Alice Example", response: "accepted" },
              { email: "room-1@resource.example.com", name: "Room 1", resource: true },
            ],
          }),
        ],
        2,
      )
      const participants = (await store.event(entry?.eventId as number))?.participants ?? []
      assert.deepEqual(
        participants.map(({ email, resource, identityId }) => [email, resource, identityId === null]),
        [
          ["alice@example.com", false, false],
          ["room-1@resource.example.com", true, true],
        ],
      )
    }),
    test("an entry that ends before it starts is refused", async ({ store, calendar }) => {
      await assert.rejects(store.saveEntries(calendar, [single("bad", later, { endsAt: later - 1 })], 2))
    }),
  ]
}
