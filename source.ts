import type { ChatLine, Meeting, Summary, TranscriptLine } from "./model.js"

/**
 * What a provider implements, once per way in: its API, files the user downloaded, or a browser.
 * `null` means the provider has none for that occurrence — no recording, no chat, no summary.
 */
export interface MeetingSource {
  readonly provider: string
  /** Occurrences that started at or after `since` (ISO 8601). */
  meetings(since: string): Promise<Meeting[]>
  transcript(occurrenceId: string): Promise<TranscriptLine[] | null>
  chat(occurrenceId: string): Promise<ChatLine[] | null>
  summary(occurrenceId: string): Promise<Summary | null>
}
