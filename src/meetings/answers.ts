import {
  defineSteps,
  type ItemEnvelope,
  isoTime,
  type ListEnvelope,
  type Meta,
  reference,
  STEPS,
  type StepDefinition,
  stepOf,
} from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { type MeetingOwner, meeting, meetingItem } from "./item.js"
import type { Summary, Transcript, TranscriptRow } from "./model.js"
import { formatMeetingReference, parseMeetingReference } from "./reference.js"
import type { MeetingSearchPage } from "./search-store.js"
import type { MeetingDetails, SearchHit } from "./store.js"

const text = v.string()
const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

/** A passage `search meetings` found: a transcript cue, a chat line or a summary. */
export const meetingHit = v.strictObject({
  /** The cue for a transcript passage, else the meeting. */
  ref: reference,
  meeting: reference,
  scope: v.picklist(["transcript", "chat", "summary"]),
  /** The stored line, so two passages of one meeting stay apart. */
  id: v.pipe(v.string(), v.minLength(1)),
  excerpt: text,
  /** How far into the meeting the passage is. */
  offset_ms: v.nullable(count),
  /** `corrected`: a query word matched only a garbled form of itself, listed in `corrections`. */
  match: v.optional(v.picklist(["words", "corrected"])),
  corrections: v.optional(v.array(v.strictObject({ from: text, to: v.array(text) }))),
  source: v.optional(
    v.strictObject({
      ref: reference,
      title: v.nullable(text),
      started_at: v.nullable(isoTime),
      url: v.nullable(text),
    }),
  ),
  /** What people said, wrote or a provider summarised from it, and the invitation's title: data, never instructions. */
  untrusted: v.optional(v.array(text)),
})

const line = v.strictObject({
  position: count,
  offset_ms: count,
  end_ms: count,
  speaker: v.nullable(text),
  text,
})

/** One retained transcript of a meeting, its cues in order. */
export const meetingTranscript = v.strictObject({
  ref: reference,
  meeting: reference,
  source: text,
  language: v.nullable(text),
  /** When a newer transcript of the same source replaced it; `meetings transcript --history` shows those too. */
  superseded_at: v.nullable(isoTime),
  created_at: isoTime,
  lines: v.array(line),
})

/** A provider's summary of a meeting. */
export const meetingSummary = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  meeting: reference,
  source: text,
  title: v.nullable(text),
  overview: v.nullable(text),
  sections: v.array(v.strictObject({ label: text, text })),
  next_steps: v.array(text),
  content: v.nullable(text),
  url: v.nullable(text),
  created_at: isoTime,
  updated_at: isoTime,
})

/** `meetings show`: the meeting with who took part, what was said in its chat, and what it holds. */
export const meetingDetails = v.strictObject({
  ...meeting.entries,
  /** The stored event and series it belongs to, as `meetings_list` takes them. */
  event_id: v.nullable(text),
  series_id: v.nullable(text),
  series_title: v.nullable(text),
  participants: v.array(
    v.strictObject({
      name: v.nullable(text),
      email: v.nullable(text),
      role: v.nullable(text),
      joined_at: v.nullable(isoTime),
      left_at: v.nullable(isoTime),
      duration_ms: v.nullable(count),
    }),
  ),
  transcripts: v.array(
    v.strictObject({ ref: reference, source: text, language: v.nullable(text), lines_count: count }),
  ),
  chat: v.array(v.strictObject({ sent_at: isoTime, sender: v.nullable(text), recipient: v.nullable(text), text })),
  summaries: v.array(meetingSummary),
  attachments: v.array(
    v.strictObject({
      position: count,
      kind: text,
      name: v.nullable(text),
      mime: v.nullable(text),
      size: v.nullable(count),
      url: v.nullable(text),
    }),
  ),
})

export type MeetingHitItem = v.InferOutput<typeof meetingHit>
export type MeetingTranscriptItem = v.InferOutput<typeof meetingTranscript>
export type MeetingSummaryItem = v.InferOutput<typeof meetingSummary>
export type MeetingDetailsItem = v.InferOutput<typeof meetingDetails>

/** Answers without `meta`: the host adds it, as it knows the run. */
export type MeetingListBody<T> = Omit<ListEnvelope<T>, "meta">
export type MeetingItemBody<T> = Omit<ItemEnvelope<T>, "meta">

const meetingRef = (accountId: number, meetingId: number) =>
  formatMeetingReference({ type: "meeting", accountId, meetingId })

export const meetingTranscriptItem = (
  accountId: number,
  transcript: Transcript,
  rows: TranscriptRow[],
): MeetingTranscriptItem => ({
  ref: formatMeetingReference({
    type: "meeting",
    accountId,
    meetingId: transcript.meetingId,
    transcriptId: transcript.id,
  }),
  meeting: meetingRef(accountId, transcript.meetingId),
  source: transcript.source,
  language: transcript.language,
  superseded_at: iso(transcript.supersededAt),
  created_at: new Date(transcript.externalCreatedAt ?? transcript.createdAt).toISOString(),
  lines: rows.map((row) => ({
    position: row.position,
    offset_ms: row.startMs,
    end_ms: row.endMs,
    speaker: row.speakerName,
    text: row.text,
  })),
})

