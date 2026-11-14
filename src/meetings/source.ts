import type { Predicate } from "@wirecat/cli-base/query"
import type { ServiceOperator } from "../search/service-query.js"
import type { Metadata, SourceChatLine, SourceMeeting, SummaryContent, TranscriptLine } from "./model.js"
import type { MeetingDocumentInput, MeetingSave } from "./store.js"

export interface SourceParticipant {
  identityExternalId: string | null
  email: string | null
  /**
   * The number the participant called from or was called on, as the phone network gave it: what links a call's
   * client to the CRM contact with that number. E.164, or written with `+`; anything else is left out.
   */
  phone?: string | null
  displayName: string | null
  externalId: string | null
  role: string | null
  joinedAt: number | null
  leftAt: number | null
  durationMs: number | null
  sessions: import("./model.js").JsonValue
  metadata: Metadata
}

/** When the meetings `find` asks for started, epoch milliseconds, both ends inclusive; an open end is the source's. */
export interface MeetingWindow {
  from?: number
  to?: number
}

/** A `meetings list` term `find` declared it reads, besides `started_at`; `negated` only for a negatable field. */
export interface MeetingTerm {
  predicate: Predicate
  negated: boolean
}

/** A meeting the service returned, with its participants when the same answer carries them. */
export interface FoundMeeting {
  meeting: SourceMeeting
  participants?: SourceParticipant[] | null
}

export interface FoundMeetings {
  meetings: FoundMeeting[]
  /** The next page's cursor; `null` on the last page. */
  next: string | null
}

/** One meeting with what `meetings show` keeps of it: its people, transcript and Drive documents. */
export interface FullMeeting extends FoundMeeting {
  transcript?: TranscriptLine[] | null
  documents?: MeetingDocumentInput[] | null
}

/**
 * What `find` filters besides `started_at`, which every `find` takes as its window: `meetings list` fields and the
 * operators the service reads on each (`provider_id: ["term"]`). The store decides the rest of the query.
 */
export interface MeetingFinds {
  fields: Readonly<Record<string, readonly ServiceOperator[]>>
  /** The fields whose NOT the service can send. */
  negatable?: readonly string[]
  /** False for a service that lists no meeting before it starts (Meet: scheduling is Google Calendar's). */
  upcoming?: boolean
}

/** Null means unavailable; it never requests deletion of previously saved data. */
export interface MeetingSource {
  readonly provider: string
  readonly name: string
  readonly transcriptFormat?: string
  /**
   * How far back each sync looks before its cursor, in integer milliseconds up to 31 days: a provider that lists a
   * meeting only once it has ended, or adds its recording later, sets it. 0 when absent; `--lookback-days` widens it.
   */
  readonly overlapMs?: number
  /**
   * False for a source that knows a meeting's day but not its hours, such as meeting notes from mail: its meetings
   * link to an event the owner already has and never make one. True when absent.
   */
  readonly createsEvents?: boolean
  meetings(since: string): Promise<SourceMeeting[]>
  participants(occurrenceId: string): Promise<SourceParticipant[] | null>
  transcript(occurrenceId: string): Promise<TranscriptLine[] | null>
  chat(occurrenceId: string): Promise<SourceChatLine[] | null>
  summary(occurrenceId: string): Promise<SummaryContent | null>
  files(occurrenceId: string): Promise<NonNullable<MeetingSave["attachments"]> | null>
  /** The Drive files the service saved for the occurrence: its transcript, recording and notes documents. */
  documents?(occurrenceId: string): Promise<MeetingDocumentInput[] | null>
  /** What `find` reads of a `meetings list` query; required with `find`. */
  readonly finds?: MeetingFinds
  /**
   * The meetings that may match, for `meetings list`: one page from `cursor` (`null` first). Each meeting's
   * `occurrence.id` is the one `meetings()` gives, so the row it is kept as is the row `sync` writes.
   */
  find?(window: MeetingWindow, terms: readonly MeetingTerm[], cursor: string | null): Promise<FoundMeetings>
  /** One meeting by the service's id, for `meetings show`; `null` when the service has none. */
  get?(id: string): Promise<FullMeeting | null>
}
