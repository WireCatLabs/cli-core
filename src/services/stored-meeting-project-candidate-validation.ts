import { CliError } from "@wirecat/cli-base"
import { formatMeetingReference, parseMeetingReference } from "../meetings/index.js"
import type { StoredMeetingProjectCandidateOptions } from "./stored-meeting-project-candidate-types.js"

export const storedCandidateRequest = (
  reference: string,
  accountId: number,
  options: StoredMeetingProjectCandidateOptions,
) => {
  const invalid = (field: string): never => {
    throw new CliError("validation_error", `invalid stored project candidate ${field}`)
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid("options")
  const allowed = ["limit", "cues", "bytes", "maxReadBytes", "after", "afterTranscriptId", "signal"]
  for (const key of Object.keys(options)) if (!allowed.includes(key)) invalid(key)
  if (typeof reference !== "string" || reference.length > 200) invalid("reference")
  const parsed = parseMeetingReference(reference)
  if (
    parsed.accountId !== accountId ||
    parsed.transcriptId !== undefined ||
    formatMeetingReference(parsed) !== reference
  )
    invalid("reference")
  const limits = {
    limit: options.limit ?? 10,
    cues: options.cues ?? 20,
    bytes: options.bytes ?? 16384,
    maxReadBytes: options.maxReadBytes ?? 65536,
  }
  for (const [key, value] of Object.entries(limits)) {
    const max = key === "limit" ? 10 : key === "cues" ? 100 : 65536
    if (!Number.isSafeInteger(value) || value < (key === "bytes" ? 2048 : 1) || value > max) invalid(key)
  }
  const { after, afterTranscriptId, signal } = options
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid("signal")
  if (after !== undefined) {
    if (typeof after !== "string" || after.length > 200) invalid("after")
    const cursor = parseMeetingReference(after)
    if (
      cursor.accountId !== accountId ||
      cursor.meetingId !== parsed.meetingId ||
      cursor.cuePosition === undefined ||
      formatMeetingReference(cursor) !== after
    )
      invalid("after")
  }
  if (
    afterTranscriptId !== undefined &&
    (!Number.isSafeInteger(afterTranscriptId) || afterTranscriptId < 1 || after !== undefined)
  )
    invalid("afterTranscriptId")
  return { reference, limits, after, afterTranscriptId, signal }
}
