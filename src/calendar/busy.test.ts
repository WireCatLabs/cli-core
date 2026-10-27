import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { freeSlots, workingHoursOf } from "./busy.js"
import { addCalendarCommands } from "./cli/index.js"
import { repeatRule } from "./recurrence.js"
import { fakeCalendarSource, memoryEventStore } from "./testing/index.js"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 2, 7)

const setup = async (options: { freeBusy?: boolean } = { freeBusy: true }) => {
  const store = memoryEventStore()
  const source = fakeCalendarSource()
  await store.saveCalendars(1, await source.calendars(), NOW)
  source.put("primary", {
    externalId: "e1",
    kind: "single",
    status: "confirmed",
    title: "Example review",
    startsAt: Date.UTC(2026, 10, 2, 9),
    endsAt: Date.UTC(2026, 10, 2, 10),
  })
  source.setBusy("ana@example.com", [{ from: Date.UTC(2026, 10, 2, 11), to: Date.UTC(2026, 10, 2, 12) }])
  source.setBusy("bo@example.com", { error: "notFound" })
  const written: Record<string, unknown>[] = []
  const root = new Command("gcal").exitOverride().configureOutput({ writeErr: () => undefined })
  addCalendarCommands(root, {
    store,
    accountId: 1,
    account: { provider: "example-calendar", account: "owner-1" },
    source,
    write: (value) => written.push(value as Record<string, unknown>),
    now: () => NOW,
    timezone: "UTC",
    ...options,
  })
  const cli = async (...args: string[]) => {
    await root.parseAsync([...args, "--json"], { from: "user" })
    return written.at(-1) as Record<string, unknown>
  }
  return { cli, root }
}

describe("calendars busy", () => {
  it("is mounted only for a source that answers free/busy", async () => {
    const { root } = await setup({})
    const calendars = root.commands.find((one) => one.name() === "calendars")
    expect(calendars?.commands.map((one) => one.name())).not.toContain("busy")
  })

  it("answers the synced calendars and each person named, with only their busy times", async () => {
    const { cli } = await setup()
    const answer = await cli("calendars", "busy", "today", "person:Ana@example.com")
    expect(answer).toEqual({
      start: "2026-11-02T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
      timezone: "UTC",
      calendars: [
        {
          calendar: "1",
          id: "primary",
          busy: [{ start: "2026-11-02T09:00:00.000Z", end: "2026-11-02T10:00:00.000Z" }],
        },
        {
          person: "ana@example.com",
          id: "ana@example.com",
          busy: [{ start: "2026-11-02T11:00:00.000Z", end: "2026-11-02T12:00:00.000Z" }],
        },
      ],
    })
  })

  it("finds the free stretches everyone shares in working hours, and names whom the provider could not see", async () => {
    const { cli } = await setup()
    const answer = await cli(
      ...["calendars", "busy", "today", "person:ana@example.com", "person:bo@example.com"],
      ...["--duration-minutes", "60", "--hours", "08:00-13:00"],
    )
    expect(answer.slots).toEqual([
      { start: "2026-11-02T08:00:00.000Z", end: "2026-11-02T09:00:00.000Z" },
      { start: "2026-11-02T10:00:00.000Z", end: "2026-11-02T11:00:00.000Z" },
      { start: "2026-11-02T12:00:00.000Z", end: "2026-11-02T13:00:00.000Z" },
    ])
    expect(answer.unknown).toEqual(["bo@example.com"])
    expect(answer.calendars).toContainEqual({
      person: "bo@example.com",
      id: "bo@example.com",
      busy: [],
      error: "notFound",
    })
  })

  it("refuses --offline before asking the provider", async () => {
    const { cli, root } = await setup()
    root.option("--offline")
    await expect(cli("--offline", "calendars", "busy")).rejects.toMatchObject({ details: { reason: "busy.offline" } })
  })

  it("refuses a word it does not know and an address that is not one", async () => {
    const { cli } = await setup()
    await expect(cli("calendars", "busy", "soon")).rejects.toMatchObject({ details: { reason: "query.unknown_word" } })
    await expect(cli("calendars", "busy", "person:ana")).rejects.toMatchObject({ code: "validation_error" })
  })
})

describe("free stretches", () => {
  it("keep local working hours on each side of a clock change, and skip the weekend", () => {
    // Europe/Madrid leaves summer time on Sunday 2026-10-25: 09:00 is 07:00Z on Friday and 08:00Z on Monday.
    const slots = freeSlots(
      [],
      { from: Date.UTC(2026, 9, 23), to: Date.UTC(2026, 9, 27) },
      {
        minutes: 30,
        hours: workingHoursOf("09:00-17:00"),
        zone: "Europe/Madrid",
        now: 0,
      },
    )
    expect(slots.map(({ from, to }) => [new Date(from).toISOString(), new Date(to).toISOString()])).toEqual([
      ["2026-10-23T07:00:00.000Z", "2026-10-23T15:00:00.000Z"],
      ["2026-10-26T08:00:00.000Z", "2026-10-26T16:00:00.000Z"],
    ])
  })

  it("start after now and drop what is shorter than asked", () => {
    const day = Date.UTC(2026, 10, 2)
    const slots = freeSlots(
      [{ from: day + 10 * HOUR, to: day + 10.5 * HOUR }],
      { from: day, to: day + 24 * HOUR },
      {
        minutes: 60,
        hours: workingHoursOf("09:00-12:00"),
        zone: "UTC",
        now: day + 9.5 * HOUR,
      },
    )
    expect(slots).toEqual([{ from: day + 10.5 * HOUR, to: day + 12 * HOUR }])
  })

  it("take working hours as HH:MM-HH:MM only", () => {
    expect(workingHoursOf("09:30-24:00")).toEqual({ start: 570, end: 1440 })
    for (const bad of ["9-17", "17:00-09:00", "09:00-24:30"])
      expect(() => workingHoursOf(bad)).toThrow(/working hours/u)
  })
})

describe("repeat rules", () => {
  it("are written as one RRULE line in a fixed order", () => {
    expect(repeatRule("RRULE:count=4;byday=1mo;freq=monthly", { allDay: false })).toBe(
      "RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=4",
    )
    expect(repeatRule("FREQ=DAILY;INTERVAL=2;UNTIL=20261231", { allDay: true })).toBe(
      "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261231",
    )
  })

  it("refuse what RFC 5545 or the subset does not allow", () => {
    for (const [rule, allDay] of [
      ["FREQ=YEARLY", false],
      ["FREQ=WEEKLY;COUNT=3;UNTIL=20261231T000000Z", false],
      ["FREQ=WEEKLY;BYDAY=1MO", false],
      ["FREQ=WEEKLY;BYDAY=XX", false],
      ["FREQ=DAILY;INTERVAL=0", false],
      ["FREQ=DAILY;UNTIL=20261231", false],
      ["FREQ=DAILY;UNTIL=20261231T000000Z", true],
      ["FREQ=DAILY;UNTIL=20260231", true],
      ["FREQ=DAILY;BYMONTH=1", false],
      ["FREQ=DAILY;FREQ=WEEKLY", false],
      ["", false],
    ] as const)
      expect(() => repeatRule(rule, { allDay }), rule).toThrow(/a repeat rule is/u)
  })
})
