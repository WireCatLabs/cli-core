import { CliError } from "@wirecat/cli-base"
import { type MeetingProviderScope, snapshotMeetingScope } from "./provider.js"
import type {
  MeetingOccurrence,
  MeetingOccurrencePort,
  UpcomingMeetingRequest,
  UpcomingMeetingResult,
} from "./upcoming-types.js"
import { occurrenceId, occurrenceTime, readOccurrenceSchedule } from "./upcoming-validation.js"

const cancelled = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(timeout ? "timeout" : "cancelled", "meeting occurrence read was interrupted")
}

export const createUpcomingMeetingReader = (scope: MeetingProviderScope, port: MeetingOccurrencePort) => {
  const fixed = snapshotMeetingScope(scope)
  if (typeof port?.read !== "function")
    throw new CliError("configuration_error", "meeting occurrence reader is required")
  const read = port.read.bind(port)
  return {
    scope: fixed,
    async next(meetingId: string, request: UpcomingMeetingRequest): Promise<UpcomingMeetingResult> {
      if (!occurrenceId(meetingId)) throw new CliError("validation_error", "meetingId must be a bounded identifier")
      if (!request || typeof request !== "object" || Array.isArray(request))
        throw new CliError("validation_error", "meeting occurrence request is required")
      for (const key of Object.keys(request))
        if (!["after", "until", "limit", "maxReadBytes", "signal"].includes(key))
          throw new CliError("validation_error", `unknown meeting occurrence field: ${key}`)
      const { after, until, signal } = request
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new CliError("validation_error", "signal must be an AbortSignal")
      if (!occurrenceTime(after) || !occurrenceTime(until) || after >= until)
        throw new CliError("validation_error", "after and until must form an increasing absolute millisecond window")
      const limit = request.limit ?? 100
      const maxReadBytes = request.maxReadBytes ?? 1_048_576
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new CliError("validation_error", "limit must be an integer from 1 to 1000")
      if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 4_194_304)
        throw new CliError("validation_error", "maxReadBytes must be an integer from 1 to 4194304")
      cancelled(signal)
      const context = Object.freeze({ scope: fixed, after, until, limit, maxReadBytes, ...(signal ? { signal } : {}) })
      const raw = await read(meetingId, context)
      cancelled(signal)
      const schedule = readOccurrenceSchedule(raw, meetingId, limit, maxReadBytes)
      const active = schedule.occurrences.filter((entry) => entry.status !== "cancelled")
      const eligible = active.filter(
        (entry): entry is MeetingOccurrence & { startAt: number } =>
          entry.startAt !== null && entry.startAt >= after && entry.startAt < until,
      )
      eligible.sort((a, b) => a.startAt - b.startAt || ((a.id ?? "") < (b.id ?? "") ? -1 : 1))
      const candidate = eligible[0] ?? null
      const undated = active.filter((entry) => entry.startAt === null).length
      const unverified = active.filter((entry) => !entry.verified).length
      const tied = candidate !== null && eligible.filter((entry) => entry.startAt === candidate.startAt).length > 1
      return {
        scope: fixed,
        meetingId,
        after,
        until,
        timezone: schedule.timezone,
        candidate,
        verifiedNext: Boolean(candidate?.verified && schedule.complete && unverified === 0 && !tied),
        coverage: {
          scheduleComplete: schedule.complete,
          inspected: schedule.occurrences.length,
          undated,
          unverified,
          cancelled: schedule.occurrences.length - active.length,
          missing: schedule.missing,
        },
      }
    },
  }
}
