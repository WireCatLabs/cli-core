import type { SearchHit } from "./store.js"

export interface MeetingSearchOptions {
  accountId: number
  meetingId?: number
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
