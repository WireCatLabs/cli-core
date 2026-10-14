import { CliError } from "@wirecat/cli-base"

export function checkMeetingCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(
    timeout ? "timeout" : "cancelled",
    timeout ? "Meeting operation timed out" : "Meeting operation cancelled",
  )
}
