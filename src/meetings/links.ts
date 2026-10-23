import type { MeetingStatsSelection } from "./stats.js"

export interface MeetingChatLinesInput extends MeetingStatsSelection {
  /** Most chat messages to read (default and at most 100000); more is an error, never a silent cut. */
  maxMessages?: number
}

/** One stored chat message with the meeting it was sent in. */
export interface MeetingChatLine {
  meetingId: number
  accountId: number
  title: string | null
  sentAt: number
  sender: string | null
  text: string
}

export interface MeetingChatLinesStore {
  meetingChatLines(input: MeetingChatLinesInput): Promise<MeetingChatLine[]>
}

export const CHAT_MESSAGES_READ = 100_000
