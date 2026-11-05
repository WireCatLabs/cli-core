import { afterEach, describe, expect, it, vi } from "vitest"
import { timeLimit, withTimeLimit } from "./time-limit.js"

afterEach(() => vi.useRealTimers())

describe("timeLimit", () => {
  it("aborts with a TimeoutError at the limit", () => {
    vi.useFakeTimers()
    const limit = timeLimit(1000)
    vi.advanceTimersByTime(999)
    expect(limit.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(limit.signal.reason).toMatchObject({ name: "TimeoutError" })
  })

  it("leaves no timer behind once cleared, and never aborts", () => {
    vi.useFakeTimers()
    const limit = timeLimit(1000)
    expect(vi.getTimerCount()).toBe(1)
    limit.clear()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(limit.signal.aborted).toBe(false)
  })
})

describe("withTimeLimit", () => {
  it("clears the timer when the work finishes or fails", async () => {
    vi.useFakeTimers()
    await withTimeLimit(1000, async () => "done")
    expect(vi.getTimerCount()).toBe(0)
    await expect(
      withTimeLimit(1000, async () => {
        throw new Error("failed")
      }),
    ).rejects.toThrow("failed")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("aborts work that outlasts the limit", async () => {
    vi.useFakeTimers()
    const work = withTimeLimit(
      1000,
      (deadline) =>
        new Promise((_, reject) => deadline.addEventListener("abort", () => reject(deadline.reason), { once: true })),
    )
    const outcome = expect(work).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(1000)
    await outcome
  })
})
