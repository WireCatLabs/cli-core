import { CliError } from "./errors.js"
import { realSleep, type SleepLike } from "./time.js"

export interface DeadlineOptions {
  timeoutMs?: number
  signal?: AbortSignal
  sleep?: SleepLike
}
export interface Deadline {
  readonly signal: AbortSignal
  /** On abort, waits for the body to settle before throwing; the body must cooperate to finish promptly. */
  race<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T>
  dispose(): void
}

export const createDeadline = ({ timeoutMs, signal, sleep = realSleep }: DeadlineOptions = {}): Deadline => {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647))
    throw new CliError("validation_error", "timeoutMs must be an integer from zero through 2147483647")
  const controller = new AbortController()
  const timer = new AbortController()
  let disposed = false
  const abort = (reason: CliError) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    timer.abort()
    signal?.removeEventListener("abort", onAbort)
  }
  const onAbort = () =>
    abort(signal?.reason instanceof CliError ? signal.reason : new CliError("cancelled", "command cancelled"))
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  const expire = () =>
    abort(
      new CliError("timeout", "the command did not finish before its deadline", {
        reason: "command_timeout",
        timeoutMs,
        retryable: false,
      }),
    )
  if (timeoutMs === 0) expire()
  if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
    let waiting: Promise<void>
    try {
      waiting = sleep(timeoutMs, timer.signal, "timeout")
    } catch {
      waiting = Promise.reject(new Error("deadline timer failed"))
    }
    void waiting.then(
      () => {
        if (!disposed && !timer.signal.aborted) expire()
      },
      () => {
        if (!disposed && !timer.signal.aborted)
          abort(new CliError("configuration_error", "command deadline timer failed"))
      },
    )
  }
  return {
    signal: controller.signal,
    async race(body) {
      if (disposed) throw new CliError("validation_error", "deadline is already disposed")
      if (controller.signal.aborted) throw controller.signal.reason
      let interrupt: () => void = () => {}
      const interrupted = new Promise<never>((_, reject) => {
        interrupt = () => reject(controller.signal.reason)
        controller.signal.addEventListener("abort", interrupt, { once: true })
      })
      const running = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return body(controller.signal)
      })
      try {
        return await Promise.race([running, interrupted])
      } catch (error) {
        if (controller.signal.aborted) {
          // A caller may close resources only after its operation can no longer use them.
          let settled: unknown
          await running.catch((reason: unknown) => {
            settled = reason
          })
          if (settled instanceof CliError && settled.code === "outcome_unknown") throw settled
          throw controller.signal.reason
        }
        throw error
      } finally {
        controller.signal.removeEventListener("abort", interrupt)
      }
    },
    dispose() {
      disposed = true
      timer.abort()
      signal?.removeEventListener("abort", onAbort)
    },
  }
}
