import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { Meeting } from "./model.js"
import { formatMeetingReference } from "./reference.js"

const text = v.string()
const count = v.pipe(v.number(), v.integer(), v.minValue(0))

/**
 * Why a stored meeting's facts may be off, kept so the data stays but a reader knows to doubt it.
 * `time_without_zone`: the provider sent a time with no zone, and it was read in the computer's zone.
 */
export const MEETING_ISSUES = ["time_without_zone"] as const
export type MeetingIssue = (typeof MEETING_ISSUES)[number]

/** The issues a provider adapter put in `metadata.issues`, the known ones only, in their listed order. */
export const meetingIssuesOf = (metadata: Meeting["metadata"]): MeetingIssue[] => {
  const listed = metadata?.issues
  return Array.isArray(listed) ? MEETING_ISSUES.filter((issue) => listed.includes(issue)) : []
}

/** A stored meeting as every command and tool answers it; `src/entities/` registers it as `meeting`. */
export const meeting = v.strictObject({
  ref: reference,
  id: v.pipe(v.string(), v.minLength(1)),
  provider: text,
  account: text,
  title: v.nullable(text),
  description: v.optional(v.nullable(text)),
  location: v.optional(v.nullable(text)),
  /** The link that joins it. */
  url: v.nullable(text),
  started_at: v.nullable(isoTime),
  ended_at: v.nullable(isoTime),
  duration_ms: v.nullable(count),
  timezone: v.optional(v.nullable(text)),
  participants_count: v.nullable(count),
  /** Present only when something about this meeting is doubtful. */
  issues: v.optional(v.array(v.picklist(MEETING_ISSUES))),
  created_at: isoTime,
  updated_at: isoTime,
})

export type MeetingItem = v.InferOutput<typeof meeting>

/** Which provider and account a stored meeting account is, as `MeetingStore.account` answers it. */
export interface MeetingOwner {
  provider: string
  account: string
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export const meetingItem = (row: Meeting, owner: MeetingOwner): MeetingItem => {
  const issues = meetingIssuesOf(row.metadata)
  return {
    ref: formatMeetingReference({ type: "meeting", accountId: row.accountId, meetingId: row.id }),
    id: String(row.id),
    provider: owner.provider,
    account: owner.account,
    title: row.title,
    description: row.description,
    location: row.location,
    url: row.joinUrl,
    started_at: iso(row.startedAt),
    ended_at: iso(row.endedAt),
    duration_ms: row.durationMs,
    timezone: row.timezone,
    participants_count: row.participantsCount,
    ...(issues.length ? { issues } : {}),
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  }
}

/** `meetings list` fields: what the meetings table holds of the meeting itself. */
export const MEETING_QUERY = {
  entity: "meeting",
  backend: "sql",
  fields: queryFieldsOf(meeting, {
    exclude: ["ref", "provider", "account", "description", "location", "url", "timezone", "issues"],
    examples: {
      id: "id:12",
      title: "title:*standup*",
      started_at: "started_at:[2026-10-01 TO 2026-10-31]",
      duration_ms: "duration_ms>=3600000",
      participants_count: "participants_count>5",
    },
  }),
} as const satisfies QueryRegistry
