import { CliError } from "@wirecat/cli-base"
import { communicationRequest } from "../context/communication-selection.js"
import { validateMeetingSeriesHistory } from "../meetings/index.js"
import type { MeetingPreparationRequest } from "./meeting-preparation-types.js"

export const MEETING_PREPARATION_LIMITS = {
  meetings: { min: 1, max: 20, default: 5 },
  cues: { min: 1, max: 100, default: 10 },
  contextLimit: { min: 1, max: 100, default: 20 },
  bytes: { min: 4096, max: 4194304, default: 65536 },
  maxReadBytes: { min: 1, max: 4194304, default: 262144 },
} as const

export const preparationCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  throw new CliError(
    signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled",
    "Meeting preparation was interrupted",
  )
}
export const validateMeetingPreparationRequest = (externalId: string, original: MeetingPreparationRequest) => {
  if (!original || typeof original !== "object" || Array.isArray(original))
    throw new CliError("validation_error", "meeting preparation request is required")
  const input = { ...original }
  for (const key of Object.keys(input))
    if (
      ![
        "project",
        "communications",
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
  const bounded = (key: keyof typeof MEETING_PREPARATION_LIMITS) => {
    const limits = MEETING_PREPARATION_LIMITS[key]
    const result = input[key] === undefined ? limits.default : input[key]
    if (!Number.isSafeInteger(result) || result < limits.min || result > limits.max)
      throw new CliError("validation_error", `${key} must be an integer from ${limits.min} to ${limits.max}`)
    return result
  }
  if (
    input.project !== undefined &&
    (typeof input.project !== "string" ||
      !input.project.trim() ||
      input.project.length > 200 ||
      /[\p{Cc}\p{Cf}]/u.test(input.project))
  )
    throw new CliError("validation_error", "project must name one existing project, key or alias")
  const meetings = bounded("meetings")
  const cues = bounded("cues")
  const contextLimit = bounded("contextLimit")
  const bytes = bounded("bytes")
  if (typeof externalId !== "string" || !externalId.trim() || externalId.length > 1000 || /[\0\r\n]/.test(externalId))
    throw new CliError("validation_error", "series_id must be a bounded nonempty identifier")
  for (const key of ["after", "historyAfter"] as const)
    if (!Number.isSafeInteger(input[key]) || Math.abs(input[key]) > 8640000000000000)
      throw new CliError("validation_error", `${key} must be an absolute timestamp`)
  if (input.historyAfter >= input.after)
    throw new CliError("validation_error", "historyAfter must be earlier than after")
  const maxReadBytes = bounded("maxReadBytes")
  if (!Number.isSafeInteger(input.until) || Math.abs(input.until) > 8640000000000000 || input.until <= input.after)
    throw new CliError("validation_error", "until must be an absolute timestamp later than after")
  const communications =
    input.communications === undefined ? undefined : communicationRequest(input.communications, input.after)
  preparationCancelled(input.signal)
  return {
    ...input,
    ...(communications === undefined ? {} : { communications }),
    meetings,
    cues,
    contextLimit,
    bytes,
    maxReadBytes,
  }
}

export const preparationRequest = (accountId: number, externalId: string, original: MeetingPreparationRequest) => {
  const input = validateMeetingPreparationRequest(externalId, original)
  const history = validateMeetingSeriesHistory({
    accountId,
    externalId,
    after: input.historyAfter,
    before: input.after,
    limit: input.meetings,
    maxReadBytes: input.maxReadBytes,
    signal: input.signal,
  })
  return { ...input, history }
}
