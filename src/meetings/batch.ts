import type { MeetingPassageReader } from "./passage.js"
import type { MeetingSearchIndexReceipt } from "./search-store.js"
import type { MeetingHitSearch } from "./search-validation.js"

export interface MeetingBatchReader {
  index: (options: { maxReadBytes: number; signal?: AbortSignal }) => Promise<MeetingSearchIndexReceipt>
  search: MeetingHitSearch
  passage: MeetingPassageReader
}
