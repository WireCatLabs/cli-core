import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { CALL_DIRECTIONS, type CallDirection, type Meeting } from "./model.js"
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

export interface MeetingCallItem {
  direction: CallDirection | null
  /** The participant who took or made the call for the owner, and their person once linked. */
  manager: { name: string | null; person: string | null } | null
  /** The other side's number, as the source wrote it. */
  client_phone: string | null
}

// Typed by name: inferred, every entity map that holds a meeting grows too long for the compiler.
/** A phone call's fields, which a phone-line source sets; a meeting has none. */
export const meetingCall: v.GenericSchema<MeetingCallItem> = v.strictObject({
  direction: v.nullable(v.picklist(CALL_DIRECTIONS)),
  manager: v.nullable(v.strictObject({ name: v.nullable(text), person: v.nullable(reference) })),
  client_phone: v.nullable(text),
})

/** A call's fields as answers give them; `undefined` for a meeting, so its answer has no `call`. */
export const meetingCallItem = (
  row: Pick<Meeting, "direction" | "clientPhone" | "manager">,
): MeetingCallItem | undefined =>
  row.direction == null && row.clientPhone == null
    ? undefined
    : { direction: row.direction ?? null, manager: row.manager ?? null, client_phone: row.clientPhone ?? null }

const meetingEntries = {
  ref: reference,
  id: v.pipe(v.string(), v.minLength(1)),
  /** The service's own id of this occurrence: what `meetings show` takes besides the store number. */
  provider_id: text,
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
  /** Present only on a phone call. */
  call: v.optional(meetingCall),
  /** Present only when something about this meeting is doubtful. */
  issues: v.optional(v.array(v.picklist(MEETING_ISSUES))),
  /**
   * Where a read that asked the service found it, as messages search says it: `archive` (only the store), `server`
   * (new from the service), `both`. Absent when the service was not asked.
   */
  found_in: v.optional(v.picklist(["archive", "server", "both"])),
  /** The service's text, which a reader must not follow as instructions. */
  untrusted: v.optional(v.array(text)),
  created_at: isoTime,
  updated_at: isoTime,
}
type MeetingEntriesOf = typeof meetingEntries
// Named, so the entity registry's declaration refers to it instead of spelling every field out again (TS7056).
export interface MeetingEntries extends MeetingEntriesOf {}

/** A stored meeting as every command and tool answers it; `src/entities/` registers it as `meeting`. */
export const meeting: v.StrictObjectSchema<MeetingEntries, undefined> = v.strictObject(meetingEntries)

export type MeetingItem = v.InferOutput<typeof meeting>

/** Which provider and account a stored meeting account is, as `MeetingStore.account` answers it. */
export interface MeetingOwner {
  provider: string
  account: string
}

const MEETING_UNTRUSTED = ["title", "description", "location"] as const

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export const meetingItem = (row: Meeting, owner: MeetingOwner): MeetingItem => {
  const issues = meetingIssuesOf(row.metadata)
  const call = meetingCallItem(row)
  return {
    ref: formatMeetingReference({ type: "meeting", accountId: row.accountId, meetingId: row.id }),
    id: String(row.id),
    provider_id: row.externalId,
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
    ...(call ? { call } : {}),
    ...(issues.length ? { issues } : {}),
    untrusted: [...MEETING_UNTRUSTED],
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  }
}

/** `meetings list` fields: what the meetings table holds of the meeting itself. */
export const MEETING_QUERY = {
  entity: "meeting",
  backend: "sql",
  fields: queryFieldsOf(meeting, {
    exclude: [
      "ref",
      "provider",
      "account",
      "description",
      "location",
      "url",
      "timezone",
      "issues",
      "found_in",
      "untrusted",
    ],
    examples: {
      id: "id:12",
      provider_id: "provider_id:85746065432",
      title: "title:*standup*",
      started_at: "started_at:[2026-10-01 TO 2026-10-31]",
      duration_ms: "duration_ms>=3600000",
      participants_count: "participants_count>5",
    },
  }),
} as const satisfies QueryRegistry
