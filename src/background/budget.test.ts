import { describe, expect, it } from "vitest"
import { runBudget } from "./budget.js"

describe("runBudget", () => {
  it("says no once its requests are spent, and keeps saying it", () => {
    const budget = runBudget({ requests: 2 })
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([null, null, "requests", "requests"])
    expect([budget.used, budget.stopped]).toEqual([2, "requests"])
  })

  it("allows one request per 2 s of the deadline when not told, and no limit without a deadline", () => {
    expect(runBudget({ deadline: { endsAt: 30_000, ms: 30_000 }, now: () => 0 }).limit).toBe(15)
    expect(runBudget({ deadline: { endsAt: 600_000, ms: 600_000 }, now: () => 0 }).limit).toBe(300)
    expect(runBudget().limit).toBeNull()
  })

  it("stops 5 s before a short deadline and 15% before a long one", () => {
    const at = (now: number, ms: number) => runBudget({ requests: 1000, deadline: { endsAt: ms, ms }, now: () => now })
    expect(at(24_000, 30_000).take()).toBeNull()
    expect(at(25_000, 30_000).take()).toBe("deadline")
    expect(at(500_000, 600_000).take()).toBeNull()
    expect(at(510_000, 600_000).take()).toBe("deadline")
  })

  it("leaves room for a request as slow as the slowest one so far", () => {
    const clock = [0, 9_000, 17_000]
    const budget = runBudget({ requests: 100, deadline: { endsAt: 30_000, ms: 30_000 }, now: () => clock.shift() ?? 0 })
    expect([budget.take(), budget.take(), budget.take()]).toEqual([null, null, "deadline"])
  })

  it("stops when the run's signal is aborted", () => {
    const stop = new AbortController()
    const budget = runBudget({ signal: stop.signal })
    expect(budget.take()).toBeNull()
    stop.abort()
    expect(budget.take()).toBe("cancelled")
  })
})
