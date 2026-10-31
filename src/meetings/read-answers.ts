import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { MeetingLink } from "./links.js"
import type { Event } from "./model.js"
import { formatMeetingReference } from "./reference.js"
import type { MeetingReviewItem } from "./review.js"
import type { MeetingSpeakerStats, MeetingStats } from "./stats.js"

const text = v.string()
const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const id = v.pipe(v.number(), v.integer(), v.minValue(1))
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const meetingRef = (accountId: number, meetingId: number) =>
  formatMeetingReference({ type: "meeting", accountId, meetingId })

/** One meeting in `review`: what the store holds about it, never transcript text. */
export const meetingReview = v.strictObject({
  ref: reference,
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.nullable(text),
  started_at: v.nullable(isoTime),
  duration_ms: v.nullable(count),
  participants_count: v.nullable(count),
  projects: v.array(text),
  /** Null when the meeting has no current transcript. */
  transcript: v.nullable(v.strictObject({ lines: count, words: count })),
  /** The three who talked longest. */
  speakers: v.array(v.strictObject({ name: v.nullable(text), talk_ms: count })),
  /** The newest stored summary; null when there is none. */
  summary: v.nullable(
    v.strictObject({
      source: text,
      title: v.nullable(text),
      overview: v.nullable(text),
      next_steps: v.array(text),
      url: v.nullable(text),
    }),
  ),
})

export const meetingReviewItem = (one: MeetingReviewItem): v.InferOutput<typeof meetingReview> => ({
  ref: meetingRef(one.accountId, one.meetingId),
  id: String(one.meetingId),
  title: one.title,
  started_at: iso(one.startedAt),
  duration_ms: one.durationMs,
  participants_count: one.participantsCount,
  projects: one.projects,
  transcript: one.transcript,
  speakers: one.speakers.map((speaker) => ({ name: speaker.name, talk_ms: speaker.talkMs })),
  summary: one.summary && {
    source: one.summary.source,
    title: one.summary.title,
    overview: one.summary.overview,
    next_steps: one.summary.nextSteps,
    url: one.summary.url,
  },
})

/** A link shared in meeting chat, with where and how often; `mentions list` answers these. */
export const meetingLink = v.strictObject({
  url: text,
  domain: v.nullable(text),
  /** The Google Docs, Sheets, Slides, Forms or Drive file it names. */
  document_id: v.nullable(text),
  count,
  first_at: isoTime,
  last_at: isoTime,
  senders: v.array(text),
  meetings: v.array(v.strictObject({ ref: reference, title: v.nullable(text) })),
})

export const meetingLinkItem = (link: MeetingLink): v.InferOutput<typeof meetingLink> => ({
  url: link.url,
  domain: link.domain,
  document_id: link.documentId,
  count: link.count,
  first_at: new Date(link.firstAt).toISOString(),
  last_at: new Date(link.lastAt).toISOString(),
  senders: link.senders,
  meetings: link.meetings.map((one) => ({ ref: meetingRef(one.accountId, one.meetingId), title: one.title })),
})

/** One speaker's talk over the selected meetings; `stats meetings top` answers these. */
export const meetingSpeaker = v.strictObject({
  /** `person:<id>`, `identity:<id>`, `name:<lowercased name>` or `unknown`. */
  key: text,
  name: v.nullable(text),
  person_id: v.nullable(id),
  identity_id: v.nullable(id),
  meetings: count,
  lines: count,
  words: count,
  talk_ms: count,
  /** This speaker's part of all talk time, 0–1. */
  share: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
})

export const meetingSpeakerItem = (one: MeetingSpeakerStats): v.InferOutput<typeof meetingSpeaker> => ({
  key: one.key,
  name: one.name,
  person_id: one.personId,
  identity_id: one.identityId,
  meetings: one.meetings,
  lines: one.lines,
  words: one.words,
  talk_ms: one.talkMs,
  share: one.share,
})

/** `stats meetings show`: how much was said over the selected meetings, by week, with the top speakers. */
export const meetingStats = v.strictObject({
  time_zone: text,
  meetings: count,
  lines: count,
  words: count,
  talk_ms: count,
  /** `week_start` is the Monday, as a date in `time_zone`. */
  weeks: v.array(v.strictObject({ week_start: text, meetings: count, talk_ms: count })),
  top_speakers: v.array(meetingSpeaker),
})

export const meetingStatsItem = (found: MeetingStats, top = 10): v.InferOutput<typeof meetingStats> => ({
  time_zone: found.timeZone,
  meetings: found.meetings,
  lines: found.lines,
  words: found.words,
  talk_ms: found.talkMs,
  weeks: found.weeks.map((week) => ({ week_start: week.weekStart, meetings: week.meetings, talk_ms: week.talkMs })),
  top_speakers: found.speakers.slice(0, top).map(meetingSpeakerItem),
})

