import { describe, expect, it } from "vitest"
import { questionPeriod } from "./question-period.js"

const NOW = Date.parse("2025-12-31T12:00:00Z")
const days = (text: string, now = NOW, zone = "UTC") => {
  const period = questionPeriod(text, now, zone)
  return period && [new Date(period.from).toISOString(), new Date(period.to).toISOString()]
}

describe("questionPeriod", () => {
  it.each([
    ["On which day in May 2025 did we meet?", "2025-05-01", "2025-06-01"],
    ["the climbing competition on June 22", "2025-06-22", "2025-06-23"],
    ["the 5th of March", "2025-03-05", "2025-03-06"],
    ["meeting on 2025-02-03", "2025-02-03", "2025-02-04"],
    ["between March 1 and March 15", "2025-03-01", "2025-03-16"],
    ["what did I do in March this year?", "2025-03-01", "2025-04-01"],
    ["what did I do yesterday", "2025-12-30", "2025-12-31"],
    ["last week", "2025-12-22", "2025-12-29"],
    ["2 weeks ago", "2025-12-15", "2025-12-22"],
    ["что я делал вчера", "2025-12-30", "2025-12-31"],
    ["что решили в прошлом месяце?", "2025-11-01", "2025-12-01"],
    ["встреча 5 марта", "2025-03-05", "2025-03-06"],
  ])("%s → %s to %s", (text, from, to) => {
    expect(days(text)).toEqual([`${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`])
  })

  it.each(["May I ask what my pay is?", "what is my current pay?"])("%s names no period", (text) => {
    expect(days(text)).toBeUndefined()
  })

  it("reads a month without a year as its last one up to now", () => {
    expect(days("in December", Date.parse("2026-03-09T12:00:00Z"))?.[0]).toBe("2025-12-01T00:00:00.000Z")
  })

  it("reads today on the zone's calendar", () => {
    expect(days("today", Date.parse("2026-11-09T23:30:00Z"), "Asia/Tokyo")).toEqual([
      "2026-11-09T15:00:00.000Z",
      "2026-11-10T15:00:00.000Z",
    ])
  })
})
