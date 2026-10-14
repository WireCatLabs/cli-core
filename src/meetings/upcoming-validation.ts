import { CliError } from "@wirecat/cli-base"
import type { MeetingOccurrenceSchedule } from "./upcoming-types.js"

const invalid = (field: string): never => {
  throw new CliError("invalid_response", `meeting occurrence ${field} is invalid`)
}

export const occurrenceTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000

export const occurrenceId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !/[\0\r\n]/.test(value)

export const readOccurrenceSchedule = (
  input: MeetingOccurrenceSchedule,
  meetingId: string,
  limit: number,
  maxReadBytes: number,
): MeetingOccurrenceSchedule => {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("schedule")
  for (const key of Object.keys(input))
    if (!["meetingId", "kind", "timezone", "occurrences", "complete", "missing"].includes(key)) invalid(key)
  if (input.meetingId !== meetingId) invalid("meetingId")
  if (!["single", "recurring", "unscheduled", "unknown"].includes(input.kind)) invalid("kind")
  if (input.timezone !== null) {
    if (typeof input.timezone !== "string" || input.timezone.length > 100) invalid("timezone")
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(0)
    } catch {
      invalid("timezone")
    }
  }
  if (typeof input.complete !== "boolean") invalid("complete")
  if (
    !Array.isArray(input.missing) ||
    input.missing.length > 2 ||
    new Set(input.missing).size !== input.missing.length ||
    input.missing.some((value) => !["schedule-details", "occurrence-details"].includes(value)) ||
    (input.complete && input.missing.length > 0)
  )
    invalid("missing")
  if (!Array.isArray(input.occurrences) || input.occurrences.length > limit) invalid("occurrences")
  if (input.kind === "single" && input.occurrences.length > 1) invalid("single occurrence count")
  const seen = new Set<string>()
  const occurrences = input.occurrences.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("entry")
    for (const key of Object.keys(entry))
      if (!["id", "startAt", "endAt", "status", "verified"].includes(key)) invalid(key)
    if (entry.id !== null && !occurrenceId(entry.id)) invalid("id")
    if (entry.startAt !== null && !occurrenceTime(entry.startAt)) invalid("startAt")
    if (
      entry.endAt !== null &&
      (!occurrenceTime(entry.endAt) || entry.startAt === null || entry.endAt <= entry.startAt)
    )
      invalid("endAt")
    if (!["scheduled", "cancelled"].includes(entry.status) || typeof entry.verified !== "boolean") invalid("status")
    if (
      entry.verified &&
      (entry.startAt === null ||
        !["single", "recurring"].includes(input.kind) ||
        (input.kind === "recurring" && entry.id === null))
    )
      invalid("verification")
    const key = entry.id ?? "single"
    if (seen.has(key)) invalid("duplicate id")
    seen.add(key)
    return { id: entry.id, startAt: entry.startAt, endAt: entry.endAt, status: entry.status, verified: entry.verified }
  })
  const result = {
    meetingId,
    kind: input.kind,
    timezone: input.timezone,
    occurrences,
    complete: input.complete,
    missing: [...input.missing],
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxReadBytes) invalid("maxReadBytes budget")
  return result
}
