import { afterEach, describe, expect, it } from "vitest"
import { aheadOf, momentOf } from "./moment.js"

const processZone = process.env.TZ
const inZone = <T>(zone: string, read: () => T): T => {
  process.env.TZ = zone
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
  return read()
}
afterEach(() => {
  process.env.TZ = processZone
})

describe("momentOf", () => {
  it("starts a date alone at local midnight of the given zone", () => {
    expect(momentOf("2026-09-01", "--since-time", 0, { zone: "Asia/Vladivostok" })).toBe(
      Date.parse("2026-08-31T14:00:00Z"),
    )
  })

  it("ends a date alone at the last millisecond of that local day", () => {
    expect(momentOf("2026-09-01", "--until-time", 0, { zone: "Europe/Madrid", end: true })).toBe(
      Date.parse("2026-09-01T22:00:00Z") - 1,
    )
  })

  it("reads a time without a zone in the given zone, whatever the process zone", () => {
    const read = () => momentOf("2026-10-21T16:03", "--since-time", 0, { zone: "Europe/Madrid" })
    expect([inZone("Asia/Vladivostok", read), inZone("America/Los_Angeles", read)]).toEqual([
      Date.parse("2026-10-21T14:03:00Z"),
      Date.parse("2026-10-21T14:03:00Z"),
    ])
  })

  it("uses the computer's zone when none is given", () => {
    expect(inZone("Asia/Vladivostok", () => momentOf("2026-09-01", "--since-time"))).toBe(
      Date.parse("2026-08-31T14:00:00Z"),
    )
  })

  it("keeps a time that names its own offset", () => {
    expect(momentOf("2026-10-21T16:03:00+02:00", "--since-time", 0, { zone: "Asia/Vladivostok" })).toBe(
      Date.parse("2026-10-21T14:03:00Z"),
    )
  })

  it("refuses a local time daylight saving skips, naming the flag", () => {
    expect(() => momentOf("2026-03-29T02:30", "--since-time", 0, { zone: "Europe/Madrid" })).toThrow(
      /--since-time: .*daylight saving/,
    )
  })

  it("still counts back from now", () => {
    expect(momentOf("2h", "--since-time", 10_000_000)).toBe(10_000_000 - 7_200_000)
  })
})

describe("aheadOf", () => {
  it("reads a due time without a zone in the given zone", () => {
    expect(aheadOf("2026-10-22T09:00", "--due-time", 0, { zone: "Asia/Vladivostok" })).toBe(
      Date.parse("2026-10-21T23:00:00Z"),
    )
  })
})
