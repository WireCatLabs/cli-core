import { CliError } from "@wirecat/cli-base"
import { isoTime } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { validateMeetingChange } from "../meetings/index.js"
import {
  MEETING_PREPARATION_LIMITS,
  type MeetingPreparation,
  type MeetingPreparationRequest,
  validateMeetingPreparationRequest,
} from "../services/index.js"
import { meetingPreparationAnswer } from "./meeting-preparation-answer.js"

export type MeetingPreparationReader = (
  seriesId: string,
  request: MeetingPreparationRequest,
) => Promise<MeetingPreparation>
const bound = (name: keyof typeof MEETING_PREPARATION_LIMITS) => {
  const { min, max } = MEETING_PREPARATION_LIMITS[name]
  return v.optional(v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max)))
}
export const meetingPreparationInput = v.strictObject({
  series_id: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  after: v.optional(isoTime),
  until: v.optional(isoTime),
  history_after: v.optional(isoTime),
  meetings: bound("meetings"),
  cues: bound("cues"),
  context_limit: bound("contextLimit"),
  max_read_bytes: bound("maxReadBytes"),
  bytes: bound("bytes"),
})
const instant = (value: string | undefined, fallback: number, field: string) => {
  if (value === undefined) return fallback
  try {
    return Date.parse(validateMeetingChange({ startTime: value }, false).startTime as string)
  } catch {
    throw new CliError("validation_error", `${field} must be a valid ISO timestamp with a zone`)
  }
}
export const readMeetingPreparation = async (
  read: MeetingPreparationReader,
  input: unknown,
  signal?: AbortSignal,
  now = Date.now(),
) => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CliError("validation_error", "meeting preparation arguments are required")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== null && prototype !== Object.prototype)
    throw new CliError("validation_error", "meeting preparation arguments must be a plain object")
  for (const key of Object.keys(input))
    if (!Object.hasOwn(meetingPreparationInput.entries, key))
      throw new CliError("validation_error", `unknown preparation argument: ${key}`)
  const parsed = v.safeParse(meetingPreparationInput, input)
  if (!parsed.success) {
    const field = parsed.issues[0]?.path?.[0]?.key ?? "arguments"
    throw new CliError("validation_error", `invalid meeting preparation field: ${String(field)}`)
  }
  const args = parsed.output
  const after = instant(args.after, now, "after")
  const until = instant(args.until, after + 7 * 86400000, "until")
  const historyAfter = instant(args.history_after, after - 30 * 86400000, "history_after")
  const request = validateMeetingPreparationRequest(args.series_id, {
    after,
    until,
    historyAfter,
    meetings: args.meetings,
    cues: args.cues,
    contextLimit: args.context_limit,
    maxReadBytes: args.max_read_bytes,
    bytes: args.bytes,
    signal,
  })
  const packet = await read(args.series_id, request)
  if (signal?.aborted) {
    if (signal.reason instanceof CliError) throw signal.reason
    throw new CliError("cancelled", "Meeting preparation was interrupted")
  }
  if (
    packet.upcoming.meetingId !== args.series_id ||
    packet.upcoming.after !== request.after ||
    packet.upcoming.until !== request.until ||
    packet.historyWindow.after !== request.historyAfter ||
    packet.historyWindow.before !== request.after ||
    Object.keys(packet.limits).some(
      (key) => packet.limits[key as keyof typeof packet.limits] !== request[key as keyof typeof packet.limits],
    )
  )
    throw new CliError("invalid_response", "Meeting preparation reader returned another selection or limits")
  return meetingPreparationAnswer(packet)
}
