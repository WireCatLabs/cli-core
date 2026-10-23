import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"

export const preparationId = v.pipe(v.string(), v.minLength(1))
export const preparationCount = v.pipe(v.number(), v.integer(), v.minValue(0))
export const preparationTime = v.nullable(isoTime)
const text = v.nullable(v.string())
const id = preparationId
const count = preparationCount
const page = <T extends v.GenericSchema>(item: T) => v.strictObject({ items: v.array(item), has_more: v.boolean() })

export const preparationUpcoming = v.strictObject({
  scope: v.strictObject({ provider: id, account: id }),
  meeting_id: id,
  kind: v.picklist(["single", "recurring", "unscheduled", "unknown"]),
  after: isoTime,
  until: isoTime,
  timezone: text,
  verified_next: v.boolean(),
  candidate: v.nullable(
    v.strictObject({
      id: text,
      start_at: preparationTime,
      end_at: preparationTime,
      status: v.picklist(["scheduled", "cancelled"]),
      verified: v.boolean(),
    }),
  ),
  coverage: v.strictObject({
    schedule_complete: v.boolean(),
    inspected: count,
    undated: count,
    unverified: count,
    cancelled: count,
    simultaneous: count,
    missing: v.array(v.picklist(["schedule-details", "occurrence-details"])),
  }),
})
/** One stored transcript line as evidence: where it is, who said it, and its text. */
export const preparationCue = v.strictObject({
  ref: reference,
  fingerprint: id,
  transcript_id: id,
  content_hash: text,
  position: count,
  offset_ms: count,
  end_ms: count,
  speaker_participant_id: v.nullable(id),
  speaker_name: text,
  text: v.string(),
  revision: v.picklist(["current", "superseded"]),
})
export const preparationEvidence = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting"),
  source: reference,
  fingerprint: id,
  limits: v.strictObject({ cues: count, bytes: count, max_read_bytes: count, max_transcript_pages: count }),
  content_bytes: count,
  coverage: v.strictObject({
    provided: count,
    included: count,
    omitted: v.nullable(count),
    provided_exact: v.boolean(),
    next_transcript_id: v.nullable(id),
    next_reference: v.nullable(reference),
    transcript_pages: count,
    skipped_unavailable: count,
    has_more: v.boolean(),
    truncated_by: v.nullable(v.picklist(["cues", "bytes", "transcripts"])),
    input: v.literal("bounded-meeting-pages"),
    archive_completeness: v.literal("unknown"),
  }),
  items: v.array(preparationCue),
})
export const preparationContext = v.strictObject({
  participants: page(v.strictObject({ id, identity_id: id, display_name: text, person_uid: v.nullable(id) })),
  projects: page(v.strictObject({ ref: reference, key: id, name: v.string(), link_id: id })),
  facts: page(v.strictObject({ ref: reference, type: id, statement: v.string(), updated_at: isoTime })),
  tasks: page(
    v.strictObject({
      ref: reference,
      key: id,
      title: v.string(),
      status: id,
      priority: v.nullable(count),
      source: v.nullable(reference),
    }),
  ),
})

export const preparationMeeting = v.strictObject({
  id,
  external_id: id,
  title: text,
  event_id: v.nullable(id),
  started_at: preparationTime,
  ended_at: preparationTime,
  updated_at: isoTime,
})
