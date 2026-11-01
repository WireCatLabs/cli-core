import { describe, expect, it } from "vitest"
import { foldLine, type IcsEvent, readIcs, writeIcs } from "./ics.js"

const NOW = Date.UTC(2026, 10, 1, 9)
const at = (text: string) => Date.parse(text)

const planning: IcsEvent = {
  uid: "planning-1@example.com",
  title: "Example planning; agenda, notes",
  description: "Line one\nC:\\path",
  location: "Room 1",
  startsAt: at("2026-11-02T10:00:00Z"),
  endsAt: at("2026-11-02T11:00:00Z"),
  status: "confirmed",
  organizer: { email: "owner@example.com", name: "Owner, Example" },
  attendees: [{ email: "ana@example.com", name: "Ana Example", response: "accepted", optional: true }],
}

const lines = (text: string) => text.replace(/\r\n /gu, "").split("\r\n")

describe("writeIcs", () => {
  it("writes one VCALENDAR with CRLF line ends, a DTSTAMP and UTC times", () => {
    const text = writeIcs([planning], { now: NOW, product: "gcal" })
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true)
    expect(text.replace(/\r\n/gu, "")).not.toMatch(/\n/u)
    expect(lines(text)).toEqual(
      expect.arrayContaining([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//WireCat//gcal//EN",
        "UID:planning-1@example.com",
        "DTSTAMP:20261101T090000Z",
        "DTSTART:20261102T100000Z",
        "DTEND:20261102T110000Z",
        "STATUS:CONFIRMED",
      ]),
    )
  })

  it("escapes text values and quotes parameter values that need it", () => {
    const text = lines(writeIcs([planning], { now: NOW, product: "gcal" }))
    expect(text).toContain("SUMMARY:Example planning\\; agenda\\, notes")
    expect(text).toContain("DESCRIPTION:Line one\\nC:\\\\path")
    expect(text).toContain('ORGANIZER;CN="Owner, Example":mailto:owner@example.com')
    expect(text).toContain("ATTENDEE;CN=Ana Example;PARTSTAT=ACCEPTED;ROLE=OPT-PARTICIPANT:mailto:ana@example.com")
  })

  it("writes an all-day event as dates with an exclusive end", () => {
    const text = lines(
      writeIcs([{ uid: "day@example.com", title: "Offsite", startDate: "2026-11-03", endDate: "2026-11-05" }], {
        now: NOW,
        product: "gcal",
      }),
    )
    expect(text).toContain("DTSTART;VALUE=DATE:20261103")
    expect(text).toContain("DTEND;VALUE=DATE:20261105")
  })

  it("folds lines at 75 octets without splitting a character", () => {
    const long = `SUMMARY:${"Встреча по планированию ".repeat(6)}`
    const folded = foldLine(long).split("\r\n")
    expect(folded.length).toBeGreaterThan(1)
    for (const [index, part] of folded.entries()) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75)
      if (index > 0) expect(part.startsWith(" ")).toBe(true)
      expect(part).not.toContain("�")
    }
    expect(folded.map((part, index) => (index ? part.slice(1) : part)).join("")).toBe(long)
    expect(foldLine("SHORT:line")).toBe("SHORT:line")
  })
})

describe("readIcs", () => {
  it("reads back what writeIcs wrote", () => {
    const { events, skipped } = readIcs(writeIcs([planning], { now: NOW, product: "gcal" }), "Europe/Madrid")
    expect(skipped).toEqual([])
    expect(events).toEqual([{ ...planning, timezone: "UTC" }])
  })

  it("reads a TZID time in its zone, a floating one in the reader's, and keeps repeat rules", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:standup@example.com",
      "DTSTART;TZID=Europe/Madrid:20261102T093000",
      "DURATION:PT15M",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
      "EXDATE;TZID=Europe/Madrid:20261104T093000",
      "SUMMARY:Example stand",
      " up",
      "BEGIN:VALARM",
      "TRIGGER:-PT5M",
      "DESCRIPTION:not the event's",
      "END:VALARM",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:floating@example.com",
      "DTSTART:20261102T120000",
      "DTEND:20261102T130000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n")
    const { events } = readIcs(text, "America/New_York")
    expect(events[0]).toEqual({
      uid: "standup@example.com",
      title: "Example standup",
      startsAt: at("2026-11-02T08:30:00Z"),
      endsAt: at("2026-11-02T08:45:00Z"),
      timezone: "Europe/Madrid",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE;TZID=Europe/Madrid:20261104T093000"],
    })
    expect(events[1]).toMatchObject({ startsAt: at("2026-11-02T17:00:00Z"), timezone: "America/New_York" })
  })

  it("an all-day event with no end lasts one day", () => {
    const text =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261231\r\nEND:VEVENT\r\nEND:VCALENDAR"
    expect(readIcs(text, "UTC").events[0]).toMatchObject({ startDate: "2026-12-31", endDate: "2027-01-01" })
  })

  it("skips an event it cannot import alone, saying why, and refuses text that is not iCalendar", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:changed@example.com",
      "RECURRENCE-ID:20261104T093000Z",
      "DTSTART:20261104T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20261104T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:zone@example.com",
      "DTSTART;TZID=W. Europe Standard Time:20261104T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    const { events, skipped } = readIcs(text, "UTC")
    expect(events).toEqual([])
    expect(skipped).toEqual([
      { uid: "changed@example.com", reason: expect.stringContaining("RECURRENCE-ID") },
      { uid: null, reason: "the event has no UID" },
      { uid: "zone@example.com", reason: expect.stringContaining("not an IANA zone") },
    ])
    expect(() => readIcs("hello", "UTC")).toThrow(/not iCalendar/u)
  })
})
