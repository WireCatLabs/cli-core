import type { TrackerKind, TrackerRecords } from "../domain/tracker.js"

export interface TrackerSourceTraits {
  /** What this tracker has, in `TRACKER_KINDS` order: one without labels leaves `label` out. */
  kinds: readonly TrackerKind[]
}

export interface TrackerPage<T> {
  items: T[]
  /** More pages in this round, read from `nextCursor`. */
  hasMore: boolean
  nextCursor?: string
  /** On the last page: the cursor the next run reads changes after; `null` when the tracker keeps none. */
  cursor?: string | null
}

/** `reset`: the cursor is dead, and the kind must be listed in full again. */
export type TrackerChanges<T> = TrackerPage<T> | { reset: true }

export interface TrackerIdPage {
  items: string[]
  hasMore: boolean
  nextCursor?: string
}

/** What the last sync could not read, so an answer can name it: a kind the sign-in's scope refused. */
export interface TrackerGap {
  kind: TrackerKind
  message: string
  scope?: string
}

/** What the engine hands every source call; a source that ignores it works as before. */
export interface TrackerCallContext {
  /** Takes one request from the run's budget for each request beyond the first; throws once it is spent. */
  spend(): void
  /** Says what the call could not read without failing it. */
  gap(gap: TrackerGap): void
}

/**
 * One tracker account, as an adapter reads it. Archived rows are listed, with `archivedAt`: the copy keeps them marked.
 * A row the tracker deleted outright is found by `ids()`, a list of every id that exists, archived ones too.
 */
export interface TrackerSource {
  /** The registry name: `linear`. */
  readonly provider: string
  readonly traits: TrackerSourceTraits
  /** The sign-in's own user id, which `mine` filters read; absent, the tracker cannot say. */
  self?(context?: TrackerCallContext): Promise<string>
  /**
   * What changed since `cursor`, a page at a time; `cursor: null` lists everything. A tracker without a change feed
   * reads by its own modified time, with an overlap, and gives that time back as the cursor.
   */
  changes<K extends TrackerKind>(
    kind: K,
    cursor: string | null,
    page?: string,
    context?: TrackerCallContext,
  ): Promise<TrackerChanges<TrackerRecords[K]>>
  /** Every id the tracker holds of the kind, archived ones too, a page at a time: how deletions are found. */
  ids(kind: TrackerKind, page?: string, context?: TrackerCallContext): Promise<TrackerIdPage>
}
