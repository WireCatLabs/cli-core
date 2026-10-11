import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import { drainInvolvementQueue } from "./involvement-queue.js"

export function checkMeetingCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(
    timeout ? "timeout" : "cancelled",
    timeout ? "Meeting operation timed out" : "Meeting operation cancelled",
  )
}
export function meetingWriteSnapshot<T>(database: CacheDatabase, body: () => T, signal?: AbortSignal): T {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = body()
    drainInvolvementQueue(database)
    checkMeetingCancelled(signal)
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
