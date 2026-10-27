import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { useProviders } from "../domain/providers.js"
import type { EntryInput } from "../meetings/index.js"
import { sourceOf } from "../search/query.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { searchEvents } from "./events-search.js"
import { searchAllWithMeetings } from "./search-all-meetings.js"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 26, 12)

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
  useProviders([])
})

const entry = (externalId: string, title: string, startsAt: number, extra: Partial<EntryInput> = {}): EntryInput => ({
  externalId,
  kind: "single",
  status: "confirmed",
  title,
  startsAt,
  endsAt: startsAt + 3_600_000,
  ...extra,
})

/** A weekly series: the series entry and one occurrence a week from `first`. */
const weekly = (id: string, title: string, first: number, weeks: number, extra: Partial<EntryInput> = {}) => [
  entry(id, title, first, { kind: "series", recurrence: ["RRULE:FREQ=WEEKLY"], ...extra }),
  ...Array.from({ length: weeks }, (_, week) =>
    entry(`${id}_${week}`, title, first + week * 7 * DAY, {
      kind: "occurrence",
      seriesExternalId: id,
      originalStartsAt: first + week * 7 * DAY,
      ...extra,
    }),
  ),
]

let lastPath = ""

const calendarStore = async (entries: EntryInput[], account = "owner-1") => {
  lastPath = join(mkdtempSync(join(tmpdir(), "events-")), "store.db")
  const store = await openStore({ path: lastPath, now: () => NOW })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "google-calendar",
    kind: "events",
    aliases: ["gcal", "calendar"],
    command: "gcal",
  })
  const accountId = await store.accounts.saveAccount({ provider: "google-calendar", account }, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    accountId,
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
  await store.calendar.saveEntries(calendar?.id as number, entries, 1)
  return store
}

/** A second calendar account in the same store, with its own calendar; returns the calendar's id. */
const secondCalendar = async (store: MessageStore, account = "owner-2") => {
  const accountId = await store.accounts.saveAccount({ provider: "google-calendar", account }, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    accountId,
    [
      {
        externalId: "primary",
        title: "Home",
        timezone: "UTC",
        accessRole: "owner",
        primary: true,
        syncByDefault: true,
      },
    ],
    1,
  )
  return calendar?.id as number
}

const firstCalendar = async (store: MessageStore) =>
  (
    await store.calendar.calendars(
      (
        await store.accounts.storedAccount({ provider: "google-calendar", account: "owner-1" })
      ).id,
    )
  )[0]?.id as number

