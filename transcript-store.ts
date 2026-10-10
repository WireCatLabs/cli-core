import type { MeetingDetails, TranscriptInput, TranscriptRowInput } from "./store.js"

export type UnlinkedTranscriptInput = Omit<TranscriptInput, "rows" | "contentHash"> & {
  contentHash: string
  rows: Omit<TranscriptRowInput, "speakerParticipantPosition">[]
}
export interface TranscriptAppend {
  accountId: number
  externalId: string
  /** Used only when the occurrence does not exist; never replaces existing meeting fields. */
  create?: { title: string | null; startedAt: number; timezone: string | null }
  transcripts: UnlinkedTranscriptInput[]
  now: number
}

/** Optional adapter capability; the existing MeetingStore contract does not require it. */
export interface MeetingTranscriptStore {
  /**
   * Atomic source/hash append preserving meeting fields and unrelated parts. Historical replays
   * never reactivate superseded versions. Missing or deleted targets reject with not_found unless
   * create supplies a new occurrence; deleted occurrences are never recreated.
   */
  appendTranscripts(input: TranscriptAppend): Promise<MeetingDetails>
}
