import { describe, expect, it } from "vitest"
import type { EntryInput } from "../meetings/index.js"
import { expandSeries, localMoment, unexpandable } from "./expand.js"

const YEAR = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2028, 0, 1) }

const series = (extra: Partial<EntryInput>): EntryInput => ({
  externalId: "s1",
  kind: "series",
  status: "confirmed",
  title: "Example standup",
  ...extra,
})

const starts = (slots: EntryInput[]) => slots.map((slot) => new Date(slot.startsAt as number).toISOString())

describe("expandSeries", () => {
  it("keeps a weekly 10:00 in Madrid at 10:00 across the clock change of 2026-10-25", () => {
    const at = localMoment("2026-10-15", "10:00:00", "Europe/Madrid")
    const slots = expandSeries(
      series({
        startsAt: at,
        endsAt: at + 1_800_000,
        timezone: "Europe/Madrid",
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      }),
      YEAR,
    )
    expect(starts(slots)).toEqual(["2026-10-15T08:00:00.000Z", "2026-10-22T08:00:00.000Z", "2026-10-29T09:00:00.000Z"])
    expect(slots[2]).toMatchObject({
      externalId: "s1_20261029T090000Z",
      kind: "occurrence",
      seriesExternalId: "s1",
      originalStartsAt: Date.parse("2026-10-29T09:00:00Z"),
      endsAt: Date.parse("2026-10-29T09:30:00Z"),
      exception: false,
      recurrence: null,
    })
  })

  it("repeats an all-day holiday every year by its date, and Thanksgiving on the fourth Thursday", () => {
    const allDay = (date: string, rule: string) =>
      series({
        allDay: true,
        startDate: date,
        endDate: `${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, "0")}`,
        startsAt: Date.parse(`${date}T00:00:00Z`),
        endsAt: Date.parse(`${date}T00:00:00Z`) + 86_400_000,
        timezone: "UTC",
        recurrence: [rule],
      })
    const christmas = expandSeries(allDay("2020-12-25", "RRULE:FREQ=YEARLY"), YEAR)
    expect(christmas.map((slot) => [slot.startDate, slot.endDate, slot.externalId])).toEqual([
      ["2026-12-25", "2026-12-26", "s1_20261225"],
      ["2027-12-25", "2027-12-26", "s1_20271225"],
    ])
    const thanksgiving = expandSeries(allDay("2020-11-26", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), YEAR)
    expect(thanksgiving.map((slot) => slot.startDate)).toEqual(["2026-11-26", "2027-11-25"])
  })

  it("takes the last Friday of the month, UNTIL, RDATE, and returns an EXDATE slot cancelled", () => {
    const at = Date.parse("2026-01-30T15:00:00Z")
    const slots = expandSeries(
      series({
        startsAt: at,
        endsAt: at + 3_600_000,
        timezone: "UTC",
        recurrence: [
          "RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20260430T235959Z",
          "EXDATE:20260227T150000Z",
          "RDATE:20260515T150000Z",
        ],
      }),
      YEAR,
    )
    expect(
      slots.map((slot) => [slot.startsAt && new Date(slot.startsAt).toISOString().slice(0, 10), slot.status]),
    ).toEqual([
      ["2026-01-30", "confirmed"],
      ["2026-02-27", "cancelled"],
      ["2026-03-27", "confirmed"],
      ["2026-04-24", "confirmed"],
      ["2026-05-15", "confirmed"],
    ])
  })

  it("puts an override in the place of the slot it replaces, and returns only slots inside the window", () => {
    const at = Date.parse("2026-11-02T09:00:00Z")
    const moved = {
      ...series({
        title: "Example standup, moved",
        startsAt: at + 86_400_000 + 3_600_000,
        endsAt: at + 86_400_000 + 5_400_000,
      }),
      kind: "single" as const,
      originalStartsAt: at + 86_400_000,
    }
    const slots = expandSeries(
      series({ startsAt: at, endsAt: at + 1_800_000, timezone: "UTC", recurrence: ["RRULE:FREQ=DAILY"] }),
      { from: at, to: at + 3 * 86_400_000 },
      [moved],
    )
    expect(slots.map((slot) => [slot.externalId, slot.title, slot.exception])).toEqual([
      ["s1_20261102T090000Z", "Example standup", false],
      ["s1_20261103T090000Z", "Example standup, moved", true],
      ["s1_20261104T090000Z", "Example standup", false],
    ])
    expect(slots[1]?.startsAt).toBe(Date.parse("2026-11-03T10:00:00Z"))
  })

  it("names the rules it does not expand instead of guessing", () => {
    expect(unexpandable(["RRULE:FREQ=HOURLY"])).toBe("RRULE FREQ=HOURLY is not expanded")
    expect(unexpandable(["RRULE:FREQ=DAILY;BYHOUR=9,17"])).toBe("RRULE part BYHOUR is not expanded")
    expect(unexpandable(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2"])).toBeNull()
    expect(expandSeries(series({ startsAt: 0, recurrence: ["RRULE:FREQ=MINUTELY"] }), YEAR)).toEqual([])
  })
})

describe("localMoment", () => {
  it("moves a time the clock skips past the change, and takes the first of a time it repeats", () => {
    expect(new Date(localMoment("2026-03-29", "02:30:00", "Europe/Madrid")).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    )
    expect(new Date(localMoment("2026-10-25", "02:30:00", "Europe/Madrid")).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    )
  })
})
