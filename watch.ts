import type { RunReport } from "./pull.js"
import { MeetingError } from "./reads.js"

export type WatchSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>
export interface WatchOptions {
  signal: AbortSignal
  intervalMs: number
  sleep?: WatchSleep
}
const sleep: WatchSleep = (milliseconds, signal) =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })
const isCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
    return error.code === "cancelled" || error.code === "timeout" || error.code === "ABORT_ERR"
  return (
    error === signal.reason ||
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"))
  )
}
export async function* watchMeetingIngestion(
  ingest: (signal: AbortSignal) => Promise<RunReport>,
  options: WatchOptions,
): AsyncGenerator<RunReport, void, void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1000 || options.intervalMs > 86400000)
    throw new MeetingError("validation_error", "watch interval must be an integer from 1000 to 86400000 milliseconds")
  const wait = options.sleep ?? sleep
  while (!options.signal.aborted) {
    let report: RunReport
    try {
      report = await ingest(options.signal)
    } catch (error) {
      if (isCancellation(error, options.signal)) return
      throw error
    }
    // A completed write keeps its receipt even if cancellation arrived while it finished.
    yield report
    if (options.signal.aborted) return
    try {
      await wait(options.intervalMs, options.signal)
    } catch (error) {
      if (isCancellation(error, options.signal)) return
      throw error
    }
  }
}
