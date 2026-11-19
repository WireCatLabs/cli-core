import type { ContentChannel, ContentKind, ContentMetric, ContentRecords } from "../domain/content.js"

export interface ContentSourceTraits {
  /** What this source has, in `CONTENT_KINDS` order: a social account without terms leaves `term` out. */
  kinds: readonly ContentKind[]
  /** The source has numbers per post that `metrics` reads. */
  metrics: boolean
}

export interface ContentPage<T> {
  items: T[]
  hasMore: boolean
  nextCursor?: string
  /** On the last page: the cursor the next run reads changes after; `null` when the source keeps none. */
  cursor?: string | null
}

/** `reset`: the cursor is dead, and the kind must be listed in full again. */
export type ContentChanges<T> = ContentPage<T> | { reset: true }

export interface ContentIdPage {
  items: string[]
  hasMore: boolean
  nextCursor?: string
}

/** What the last sync could not read: drafts a role may not see, a kind the sign-in's scope refused. */
export interface ContentGap {
  kind: ContentKind
  message: string
  scope?: string
}

export interface ContentCallContext {
  /** Takes one request from the run's budget for each request beyond the first; throws once it is spent. */
  spend(): void
  /** Says what the call could not read without failing it. A gap holds the kind's deletions. */
  gap(gap: ContentGap): void
}

/**
 * One content account, as an adapter reads it: a blog, or a social account. A trashed post is listed with its status,
 * as every status is: a list that leaves trash out would make a trashed post look deleted. A post deleted for good is
 * found by `ids()`, which lists every id of every status, or by `get` answering `null`.
 */
export interface ContentSource {
  /** The registry name: `wordpress`. */
  readonly provider: string
  readonly traits: ContentSourceTraits
  /** The sites or accounts this sign-in publishes on; their address is how a sync tells a moved site. */
  channels(context?: ContentCallContext): Promise<ContentChannel[]>
  /**
   * What changed since `cursor`, a page at a time; `cursor: null` lists everything. A source without a change feed
   * reads by its own modified time less an overlap, and gives back as the last page's cursor the time the round's first
   * page was read.
   */
  changes<K extends ContentKind>(
    kind: K,
    cursor: string | null,
    page?: string,
    context?: ContentCallContext,
  ): Promise<ContentChanges<ContentRecords[K]>>
  /** Every id the source holds of the kind, trashed ones too, a page at a time: how deletions are found. */
  ids(kind: ContentKind, page?: string, context?: ContentCallContext): Promise<ContentIdPage>
  /**
   * One record by its id; `null` only when the source said it has none, which proves it deleted. A source that cannot
   * read the kind one by one throws with the reason `GET_UNSUPPORTED`.
   */
  get<K extends ContentKind>(
    kind: K,
    externalId: string,
    context?: ContentCallContext,
  ): Promise<ContentRecords[K] | null>
  /** A reading of each post's numbers now; a source without metrics answers none. */
  metrics?(posts: readonly string[], context?: ContentCallContext): Promise<ContentMetric[]>
}

/** A source that cannot read one row by its id throws a CliError with this reason; it never answers null for it. */
export const GET_UNSUPPORTED = "content.get-unsupported"
