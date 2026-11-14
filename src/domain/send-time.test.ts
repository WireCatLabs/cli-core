import { describe, expect, it } from "vitest"
import { sendTime } from "./send-time.js"

const MINUTE = 60_000

describe("sendTime", () => {
  it("reads a delay in minutes, hours or days", () => {
    const now = Date.parse("2026-09-24T12:00:00Z")
    expect(Date.parse(sendTime("90m", now)) - now).toBe(90 * MINUTE)
    expect(Date.parse(sendTime("2h", now)) - now).toBe(120 * MINUTE)
    expect(Date.parse(sendTime("1d", now)) - now).toBe(24 * 60 * MINUTE)
  })

  it("reads a time without an offset as local time, rounded down to the minute", () => {
    const now = Date.parse("2026-09-24T12:00:00")
    expect(sendTime("2026-09-25T09:00", now)).toBe(new Date("2026-09-25T09:00:00").toISOString())
    expect(sendTime("2026-09-25 09:00:45", now)).toBe(new Date("2026-09-25T09:00:00").toISOString())
  })

  it.each([
    ["the past", "2020-01-01T09:00"],
    ["less than a minute ahead", "0m"],
    ["seconds", "90s"],
    ["more than a year ahead", "2030-01-01T09:00"],
    ["neither a time nor a delay", "tomorrow"],
    ["a date alone", "2026-09-25"],
    ["today", "today"],
  ])("refuses %s", (_, at) => {
    expect(() => sendTime(at, Date.parse("2026-09-24T12:00:00"))).toThrow(/--at-time/)
  })
})
