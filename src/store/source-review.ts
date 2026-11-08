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
  /**
   * Sources found changed in this run, raised or signed anew, that no open `evidence_findings` batch cites: what an
   * agent may read again for new facts. Deleted sources and cited memories or facts are left out.
   */
  changedRefs: string[]
}

/** A cited source found changed since it was cited, by a check at `checkedAt`. */
export interface ChangedSource {
  ref: string
  checkedAt: string
}

/** One source of a review as it was cited and as it is now, for the owner to compare; both are the source's text. */
export interface SourceReviewText {
  link: number
  ref: string | null
  /** The words the claim rested on, as its author quoted them. */
  quote: string | null
  /** `null` where the store keeps no history for the kind, or the source is gone. */
  cited: string | null
  /** `null` where the store keeps no text for the kind, or the source is deleted. */
  now: string | null
}

/** What stands in a review for words about a source that was erased since. */
export const ERASED_TEXT = "[source erased]"

export const severity = (cause: SourceReviewCause): number => SOURCE_REVIEW_CAUSES.indexOf(cause)

export const graver = (a: SourceReviewCause, b: SourceReviewCause): SourceReviewCause =>
  severity(b) > severity(a) ? b : a
