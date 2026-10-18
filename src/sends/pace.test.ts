import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Pacer } from "./pace.js"

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
