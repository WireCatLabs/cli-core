import { describe, it } from "vitest"
import type { EntryInput } from "../../meetings/index.js"
import {
  CALENDAR_TRAIT_COMBINATIONS,
  calendarSourceContract,
  calendarSyncContract,
  calendarWriterContract,
  eventStoreContract,
  fakeCalendarSource,
  fakeCalendarWriter,
  memoryEventStore,
} from "./index.js"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 27, 9)
const window = { from: NOW - 365 * 24 * HOUR, to: NOW + 90 * 24 * HOUR }

describe("memory event store", () => {
  for (const c of eventStoreContract(() => ({ store: memoryEventStore(), accountId: 1, otherAccountId: 2 })))
    it(c.name, c.run)
})

describe("sync engine over the memory store", () => {
  for (const c of calendarSyncContract(() => ({ store: memoryEventStore(), accountId: 1 }))) it(c.name, c.run)
})

describe("fake calendar source", () => {
  for (const traits of CALENDAR_TRAIT_COMBINATIONS)
    for (const c of calendarSourceContract(() => {
      const source = fakeCalendarSource({ traits, pageSize: 2 })
      const series = {
        externalId: "s",
        kind: "series" as const,
        status: "confirmed" as const,
        icalUid: "s@example.com",
        title: "Example standup",
        startsAt: NOW + HOUR,
        endsAt: NOW + 2 * HOUR,
        timezone: "Europe/Madrid",
        recurrence: ["RRULE:FREQ=DAILY;COUNT=2", "EXDATE:20261028T100000Z"],
      }
      const slot = (at: number, status: "confirmed" | "cancelled") => ({
        ...series,
        externalId: `s_${at}`,
        kind: "occurrence" as const,
        seriesExternalId: "s",
        originalStartsAt: at,
        status,
        startsAt: at,
        endsAt: at + HOUR,
        recurrence: null,
      })
      const slots = [slot(NOW + HOUR, "confirmed"), slot(NOW + 25 * HOUR, "cancelled")]
      const allDay = {
        externalId: "holiday",
        kind: "single" as const,
        status: "confirmed" as const,
        allDay: true,
        startDate: "2026-10-28",
        endDate: "2026-10-29",
        startsAt: NOW + 15 * HOUR,
        endsAt: NOW + 39 * HOUR,
        joinUrl: "https://example.com/j/123",
        transparency: "transparent" as const,
      }
      source.put("primary", series, allDay, ...(traits.expands === "in-changes" ? slots : []))
      if (traits.expands === "on-request") source.setOccurrences("s", slots)
      return {
        source,
        window,
        ...(traits.fullListOnly ? {} : { deadCursor: "v-dead" }),
        afterFullList: () => {
          source.put("primary", {
            ...allDay,
            title: "Moved",
            startsAt: NOW + 400 * 24 * HOUR,
            endsAt: NOW + 401 * 24 * HOUR,
          })
          source.remove("primary", "gone")
        },
        changed: ["holiday", "gone"],
        movedOut: "holiday",
        cancelledSlot: { seriesExternalId: "s", originalStartsAt: NOW + 25 * HOUR },
      }
    }))
      it(`${c.name} ${JSON.stringify(traits)}`, c.run)
})

describe("fake calendar writer", () => {
  for (const c of calendarWriterContract(() => {
    const writer = fakeCalendarWriter()
    const calendar = {
      id: 1,
      accountId: 1,
      externalId: "primary",
      title: "Example work",
      timezone: "UTC",
      accessRole: "owner" as const,
      primary: true,
      synced: true,
      seenAt: null,
      deletedAt: null,
    }
    const [existing] = writer.put("primary", {
      externalId: "e1",
      kind: "single",
      status: "confirmed",
      title: "Example review",
      startsAt: NOW + HOUR,
      endsAt: NOW + 2 * HOUR,
      participants: [{ email: "owner@example.com", self: true }],
    })
    return {
      writer,
      calendar,
      existing: existing as EntryInput,
      changeBehind: () => writer.changeBehind("primary", "e1"),
      loseNextAnswer: () => writer.loseNextAnswer(),
      notified: () => writer.calls.map(({ notify }) => notify),
      at: NOW + 24 * HOUR,
      target: { ...calendar, id: 2, externalId: "family", title: "Example family", primary: false },
    }
  }))
    it(c.name, c.run)
})