describe("searchEvents", () => {
  it("finds an event by its title, description, place and attendees' names", async () => {
    const store = await calendarStore([
      entry("g1", "Budget review", NOW + DAY, {
        description: "Numbers for the quarter",
        location: "Room Tagus",
        participants: [{ email: "ana@x.com", name: "Ana Lopez" }],
        url: "https://calendar.example/g1",
      }),
      entry("g2", "Lunch", NOW + 2 * DAY),
    ])

    for (const words of ["budget", "quarter", "tagus", "lopez"]) {
      const found = await searchEvents(store, words)
      expect(found.hits.map(({ title }) => title)).toEqual(["Budget review"])
    }
    const [hit] = (await searchEvents(store, "budget")).hits
    expect(hit).toMatchObject({
      ref: expect.stringMatching(/^event:\d+$/),
      provider: "google-calendar",
      account: "owner-1",
      starts_at: new Date(NOW + DAY).toISOString(),
      location: "Room Tagus",
      url: "https://calendar.example/g1",
      occurrences: 1,
      found_by: ["words"],
    })
  })

  it("shows a series once, at the matching occurrence nearest now", async () => {
    const store = await calendarStore(weekly("s1", "Weekly sync", NOW - 3 * 7 * DAY + DAY, 6))

    const found = await searchEvents(store, "sync")

    expect(found.hits).toHaveLength(1)
    expect(found.hits[0]).toMatchObject({ occurrences: 6, starts_at: new Date(NOW + DAY).toISOString() })
  })

  it("cuts the occurrences of a series into pieces of one text, so they share one vector", async () => {
    const store = await calendarStore(weekly("s1", "Weekly sync", NOW, 6))
    const accountId = (await store.accounts.storedAccounts()).find(({ provider }) => provider === "google-calendar")?.id

    await searchEvents(store, "sync")

    const database = await openCache(lastPath)
    const chunks = database.prepare("SELECT content_hash, account_id FROM chunks WHERE chunkable_type = 'event'").all()
    database.close()
    expect(chunks).toHaveLength(6)
    expect(new Set(chunks.map(({ content_hash }) => content_hash)).size).toBe(1)
    expect(new Set(chunks.map(({ account_id }) => account_id))).toEqual(new Set([accountId]))
  })

  it("never finds working location, focus time, out of office or a birthday", async () => {
    const store = await calendarStore([
      entry("w1", "Office Valencia", NOW, { eventType: "working-location" }),
      entry("f1", "Focus Valencia", NOW, { eventType: "focus" }),
      entry("m1", "Valencia trip", NOW),
    ])

    expect((await searchEvents(store, "valencia")).hits.map(({ title }) => title)).toEqual(["Valencia trip"])
  })

  it("never returns a busy-only private slot, even to a query of filters alone", async () => {
    const store = await calendarStore([
      entry("p1", "", NOW, { title: null, visibility: "private" }),
      entry("p2", "Dentist", NOW, { visibility: "private" }),
      entry("c1", "", NOW, { title: null, visibility: "confidential" }),
    ])

    const found = await searchEvents(store, "in:events date:[2026-10-01 TO 2026-11-30]", { timezone: "UTC" })

    expect(found.hits.map(({ title }) => title)).toEqual(["Dentist"])
  })

  it("reads date: as the event's start", async () => {
    const store = await calendarStore([entry("a", "Retro", NOW - 10 * DAY), entry("b", "Retro", NOW + 10 * DAY)])

    const found = await searchEvents(store, "retro date:[2026-10-20 TO 2026-11-30]", { timezone: "UTC" })

    expect(found.hits.map(({ starts_at }) => starts_at)).toEqual([new Date(NOW + 10 * DAY).toISOString()])
  })

  it("refuses a field events do not have", async () => {
    const store = await calendarStore([entry("a", "Retro", NOW)])

    await expect(searchEvents(store, "tag:work")).rejects.toThrow(/not an event field/)
  })

  it("reads only the calendar accounts named", async () => {
    const store = await calendarStore([entry("a", "Retro", NOW)])

    expect(
      (await searchEvents(store, "retro", { accounts: [{ provider: "google-calendar", account: "owner-1" }] })).hits,
    ).toHaveLength(1)
    expect(
      (await searchEvents(store, "retro", { accounts: [{ provider: "google-calendar", account: "other" }] })).hits,
    ).toEqual([])
  })

  it("pages by series, not by occurrence", async () => {
    const store = await calendarStore([
      ...weekly("s1", "Planning one", NOW, 5),
      ...weekly("s2", "Planning two", NOW + DAY, 5),
      entry("x", "Planning three", NOW + 2 * DAY),
    ])

    const first = await searchEvents(store, "planning", { limit: 2 })
    const second = await searchEvents(store, "planning", { limit: 2, offset: 2 })

    expect(first.hits).toHaveLength(2)
    expect(first.has_more).toBe(true)
    expect(first.next_offset).toBe(2)
    expect(second.hits).toHaveLength(1)
    expect(second.has_more).toBe(false)
    expect(new Set([...first.hits, ...second.hits].map(({ title }) => title)).size).toBe(3)
  })
})

describe("search all reads calendar events", () => {
  const all = (store: MessageStore, extra: Partial<Parameters<typeof searchAllWithMeetings>[2]> = {}) =>
    searchAllWithMeetings(
      store,
      { provider: "telegram", account: "500" },
      { text: "budget", limit: 20, only: ["messages", "notes", "events"], ...extra },
    )

  it("ranks an event with the rest and names the calendar it read", async () => {
    const store = await calendarStore([entry("g1", "Budget review", NOW + DAY)])

    const found = await all(store)

    expect(found.searched).toContain("events")
    expect(found.accounts).toContainEqual({ resource: "events", provider: "google-calendar", account: "owner-1" })
    expect(found.items).toEqual([
      expect.objectContaining({
        kind: "event",
        ref: expect.stringMatching(/^event:\d+$/),
        provider: "google-calendar",
        account: "owner-1",
        title: "Budget review",
        timestamp: new Date(NOW + DAY).toISOString(),
        foundBy: ["words"],
      }),
    ])
  })

  it("neither searches nor skips events while the store holds no calendar", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "events-")), "store.db") })
    opened.push(store)

    const found = await all(store)

    expect(found.searched).not.toContain("events")
    expect(found.skipped.some(({ resource }) => resource === "events")).toBe(false)
  })

  it("reads events alone when --source names the calendar, its alias or the kind", async () => {
    const store = await calendarStore([entry("g1", "Budget review", NOW + DAY)])

    for (const source of ["google-calendar:owner-1", "gcal", "events"]) {
      const found = await all(store, { source })
      expect(found.searched).toEqual(["events"])
      expect(found.items.map(({ kind }) => kind)).toEqual(["event"])
    }
  })

  it("sends in:events from a message search to search all", () => {
    expect(() => sourceOf("in:", "events", ["telegram"])).toThrow("search all --source events does")
  })
})

