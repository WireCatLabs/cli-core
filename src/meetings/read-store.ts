import type { Meeting, Transcript, TranscriptRow } from "./model.js"

export interface MeetingReadBudget {
  maxReadBytes?: number
  signal?: AbortSignal
}
/** @experimental */
export interface MeetingReadScope extends MeetingReadBudget {
  accountId: number
  meetingId: number
}
/** @experimental */
export interface TranscriptReadScope extends MeetingReadScope {
  transcriptId: number
  includeHistorical?: boolean
}
/** @experimental */
export interface TranscriptPage extends MeetingReadScope {
  afterId?: number
  limit: number
  includeHistorical?: boolean
}
/** @experimental */
export interface TranscriptRowPage extends TranscriptReadScope {
  afterPosition?: number
  limit: number
}
/** @experimental */
export interface TranscriptContextInput extends TranscriptReadScope {
  position: number
  before: number
  after: number
}
/** @experimental */
export interface TranscriptContextPage {
  meeting: Meeting
  transcript: Transcript
  rows: TranscriptRow[]
  hasBefore: boolean
  hasAfter: boolean
}
/** @experimental */
export interface MeetingContextReadCapabilities {
  transcriptContext(input: TranscriptContextInput): Promise<TranscriptContextPage>
}
/** @experimental */
export interface MeetingReadCapabilities {
  meetingMetadata(input: MeetingReadScope): Promise<Meeting>
  transcriptMetadata(input: TranscriptReadScope): Promise<Transcript>
  transcripts(input: TranscriptPage): Promise<{ items: Transcript[]; hasMore: boolean; nextId?: number }>
  transcriptRows(input: TranscriptRowPage): Promise<{
    meeting: Meeting
    transcript: Transcript
    rows: TranscriptRow[]
    hasMore: boolean
    nextPosition?: number
  }>
}
