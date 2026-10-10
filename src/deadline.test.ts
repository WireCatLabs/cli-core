import { describe, expect, it, vi } from "vitest"
import { createDeadline } from "./deadline.js"
import { CliError } from "./errors.js"
import type { SleepLike } from "./time.js"

const timerFixture = () => {
  let fire: () => void = () => {}
  let timerSignal: AbortSignal | undefined
  const sleep: SleepLike = vi.fn((_ms, signal) => {
    timerSignal = signal
    return new Promise<void>((resolve, reject) => {
      fire = resolve
      signal?.addEventListener("abort", () => reject(new Error("Timer disposed")), { once: true })
    })
  })
  return {
    sleep,
    fire: () => fire(),
    get signal() {
      return timerSignal
    },
  }
}

describe("portable command deadlines", () => {
  it("uses no deadline by default and cleans timers/listeners after successful work", async () => {
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, "removeEventListener")
    const timer = timerFixture()
    const noTimer = createDeadline({ sleep: timer.sleep })
    expect(await noTimer.race(async () => "Example")).toBe("Example")
    expect(timer.sleep).not.toHaveBeenCalled()
    noTimer.dispose()
    const deadline = createDeadline({ timeoutMs: 500, signal: parent.signal, sleep: timer.sleep })
    expect(
      await deadline.race(async (signal) => {
        expect(signal.aborted).toBe(false)
        return 3
      }),
    ).toBe(3)
    deadline.dispose()
    expect(timer.signal?.aborted).toBe(true)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    parent.abort()
    timer.fire()
    await Promise.resolve()
    expect(deadline.signal.aborted).toBe(false)
    await expect(deadline.race(async () => 3)).rejects.toThrow(/disposed/)
  })
  it("signals timeout but waits for body cleanup before allowing resource close", async () => {
    const timer = timerFixture()
    const deadline = createDeadline({ timeoutMs: 20, sleep: timer.sleep })
    let start: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let finish: () => void = () => {}
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve
    })
    let aborted = false
    let settled = false
    const running = deadline
      .race(async (signal) => {
        start()
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true },
        )
        await cleanup
        return "Example"
      })
      .finally(() => {
        settled = true
      })
    await started
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(aborted).toBe(true)
    expect(settled).toBe(false)
    finish()
    await expect(running).rejects.toMatchObject({
      code: "timeout",
      details: { reason: "command_timeout", timeoutMs: 20 },
    })
    expect(timer.sleep).toHaveBeenCalledWith(20, expect.any(AbortSignal), "timeout")
    deadline.dispose()
  })
  it("cancels from parent signals, rejects already aborted input before calling body, and removes race listeners", async () => {
    for (const reason of [
      undefined,
      new Error("Untrusted example detail"),
      new CliError("cancelled", "Example cancellation"),
    ]) {
      const parent = new AbortController()
      parent.abort(reason)
      const body = vi.fn(async () => 3)
      const deadline = createDeadline({ signal: parent.signal })
      await expect(deadline.race(body)).rejects.toMatchObject({ code: "cancelled" })
      expect(body).not.toHaveBeenCalled()
      deadline.dispose()
    }
    const parent = new AbortController()
    const deadline = createDeadline({ signal: parent.signal })
    const remove = vi.spyOn(deadline.signal, "removeEventListener")
    await expect(
      deadline.race(async () => {
        parent.abort()
        throw new Error("Example aborted operation")
      }),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    deadline.dispose()
  })
  it("preserves body errors and a body's more precise unknown-write outcome after interruption", async () => {
    const deadline = createDeadline()
    const error = new Error("Example operation failed")
    await expect(
      deadline.race(async () => {
        throw error
      }),
    ).rejects.toBe(error)
    deadline.dispose()
    const parent = new AbortController()
    const interrupted = createDeadline({ signal: parent.signal })
    const unknown = new CliError("outcome_unknown", "Example write outcome unknown")
    await expect(
      interrupted.race(async () => {
        parent.abort()
        throw unknown
      }),
    ).rejects.toBe(unknown)
    interrupted.dispose()
  })
  it("validates timer bounds and safely reports an injected timer failure", async () => {
    for (const timeoutMs of [-1, 0.5, Infinity, 2147483648])
      expect(() => createDeadline({ timeoutMs })).toThrow(/timeoutMs/)
    const deadline = createDeadline({
      timeoutMs: 0,
      sleep: async () => {
        throw new Error("Untrusted timer detail")
      },
    })
    await Promise.resolve()
    await expect(deadline.race(async () => 3)).rejects.toMatchObject({
      code: "configuration_error",
      message: "command deadline timer failed",
    })
    deadline.dispose()
  })
})

it("cleans parent cancellation after a synchronous injected timer failure", async () => {
  const parent = new AbortController()
  const remove = vi.spyOn(parent.signal, "removeEventListener")
  const deadline = createDeadline({
    signal: parent.signal,
    timeoutMs: 1,
    sleep: () => {
      throw new Error("Example timer failed")
    },
  })
  await Promise.resolve()
  await expect(deadline.race(async () => 3)).rejects.toMatchObject({ code: "configuration_error" })
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  deadline.dispose()
})

it("never starts a body when cancellation arrives before its scheduled invocation", async () => {
  const parent = new AbortController()
  const deadline = createDeadline({ signal: parent.signal })
  const body = vi.fn(async () => 3)
  const running = deadline.race(body)
  parent.abort()
  await expect(running).rejects.toMatchObject({ code: "cancelled" })
  expect(body).not.toHaveBeenCalled()
  deadline.dispose()
})
