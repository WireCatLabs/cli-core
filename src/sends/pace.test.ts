import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Pacer, waitForTurn } from "./pace.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "pace-")), "pace", "p.json")
const T = 1_000_000

describe("the request pace", () => {
  it("lets a burst go at once, then spaces calls one interval apart", async () => {
    const pacer = new Pacer(fresh(), { perMinute: 60, burst: 3 }, () => T)

    const ats: number[] = []
    for (let i = 0; i < 6; i++) ats.push((await pacer.reserve()) - T)
    expect(ats).toEqual([0, 0, 0, 0, 1_000, 2_000])
  })

  it("counts two processes on one profile against the same pace", async () => {
    const path = fresh()
    const one = new Pacer(path, { perMinute: 60, burst: 1 }, () => T)
    const two = new Pacer(path, { perMinute: 60, burst: 1 }, () => T)

    const ats: number[] = []
    for (const pacer of [one, two, one, two]) ats.push((await pacer.reserve()) - T)
    expect(ats).toEqual([0, 0, 1_000, 2_000])
  })

  it("refills while idle", async () => {
    let now = T
    const pacer = new Pacer(fresh(), { perMinute: 60, burst: 1 }, () => now)
    for (let i = 0; i < 4; i++) await pacer.reserve()
    now += 60_000

    expect(await pacer.reserve()).toBe(now)
  })

  it("holds every process when the messenger asks one to wait", async () => {
    const path = fresh()
    await new Pacer(path, { perMinute: 60, burst: 20 }, () => T).holdFor(30_000)

    expect(await new Pacer(path, { perMinute: 60, burst: 20 }, () => T).reserve()).toBe(T + 30_000)
  })

  it("lets every process go again once the owner clears it", async () => {
    const pacer = new Pacer(fresh(), { perMinute: 60, burst: 0 }, () => T)
    await pacer.holdFor(600_000)
    await pacer.reset()

    expect(await pacer.reserve()).toBe(T)
  })

  it("does nothing at 0 a minute", async () => {
    const pacer = new Pacer(fresh(), { perMinute: 0, burst: 0 }, () => T)
    await pacer.holdFor(30_000)

    expect([await pacer.reserve(), await pacer.reserve()]).toEqual([T, T])
  })
})

describe("waiting for a turn", () => {
  const turn = async (pacer: Pacer) => {
    const slept: number[] = []
    const warned: string[] = []
    await waitForTurn(pacer, {
      name: "Example CRM",
      operation: "deals.list",
      warn: (message) => warned.push(message),
      sleep: async (ms) => {
        slept.push(ms)
      },
      now: () => T,
    })
    return { slept, warned }
  }

  it("waits a short turn silently and a long one with a warning", async () => {
    const pacer = new Pacer(fresh(), { perMinute: 60, burst: 1 }, () => T)
    for (const _ of [1, 2]) expect(await turn(pacer)).toEqual({ slept: [], warned: [] })
    expect(await turn(pacer)).toEqual({ slept: [1_000], warned: [] })
    await pacer.holdFor(30_000)
    expect(await turn(pacer)).toEqual({
      slept: [30_000],
      warned: ["waiting 30 s to keep this profile's pace with Example CRM"],
    })
  })

  it("refuses a wait longer than a run sits out, sending nothing", async () => {
    const pacer = new Pacer(fresh(), { perMinute: 60, burst: 1 }, () => T)
    await pacer.holdFor(10 * 60_000)
    await expect(turn(pacer)).rejects.toMatchObject({ code: "rate_limited", details: { remembered: true } })
  })
})
