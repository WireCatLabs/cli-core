export const SOURCE_REVIEW_KIND = "memory_source_review"

/** Least severe first: a review moves forward in the queue only when its cause moves right. */
export const SOURCE_REVIEW_CAUSES = ["changed", "outdated", "deleted", "contradicted"] as const

export type SourceReviewCause = (typeof SOURCE_REVIEW_CAUSES)[number]

/** The open review of a memory or fact, as its reads show it. */
export interface SourceReviewMarker {
  id: string
  cause: SourceReviewCause
}

/** One cited source that needs a look; it names the cited version and never copies its text. */
export interface SourceReviewSource {
  /** The `evidence` link's id. */
  link: number
  /** `null` when the store can no longer name the source, or it was erased. */
  ref: string | null
  /** The kind of source an erased `ref` named. */
  kind?: string
  cause: Exclude<SourceReviewCause, "contradicted">
  /** The version cited (`links.metadata.cited_rev`), to read its text back through `sourceTextAt`. */
  citedRev: number | null
  /** For `outdated`: what replaced the cited fact or memory, following `supersedes`. */
  replacement?: string
}

export interface SourceReviewChallenge {
  evidence: string[]
  reason: string
  /** `owner`, or the bot's handle. */
  by: string
  at: string
}

/** What an author offers with a review, such as a corrected claim; it is the author's text, never the source's. */
export interface SourceReviewSuggestion {
  /** `owner`, or the bot's handle. */
  author: string
  body: string
  /** The references of the challenge it came with. */
  evidence: string[]
  at: string
}

/** A `memory_source_review` proposal's payload. */
export interface SourceReviewPayload {
  target: string
  cause: SourceReviewCause
  raisedAt: string
  sources: SourceReviewSource[]
  challenges: SourceReviewChallenge[]
  suggestions?: SourceReviewSuggestion[]
}

export interface SourceCheck {
  /** Evidence links read. */
  checked: number
  /** Links written before signatures, signed now with nothing to say. */
  baselined: number
  /** Reviews opened, or open ones whose cause or sources grew. */
  raised: number
  /** Sources that changed while still saying the quoted words, signed again in silence. */
  refreshed: number
  /** Open reviews of a memory or fact met in this run that no longer holds, closed. */
  closed: number
}

/** What stands in a review for words about a source that was erased since. */
export const ERASED_TEXT = "[source erased]"

export const severity = (cause: SourceReviewCause): number => SOURCE_REVIEW_CAUSES.indexOf(cause)

export const graver = (a: SourceReviewCause, b: SourceReviewCause): SourceReviewCause =>
  severity(b) > severity(a) ? b : a