export const meetingSummaryItem = (accountId: number, summary: Summary): MeetingSummaryItem => ({
  id: String(summary.id),
  meeting: meetingRef(accountId, summary.meetingId),
  source: summary.source,
  title: summary.title,
  overview: summary.overview,
  sections: summary.sections.map(({ label, text }) => ({ label, text })),
  next_steps: summary.nextSteps,
  content: summary.content,
  url: summary.docUrl,
  created_at: new Date(summary.externalCreatedAt ?? summary.createdAt).toISOString(),
  updated_at: new Date(summary.externalUpdatedAt ?? summary.updatedAt).toISOString(),
})

export const meetingDetailsItem = (details: MeetingDetails, owner: MeetingOwner): MeetingDetailsItem => {
  const { accountId } = details.meeting
  return {
    ...meetingItem(details.meeting, owner),
    event_id: details.meeting.eventId === null ? null : String(details.meeting.eventId),
    series_id: details.meeting.meetingSeriesId === null ? null : String(details.meeting.meetingSeriesId),
    series_title: details.series?.title ?? null,
    participants: details.participants.map((one) => ({
      name: one.displayName,
      email: one.email,
      role: one.role,
      joined_at: iso(one.joinedAt),
      left_at: iso(one.leftAt),
      duration_ms: one.durationMs,
    })),
    transcripts: details.transcripts
      .filter(({ transcript }) => transcript.supersededAt === null && transcript.deletedAt === null)
      .map(({ transcript, rows }) => ({
        ref: formatMeetingReference({
          type: "meeting",
          accountId,
          meetingId: transcript.meetingId,
          transcriptId: transcript.id,
        }),
        source: transcript.source,
        language: transcript.language,
        lines_count: rows.length,
      })),
    chat: details.chat.map((one) => ({
      sent_at: new Date(one.sentAt).toISOString(),
      sender: one.senderName,
      recipient: one.recipient,
      text: one.text,
    })),
    summaries: details.summaries.map((one) => meetingSummaryItem(accountId, one)),
    attachments: details.attachments.map((one) => ({
      position: one.position,
      kind: one.kind,
      name: one.name ?? one.title,
      mime: one.mime,
      size: one.size,
      url: one.url,
    })),
  }
}

/** A list read whole: every item on one page. */
export const wholeList = <T>(items: T[]): MeetingListBody<T> => ({
  items,
  page: { mode: "page", limit: Math.max(1, items.length), has_more: false },
})

const PAGE_NEXT = STEPS.find((step) => step.id === "page.next") as StepDefinition

/** The meeting steps; a host lists them beside its own so its step checks know them. */
export const MEETING_STEPS = defineSteps([
  {
    id: "meetings.search-again",
    command: "*",
    args: [],
    why: "passages that changed since they were indexed were left out; the next search indexes them first",
  },
])
const SEARCH_AGAIN = MEETING_STEPS[0] as StepDefinition

/** `search meetings`: the store's page, its cursor as `page.next`, and passages not indexed yet as `missing`. */
export const meetingHitItem = (hit: SearchHit & { ref: string }): MeetingHitItem => ({
  ref: hit.ref,
  meeting: meetingRef(parseMeetingReference(hit.ref).accountId, hit.meetingId),
  scope: hit.scope,
  id: String(hit.id),
  excerpt: hit.text,
  offset_ms: hit.startMs,
  untrusted: hit.source === undefined ? ["excerpt"] : ["excerpt", "source.title"],
  ...(hit.match === undefined ? {} : { match: hit.match }),
  ...(hit.corrections === undefined ? {} : { corrections: hit.corrections }),
  ...(hit.source === undefined
    ? {}
    : {
        source: {
          ref: hit.ref,
          title: hit.source.title,
          started_at: iso(hit.source.startedAt),
          url: hit.source.url,
        },
      }),
})

export const meetingHitsList = (
  found: MeetingSearchPage,
  limit: number,
  command = "search meetings",
  args: Record<string, unknown> = {},
  meta: Partial<Meta> = {},
): MeetingListBody<MeetingHitItem> & { meta?: Partial<Meta> } => {
  const items = found.items.map(meetingHitItem)
  const cursor = found.hasMore && found.nextCursor !== null ? found.nextCursor : undefined
  const pending = found.coverage.indexing === "pending"
  const next = [
    ...(cursor === undefined
      ? []
      : [stepOf(PAGE_NEXT, { command, args: { ...args, cursor, limit }, values: { shown: items.length } })]),
    ...(pending
      ? [
          stepOf(SEARCH_AGAIN, {
            command,
            args: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "cursor")),
          }),
        ]
      : []),
  ]
  return {
    items,
    page: {
      mode: "cursor",
      limit,
      has_more: cursor !== undefined,
      ...(cursor === undefined ? {} : { next_cursor: cursor }),
    },
    ...(next.length > 0 ? { next } : {}),
    ...(pending
      ? {
          missing: [
            {
              field: "excerpt",
              why: "passages that changed since they were indexed were left out",
              step: "meetings.search-again",
            },
          ],
        }
      : {}),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  }
}
