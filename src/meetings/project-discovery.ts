import type { MeetingSearchOptions, MeetingSearchPage } from "./search-store.js"
import type { SearchHit } from "./store.js"

export interface MeetingProjectDiscoveryOptions extends Omit<MeetingSearchOptions, "projectId" | "after"> {
  cursor?: string
  maxTerms?: number
  maxVocabularyReadBytes?: number
}

export type MeetingProjectDiscoveryReader = (
  project: string,
  options: Omit<MeetingProjectDiscoveryOptions, "accountId">,
) => Promise<MeetingProjectDiscoveryPage>

/** One bounded name lane; repeating references across lanes are the same evidence. */
export interface MeetingProjectDiscoveryPage {
  schemaVersion: 1
  kind: "meeting_project_discovery"
  accountId: number
  query: string
  limits: { limit: number; maxReadBytes: number; maxVocabularyReadBytes: number; maxTerms: number }
  project: { id: string; name: string; key: string | null }
  term: { name: string; kind: "canonical" | "key" | "alias"; aliasId?: string }
  hits: (SearchHit & { ref: string })[]
  association: "unconfirmed-word-evidence"
  vocabularyFingerprint: string
  hasMore: boolean
  nextCursor: string | null
  coverage: MeetingSearchPage["coverage"] & {
    termIndex: number
    termsTotal: number
    remainingTerms: number
    duplicates: "may-repeat-between-terms"
  }
}
