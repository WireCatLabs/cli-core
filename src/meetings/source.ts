import type { Metadata, SourceChatLine, SourceMeeting, SummaryContent, TranscriptLine } from "./model.js"
import type { MeetingSave } from "./store.js"

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
}
