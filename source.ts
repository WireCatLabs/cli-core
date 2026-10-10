import type { SourceChatLine, SourceMeeting, SummaryContent, TranscriptLine } from "./model.js"

/**
 * What a provider implements, once per way in: its API, files the user downloaded, or a browser.
 * `null` means the provider has none for that occurrence — no recording, no chat, no summary.
 */
export interface MeetingSource {
  readonly provider: string
  /** Occurrences that started at or after `since` (ISO 8601). */
  meetings(since: string): Promise<SourceMeeting[]>
  transcript(occurrenceId: string): Promise<TranscriptLine[] | null>
  chat(occurrenceId: string): Promise<SourceChatLine[] | null>
  summary(occurrenceId: string): Promise<SummaryContent | null>
}