describe("which calendar copies make an event searchable", () => {
  it("keeps an event found while one of its copies is a busy-only slot, and only in the copy's account that has text", async () => {
    const store = await calendarStore([entry("a", "Board meeting", NOW + DAY, { icalUid: "uid-1" })])
    const busy = await secondCalendar(store)
    await store.calendar.saveEntries(
      busy,
      [entry("b", "", NOW + DAY, { title: null, visibility: "private", icalUid: "uid-1" })],
      2,
    )
    const owner = (account: string) => [{ provider: "google-calendar", account }]

    expect((await searchEvents(store, "board")).hits.map(({ title }) => title)).toEqual(["Board meeting"])
    expect((await searchEvents(store, "board", { accounts: owner("owner-1") })).hits).toHaveLength(1)
    expect((await searchEvents(store, "board", { accounts: owner("owner-2") })).hits).toEqual([])
  })

  it("keeps the title of the copy with text when a busy-only copy changed later", async () => {
    const store = await calendarStore([
      entry("a", "Board meeting", NOW + DAY, { icalUid: "uid-1", externalUpdatedAt: 1 }),
    ])
    const busy = await secondCalendar(store)
    const [copy] = await store.calendar.saveEntries(
      busy,
      [entry("b", "", NOW + DAY, { title: null, visibility: "private", icalUid: "uid-1", externalUpdatedAt: 9 })],
      2,
    )

    expect((await store.calendar.event(copy?.eventId as number))?.event.title).toBe("Board meeting")
  })

  it("finds an event no calendar holds, such as a Zoom meeting's own", async () => {
    const store = await calendarStore([])
    const database = await openCache(lastPath)
    database
      .prepare(
        "INSERT INTO events (title, starts_at, origin, created_at, updated_at) VALUES ('Zoom retro', ?, 'auto', 1, 1)",
      )
      .run(NOW)
    database.close()

    expect((await searchEvents(store, "retro")).hits).toEqual([
      expect.objectContaining({ title: "Zoom retro", account: null }),
    ])
  })
})

describe("an event deleted in Google", () => {
  it("is gone from search, search all and the upcoming list when it was still to come, and stays when it had passed", async () => {
    const store = await calendarStore([
      entry("past", "Offsite", NOW - DAY, { participants: [{ email: "ana@x.com", name: "Ana" }] }),
      entry("next", "Offsite", NOW + DAY, { participants: [{ email: "ana@x.com", name: "Ana" }] }),
    ])
    const calendar = await firstCalendar(store)

    await store.calendar.markUnseen(calendar, NOW, { from: NOW - 30 * DAY, to: NOW + 30 * DAY }, NOW)

    const found = await searchEvents(store, "offsite")
    expect(found.hits.map(({ starts_at }) => starts_at)).toEqual([new Date(NOW - DAY).toISOString()])
    expect(found.hits[0]?.account).toBe("owner-1")
    const all = await searchAllWithMeetings(
      store,
      { provider: "telegram", account: "500" },
      { text: "offsite", limit: 20, only: ["events"] },
    )
    expect(all.items.map(({ timestamp }) => timestamp)).toEqual([new Date(NOW - DAY).toISOString()])
    const upcoming = await store.calendar.events({ from: NOW })
    expect(upcoming.map(({ status }) => status)).toEqual(["cancelled"])
  })

  it("is gone when Google sends it back cancelled before its time", async () => {
    const store = await calendarStore([entry("next", "Offsite", NOW + DAY)])
    await store.calendar.saveEntries(
      await firstCalendar(store),
      [entry("next", "Offsite", NOW + DAY, { status: "cancelled" })],
      2,
    )

    expect((await searchEvents(store, "offsite")).hits).toEqual([])
  })
})

describe("a search past what one search reads", () => {
  it("says it stopped rather than promising pages it cannot fill", async () => {
    const store = await calendarStore([
      entry("a", "Standup", NOW),
      entry("b", "Standup", NOW + DAY),
      entry("c", "Standup", NOW + 2 * DAY),
    ])

    const found = await searchEvents(store, "standup", { candidates: 2 })

    expect(found.hits).toHaveLength(2)
    expect(found.has_more).toBe(false)
    expect(found.truncated).toBe(true)
  })
})
