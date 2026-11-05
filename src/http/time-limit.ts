export interface TimeLimit {
  signal: AbortSignal
  clear: () => void
}

/**
 * A time limit that can be stopped. `AbortSignal.timeout` cannot: its timer runs to the deadline even after the
 * request is done, and keeps the run's whole async context (everything the command loaded) alive until then.
 */
export const timeLimit = (ms: number): TimeLimit => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms)
  timer.unref()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/** Runs `run` under a time limit and stops the timer when it settles. Whatever `run` reads from the response belongs inside. */
export const withTimeLimit = async <T>(ms: number, run: (deadline: AbortSignal) => Promise<T>): Promise<T> => {
  const limit = timeLimit(ms)
  try {
    return await run(limit.signal)
  } finally {
    limit.clear()
  }
}
