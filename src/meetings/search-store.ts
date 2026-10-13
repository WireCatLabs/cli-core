import type { SearchHit } from "./store.js"

export interface MeetingSearchOptions {
  accountId: number
  meetingId?: number
  /** Observed participant identity; filters meetings, not who spoke a hit. */
  participantIdentityId?: number
  /** Only explicit identity-to-person links are followed. */
  personId?: number
  /** Confirmed, unanchored meeting membership in a live owner project. */
  projectId?: number
  /** An explicit meeting label (tag or topic). */
  tagId?: number
  /** A stored calendar event the meeting is linked to. */
  eventId?: number
  meetingSeriesId?: number
  since?: number
  until?: number
  limit?: number
  /** Opaque continuation, bound by the adapter to the account, query and filters. */
  after?: string
  maxReadBytes?: number
  signal?: AbortSignal
}

export interface MeetingSearchPage {
  items: SearchHit[]
  hasMore: boolean
  nextCursor: string | null
  coverage: {
    archiveCompleteness: "unknown"
    currentRevisions: true
    indexing: "ready" | "pending"
    indexCompleteness: "unknown"
  }
}

/** Optional bounded read capability; paging reaches inside a single large transcript. */
export interface MeetingSearchStore {
  searchHits(query: string, options: MeetingSearchOptions): Promise<MeetingSearchPage>
}

export interface MeetingSearchIndexInput {
  accountId: number
  limit?: number
  maxReadBytes?: number
  signal?: AbortSignal
}

export interface MeetingSearchIndexReceipt {
  indexed: number
  remaining: number
}

/** Explicit bounded index maintenance, independent of read-only hit paging. */
export interface MeetingSearchIndexStore {
  indexSearch(input: MeetingSearchIndexInput): Promise<MeetingSearchIndexReceipt>
}

export interface MeetingHitSearchRequest extends MeetingSearchOptions {
  /** Exact canonical name, project key or explicit alias; never a fuzzy match. */
  project?: string
  tag?: string
  topic?: string
}
