import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { EntryInput, EventStore } from "../meetings/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { eventsAnswer, eventsFilter, peopleAnswer } from "./reads.js"
import { memoryEventStore } from "./testing/index.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Opened = { store: EventStore; accountId: number }
const sqlite = async (): Promise<Opened> => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "calendar-reads-")), "store.db") })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "google-calendar", account: "o" }, { name: null })
  return { store: store.calendar, accountId }
}
const stores: [string, () => Promise<Opened>][] = [
  ["sqlite", sqlite],
  ["memory", async () => ({ store: memoryEventStore(), accountId: 1 })],
]

const madridAllDay = (date: string, next: string, title: string): EntryInput => ({
  externalId: title,
  kind: "single",
  status: "confirmed",
  title,
  allDay: true,
  startDate: date,
  endDate: next,
  startsAt: Date.parse(`${date}T00:00:00+01:00`),
  endsAt: Date.parse(`${next}T00:00:00+01:00`),
  timezone: "Europe/Madrid",
})

const timed = (at: string, title: string): EntryInput => ({
  externalId: title,
  kind: "single",
  status: "confirmed",
  title,
  startsAt: Date.parse(at),
  endsAt: Date.parse(at) + 3_600_000,
})

const seeded = async (open: () => Promise<Opened>, entries: EntryInput[]) => {
  const { store, accountId } = await open()
  const [calendar] = await store.saveCalendars(
    accountId,
    [
      {
        externalId: "c",
        title: "C",
        timezone: "Europe/Madrid",
        accessRole: "owner",
        primary: true,
        syncByDefault: true,
      },
    ],
    0,
  )
  await store.saveEntries(calendar?.id ?? 0, entries, 0)
  return { store, accountId }
}

describe.each(stores)("events list on the %s store", (_name, open) => {
  it.each([
    ["UTC", ["Nov 2", "Nov 2 20:00Z"]],
    ["America/Los_Angeles", ["Nov 2", "Nov 2 20:00Z"]],
    ["Asia/Tokyo", ["Nov 2"]],
  ])("starts_at:2026-11-02 in %s holds only the events that start that day there", async (zone, titles) => {
    const { store, accountId } = await seeded(open, [
      madridAllDay("2026-11-01", "2026-11-02", "Nov 1"),
      madridAllDay("2026-11-02", "2026-11-03", "Nov 2"),
      madridAllDay("2026-11-03", "2026-11-04", "Nov 3"),
      timed("2026-11-02T20:00:00Z", "Nov 2 20:00Z"),
    ])
    const filter = await eventsFilter("starts_at:2026-11-02", { store, accountId, zone, now: 0 })
    const answer = await eventsAnswer(store, filter)
    expect(answer.items.map(({ title }) => title)).toEqual(titles)
  })

  it("starts_at>= keeps the event that starts exactly then; ends_at>= leaves out the one that ends exactly then", async () => {
    const { store, accountId } = await seeded(open, [
      timed("2026-11-02T09:00:00Z", "at nine"),
      timed("2026-11-02T08:59:59.999Z", "just before"),
      timed("2026-11-02T08:00:00Z", "ends at nine"),
      madridAllDay("2026-11-02", "2026-11-03", "Nov 2"),
      madridAllDay("2026-11-01", "2026-11-02", "Nov 1"),
    ])
    const titles = async (query: string, zone = "UTC") =>
      (await eventsAnswer(store, await eventsFilter(query, { store, accountId, zone, now: 0 }))).items
        .map(({ title }) => title)
        .sort()
    expect(await titles(`starts_at>="2026-11-02T09:00:00Z"`)).toEqual(["at nine"])
    expect(await titles("starts_at>=2026-11-02", "Europe/Madrid")).toEqual(
      ["Nov 2", "at nine", "ends at nine", "just before"].sort(),
    )
    expect(await titles("starts_at:[2026-11-01 TO 2026-11-02}", "Europe/Madrid")).toEqual(["Nov 1"])
    expect(await titles(`ends_at>="2026-11-02T09:00:00Z"`)).toEqual(["Nov 2", "at nine", "just before"].sort())
  })

  it("refuses a range ends_at and changed_at cannot answer, and a word that is not a field", async () => {
    const { store, accountId } = await seeded(open, [])
    const refused = (query: string) =>
      eventsFilter(query, { store, accountId, zone: "UTC", now: 0 }).then(
        () => "answered",
        (error: { details?: { reason?: string } }) => error.details?.reason,
      )
    expect(await refused("ends_at<2026-11-02")).toBe("query.unsupported-operator")
    expect(await refused("changed_at:[2026-10-01 TO 2026-10-02]")).toBe("query.unsupported-operator")
    expect(await refused("week")).toMatch(/^query\./u)
    expect(await refused("starts_at>=2026-11-02 starts_at<2026-11-07")).toBe("query.unsupported-placement")
  })

  it("has_more is true only while another event follows the page", async () => {
    const { store, accountId } = await seeded(open, [
      timed("2026-11-02T08:00:00Z", "a"),
      timed("2026-11-02T09:00:00Z", "b"),
      timed("2026-11-02T10:00:00Z", "c"),
    ])
    const filter = await eventsFilter("ends_at>=2026-11-01", { store, accountId, zone: "UTC", now: 0 })
    const cut = await eventsAnswer(store, filter && { ...filter, limit: 2 })
    expect(cut).toMatchObject({ limit: 2, hasMore: true })
    expect(cut.items.map(({ title }) => title)).toEqual(["a", "b"])
    expect(await eventsAnswer(store, filter && { ...filter, limit: 3 })).toMatchObject({ hasMore: false })
  })

  it("the next page starts after the last event of the one before", async () => {
    const { store, accountId } = await seeded(open, [
      timed("2026-11-02T08:00:00Z", "a"),
      timed("2026-11-02T09:00:00Z", "b"),
      timed("2026-11-02T10:00:00Z", "c"),
    ])
    const filter = await eventsFilter("ends_at>=2026-11-01", { store, accountId, zone: "UTC", now: 0 })
    const second = await eventsAnswer(store, filter && { ...filter, limit: 2 }, 2)
    expect(second).toMatchObject({ page: 2, limit: 2, hasMore: false })
    expect(second.items.map(({ title }) => title)).toEqual(["c"])
  })
})

describe("people list", () => {
  it("says the answer is truncated when it counted only the first 1000 events", async () => {
    const attended = (n: number): EntryInput => ({
      ...timed(new Date(Date.UTC(2026, 10, 2) + n * 60_000).toISOString(), `e${n}`),
      participants: [{ email: "ana@example.com", response: "accepted" }],
    })
    const { store, accountId } = await seeded(
      sqlite,
      Array.from({ length: 1001 }, (_, n) => attended(n)),
    )
    const filter = { from: Date.UTC(2026, 10, 1) }
    const capped = await peopleAnswer(store, accountId, { filter })
    expect(capped).toMatchObject({ items: [{ email: "ana@example.com", events: 1000 }], meta: { truncated: true } })
    const all = await peopleAnswer(store, accountId, { filter: { ...filter, to: Date.UTC(2026, 10, 2, 16) } })
    expect(all).not.toHaveProperty("meta")
  })
})
