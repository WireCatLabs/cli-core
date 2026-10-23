import type { MeetingStatsSelection } from "./stats.js"

export interface MeetingReviewInput extends MeetingStatsSelection {
  /** Most meetings, newest first (default 50, at most 200). */
  limit?: number
}

export interface MeetingReviewSpeaker {
  name: string | null
  talkMs: number
}

/** One meeting as a review shows it: what the store holds about it, never transcript text. */
export interface MeetingReviewItem {
  meetingId: number
  accountId: number
  title: string | null
  startedAt: number | null
  durationMs: number | null
  participantsCount: number | null
  projects: string[]
  /** `null`: no current transcript. */
  transcript: { lines: number; words: number } | null
  /** The three who talked longest, from the transcript. */
  speakers: MeetingReviewSpeaker[]
  /** The newest stored summary; `null` when the meeting has none. */
  summary: {
    source: string
    title: string | null
    overview: string | null
    nextSteps: string[]
    url: string | null
  } | null
}

export interface MeetingReview {
  items: MeetingReviewItem[]
  hasMore: boolean
}

export interface MeetingReviewStore {
  meetingReview(input: MeetingReviewInput): Promise<MeetingReview>
}

export const REVIEW_LIMIT = { default: 50, most: 200 } as const
