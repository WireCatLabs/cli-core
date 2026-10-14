import { CliError } from "@wirecat/cli-base"
import { validateMeetingSeriesHistory } from "../meetings/index.js"
import type { MeetingPreparationRequest } from "./meeting-preparation-types.js"

export const preparationCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  throw new CliError(
    signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled",
    "Meeting preparation was interrupted",
  )
}
export const preparationRequest = (accountId: number, externalId: string, original: MeetingPreparationRequest) => {
  if (!original || typeof original !== "object" || Array.isArray(original))
    throw new CliError("validation_error", "meeting preparation request is required")
  const input = { ...original }
  for (const key of Object.keys(input))
    if (
      ![
        "after",
        "until",
        "historyAfter",
        "meetings",
        "cues",
        "contextLimit",
        "maxReadBytes",
        "bytes",
        "signal",
      ].includes(key)
    )
      throw new CliError("validation_error", `unknown preparation field: ${key}`)
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    throw new CliError("validation_error", "signal must be an AbortSignal")
  preparationCancelled(input.signal)
  const bounded = (value: number | undefined, fallback: number, max: number, name: string) => {
    const result = value === undefined ? fallback : value
    if (!Number.isSafeInteger(result) || result < 1 || result > max)
      throw new CliError("validation_error", `${name} must be an integer from 1 to ${max}`)
    return result
  }
  const meetings = bounded(input.meetings, 5, 20, "meetings")
  const cues = bounded(input.cues, 10, 100, "cues")
  const contextLimit = bounded(input.contextLimit, 20, 100, "contextLimit")
  const bytes = bounded(input.bytes, 65536, 4194304, "bytes")
  if (bytes < 4096) throw new CliError("validation_error", "bytes must be at least 4096")
  const history = validateMeetingSeriesHistory({
    accountId,
    externalId,
    after: input.historyAfter,
    before: input.after,
    limit: meetings,
    maxReadBytes: input.maxReadBytes,
    signal: input.signal,
  })
  if (!Number.isSafeInteger(input.until) || Math.abs(input.until) > 8640000000000000 || input.until <= input.after)
    throw new CliError("validation_error", "until must be an absolute timestamp later than after")
  preparationCancelled(input.signal)
  return { ...input, meetings, cues, contextLimit, bytes, maxReadBytes: history.maxReadBytes, history }
}