const truncated = <T extends string>(...why: T[]) => v.nullable(v.picklist(why))

/** `meetings people`: one page of participant observations whose name or email matches. */
export const meetingParticipants = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting_participants"),
  account_id: id,
  query: text,
  items: v.array(
    v.strictObject({
      participant_id: id,
      meeting_id: id,
      identity_id: id,
      display_name: v.nullable(text),
      email: v.nullable(text),
    }),
  ),
  /** Several identities on one page are observations, never speaker attribution or person links. */
  ambiguity: v.strictObject({ scope: v.literal("page"), multiple_identities: v.boolean(), identity_ids: v.array(id) }),
  coverage: v.strictObject({
    scanned: count,
    read_bytes: count,
    archive_completeness: v.literal("unknown"),
    truncated_by: truncated("limit", "scan_limit", "read_bytes"),
  }),
  page: v.strictObject({
    mode: v.literal("cursor"),
    limit: count,
    has_more: v.boolean(),
    next_cursor: v.optional(text),
  }),
})

const revision = v.picklist(["current", "superseded"])

/** `meetings passage`: a transcript line with the lines around it. */
export const meetingPassage = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting_context"),
  source: reference,
  target_ref: reference,
  target_fingerprint: text,
  fingerprint: text,
  revision,
  limits: v.strictObject({ before: count, after: count, bytes: count, max_read_bytes: count }),
  content_bytes: count,
  coverage: v.strictObject({
    included: count,
    before: count,
    after: count,
    has_before: v.boolean(),
    has_after: v.boolean(),
    truncated_by: truncated("bytes"),
    before_ref: v.nullable(reference),
    after_ref: v.nullable(reference),
    continuation: v.literal("anchor-inclusive"),
    archive_completeness: v.literal("unknown"),
    input: v.literal("bounded-meeting-context"),
  }),
  items: v.array(
    v.strictObject({
      ref: reference,
      fingerprint: text,
      transcript_id: id,
      content_hash: v.nullable(text),
      position: count,
      start_ms: count,
      end_ms: count,
      speaker_participant_id: v.nullable(id),
      speaker_name: v.nullable(text),
      text,
      revision,
    }),
  ),
})

/** A stored event a meeting belongs to; `id` is what `meetings update --event-id` takes. */
export const event = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  event_series_id: v.nullable(text),
  title: v.nullable(text),
  description: v.nullable(text),
  location: v.nullable(text),
  starts_at: v.nullable(isoTime),
  ends_at: v.nullable(isoTime),
  timezone: v.nullable(text),
  /** `auto`: made from a meeting; `owner`: made by hand; `calendar`: from a calendar's entries. */
  origin: v.picklist(["auto", "owner", "calendar"]),
  status: v.nullable(text),
  all_day: v.boolean(),
  /** When its calendar deleted it: shown as "deleted in Google", kept as history. */
  source_deleted_at: v.nullable(isoTime),
  deleted_at: v.nullable(isoTime),
  created_at: isoTime,
  updated_at: isoTime,
  /** The fields whoever sent the invitation wrote, on a calendar CLI's `events list`: an agent reads them as data. */
  untrusted: v.optional(v.array(text)),
  /** On a calendar CLI's `events list changed:<date>`: what changed since then, and when the store saw it. */
  change: v.optional(v.picklist(["new", "moved", "cancelled"])),
  changed_at: v.optional(v.nullable(isoTime)),
  /** The times a moved event had at that date. */
  was: v.optional(v.strictObject({ starts_at: v.nullable(isoTime), ends_at: v.nullable(isoTime) })),
  /** On a calendar CLI's `events list overlapping`: the events it clashes with, as `event:<id>`. */
  overlaps: v.optional(v.array(text)),
})

export const eventItem = (one: Event): v.InferOutput<typeof event> => ({
  id: String(one.id),
  event_series_id: one.eventSeriesId === null ? null : String(one.eventSeriesId),
  title: one.title,
  description: one.description,
  location: one.location,
  starts_at: iso(one.startsAt),
  ends_at: iso(one.endsAt),
  timezone: one.timezone,
  origin: one.origin,
  status: one.status ?? null,
  all_day: one.allDay === true,
  source_deleted_at: iso(one.sourceDeletedAt ?? null),
  deleted_at: iso(one.deletedAt),
  created_at: new Date(one.createdAt).toISOString(),
  updated_at: new Date(one.updatedAt).toISOString(),
})
