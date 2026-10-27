import { describe, expect, it } from "vitest"
import { runBudget } from "./budget.js"

describe("runBudget", () => {
  it("says no once its requests are spent, and keeps saying it", () => {
    const budget = runBudget({ requests: 2 })
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([null, null, "requests", "requests"])
    expect([budget.used, budget.stopped]).toEqual([2, "requests"])
  })

  it("allows the requests that fit before the margin, (deadline − margin) / requestMs, and a lower count asked", () => {
    const deadline = (ms: number) => ({ endsAt: ms, ms })
    expect(runBudget({ deadline: deadline(30_000) }).limit).toBe(12)
    expect(runBudget({ deadline: deadline(300_000) }).limit).toBe(127)
    expect(runBudget({ deadline: deadline(45_000), requestMs: 1_500 }).limit).toBe(25)
    expect(runBudget({ deadline: deadline(30_000), requests: 5 }).limit).toBe(5)
    expect(runBudget({ deadline: deadline(30_000), requests: 500 }).limit).toBe(12)
    expect(runBudget({ requests: 5 }).limit).toBe(5)
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
