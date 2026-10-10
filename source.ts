import type { Metadata, SourceChatLine, SourceMeeting, SummaryContent, TranscriptLine } from "./model.js"
import type { MeetingSave } from "./store.js"

export interface SourceParticipant {
  identityExternalId: string | null
  email: string | null
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
  meetings(since: string): Promise<SourceMeeting[]>
  participants(occurrenceId: string): Promise<SourceParticipant[] | null>
  transcript(occurrenceId: string): Promise<TranscriptLine[] | null>
  chat(occurrenceId: string): Promise<SourceChatLine[] | null>
  summary(occurrenceId: string): Promise<SummaryContent | null>
  files(occurrenceId: string): Promise<NonNullable<MeetingSave["attachments"]> | null>
}
