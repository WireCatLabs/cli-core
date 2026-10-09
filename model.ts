/** A recurring meeting, or a one-off one: what a provider calls the meeting itself. */
export interface MeetingSeries {
  id: string
  provider: string
  title: string | null
}

/** One time the series met. Transcripts, chat and summaries belong to an occurrence, never to the series. */
export interface Occurrence {
  id: string
  seriesId: string
  title: string | null
  /** ISO 8601. */
  startedAt: string
  /** ISO 8601, or `null` when the provider does not say. */
  endedAt: string | null
}

export interface Meeting {
  series: MeetingSeries
  occurrence: Occurrence
}

export interface TranscriptLine {
  /** Milliseconds from the start of the recording. */
  startMs: number
  endMs: number
  /** `null` when the provider names nobody for the line. */
  speaker: string | null
  text: string
}

export interface ChatLine {
  /** ISO 8601. */
  sentAt: string
  sender: string | null
  text: string
}

export interface Summary {
  title: string | null
  overview: string | null
  sections: { label: string; text: string }[]
  nextSteps: string[]
}

/**
 * Cues carry no stable id, and a provider may renumber them, so a line is keyed by where it starts.
 * Importing the same transcript again then updates lines instead of adding them twice.
 */
export const lineId = (occurrenceId: string, line: Pick<TranscriptLine, "startMs">): string =>
  `${occurrenceId}@${line.startMs}`
