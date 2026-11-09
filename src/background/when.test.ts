import { afterEach, describe, expect, it } from "vitest"
import { calendarOf, describeWhen, nextRun, previousRun, runsBetween } from "./when.js"

const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

describe("a calendar schedule's runs", () => {
  const twice = calendarOf([{ at: "08:30" }, { at: "18:00" }])
  // 2026-11-09 is a Monday.
  const mondays = calendarOf([{ at: "09:00", on: "mon" }])

  it("lists each time of each day in order", () => {
    expect(runsBetween(twice, local(9, 0), local(10, 12))).toEqual([local(9, 8, 30), local(9, 18), local(10, 8, 30)])
  })

  it("keeps a weekday's times to that day", () => {
    expect(runsBetween(mondays, local(1, 0), local(30, 0))).toEqual([
      local(2, 9),
      local(9, 9),
      local(16, 9),
      local(23, 9),
    ])
  })

  it("finds the run before and after a moment, a week back or ahead at most", () => {
    expect(previousRun(twice, local(9, 18))).toBe(local(9, 18))
    expect(previousRun(twice, local(9, 17, 59))).toBe(local(9, 8, 30))
    expect(nextRun(twice, local(9, 18))).toBe(local(10, 8, 30))
    expect(previousRun(mondays, local(9, 8))).toBe(local(2, 9))
    expect(nextRun(mondays, local(9, 9))).toBe(local(16, 9))
  })

  it("says several weekdays and times in a few words", () => {
    expect(
      describeWhen(
        calendarOf([
          { at: "09:00", on: "fri" },
          { at: "09:00", on: "mon" },
        ]),
      ),
    ).toBe("weekly on Mon, Fri at 09:00")
    expect(
      describeWhen(
        calendarOf([
          { at: "09:00", on: "mon" },
          { at: "18:00", on: "fri" },
        ]),
      ),
    ).toBe("at Mon 09:00, Fri 18:00")
    expect(describeWhen(calendarOf([{ at: "07:00" }]))).toBe("daily at 07:00")
  })
})

describe("a weekly run across a clock change", () => {
  const zone = process.env.TZ
  afterEach(() => {
    process.env.TZ = zone
  })

  it("is a calendar week away, not 168 hours", () => {
    process.env.TZ = "Europe/Madrid"
    const mondays = calendarOf([{ at: "09:00", on: "mon" }])
    // The clocks go back on 2026-10-25.
    expect(nextRun(mondays, new Date(2026, 9, 19, 9).getTime())).toBe(new Date(2026, 9, 26, 9).getTime())
    expect(previousRun(mondays, new Date(2026, 9, 26, 8, 30).getTime())).toBe(new Date(2026, 9, 19, 9).getTime())
  })
})
