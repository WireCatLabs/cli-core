import { describe, expect, it } from "vitest"
import { calendarSyncWindow, parseCalendarCursor, syncCalendars } from "./index.js"
import { fakeCalendarSource, memoryEventStore } from "./testing/index.js"

const NOW = Date.UTC(2026, 9, 27, 9, 30)

describe("syncCalendars", () => {
  it("covers a year back and three months ahead, from the start of the day in UTC", () => {
    expect(calendarSyncWindow(NOW)).toEqual({ from: Date.UTC(2025, 9, 27), to: Date.UTC(2027, 0, 27) })
  })

  it("refuses a source it cannot expand", async () => {
    const store = memoryEventStore()
    await expect(
      syncCalendars(fakeCalendarSource({ traits: { expands: "local" } }), store, { accountId: 1, now: NOW }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    const { occurrences: _, ...noSlots } = fakeCalendarSource()
    await expect(syncCalendars(noSlots, store, { accountId: 1, now: NOW })).rejects.toMatchObject({
      code: "configuration_error",
    })
  })

  it("a reset during a full list fails the calendar instead of looping", async () => {
    const source = fakeCalendarSource()
    const report = await syncCalendars(
      { ...source, changes: async () => ({ reset: true as const }) },
      memoryEventStore(),
      { accountId: 1, now: NOW },
    )
    expect(report.complete).toBe(false)
    expect(report.synced[0]?.error).toMatch(/refused a full list/u)
  })

  it("does not repeat an error that is not the adapter's own, which may hold a token", async () => {
    const source = fakeCalendarSource()
    const report = await syncCalendars(
      {
        ...source,
        changes: async () => {
          throw new Error("GET https://example.com/delta?token=SECRET-MARKER failed")
        },
      },
      memoryEventStore(),
      { accountId: 1, now: NOW },
    )
    expect(report.synced[0]?.error).toBe("the calendar could not be synced")
  })

  it("an unreadable cursor means a full round", async () => {
    const store = memoryEventStore()
    const source = fakeCalendarSource()
    const [calendar] = await store.saveCalendars(1, await source.calendars(), NOW)
    await store.setCursor(calendar?.id as number, "not json", NOW)
    const report = await syncCalendars(source, store, { accountId: 1, now: NOW })
    expect(report.synced[0]?.round).toBe("full")
    expect(parseCalendarCursor(await store.cursor(calendar?.id as number))).toMatchObject({
      v: 2,
      fullAt: NOW,
      round: null,
    })
  })

  it("lists every calendar again once a day, so every series is asked for its slots", async () => {
    const store = memoryEventStore()
    const source = fakeCalendarSource()
    await syncCalendars(source, store, { accountId: 1, now: NOW })
    expect((await syncCalendars(source, store, { accountId: 1, now: NOW + 3_600_000 })).synced[0]?.round).toBe(
      "changes",
    )
    expect((await syncCalendars(source, store, { accountId: 1, now: NOW + 86_400_000 })).synced[0]?.round).toBe("full")
  })

  it("brings back, once per calendar, entries an older build marked deleted outside its window", async () => {
    const store = memoryEventStore()
    const source = fakeCalendarSource()
    await syncCalendars(source, store, { accountId: 1, now: NOW })
    const [calendar] = await store.calendars(1)
    const id = calendar?.id as number
    const old = Date.UTC(2024, 0, 10, 9)
    const damage = async (externalId: string) => {
      await store.saveEntries(
        id,
        [
          {
            externalId,
            kind: "single",
            status: "confirmed",
            title: "Old review",
            startsAt: old,
            endsAt: old + 3_600_000,
          },
        ],
        NOW,
      )
      await store.markUnseen(id, NOW + 1, { from: 0, to: Number.MAX_SAFE_INTEGER }, NOW + 1)
    }
    await damage("first")
    const { restored: _, ...olderCursor } = parseCalendarCursor(await store.cursor(id)) ?? {}
    await store.setCursor(id, JSON.stringify(olderCursor), NOW)
    await syncCalendars(source, store, { accountId: 1, now: NOW + 3_600_000 })
    expect((await store.entry(id, "first"))?.deletedAt).toBeNull()
    expect(parseCalendarCursor(await store.cursor(id))?.restored).toBe(true)
    await damage("second")
    await syncCalendars(source, store, { accountId: 1, now: NOW + 7_200_000 })
    expect((await store.entry(id, "second"))?.deletedAt).not.toBeNull()
  })
})
