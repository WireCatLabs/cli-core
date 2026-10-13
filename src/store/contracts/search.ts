import type { Id, Page } from "../../domain/models.js"
import type { RetentionOptions } from "../../domain/retention.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { Stemmers } from "../../search/stem.js"
import type { AdminStoreRequest, AdminStoreResult } from "./admin-statistics-types.js"
import type { QueryGroup, QueryGrouping } from "./lucene-types.js"
import type { AccountKey, MessageFilter, StoredHit } from "./models.js"
import type { RankedEvidence, RankingEvidenceRequest } from "./ranking-evidence-types.js"
import type { RankedStoreFound, RankingRequest } from "./rankings-types.js"
import type { RetentionResult } from "./retention-types.js"
import type { SearchIndexFill, SearchIndexState } from "./search-index-types.js"
import type { SearchRecord, StoredSearch } from "./searches-types.js"
import type { StemsFill, StemsState } from "./stems-types.js"
import type { ScoredHit, SearchScope, WordOptions, WordQuery } from "./words-types.js"

export interface SearchStore {
  /** Newest first. At least three characters: a trigram index answers a shorter query with nothing. */
  search(query: string, options: { limit: number; account?: AccountKey }): Promise<Page<StoredHit>>

  /** Newest first — by text, by who wrote it, or both. */
  find(filter: MessageFilter): Promise<Page<StoredHit>>

  /**
   * The word index, ranked by bm25, ties newest first (phase 2 plan S4 steps 1, 2 and 4). Chats marked
   * not searchable are left out unless the scope names the chat.
   */
  rankingDiscussionChats?(account: AccountKey, chatId: string): Promise<string[]>

  rankingEvidence?(execution: QueryExecution, request: RankingEvidenceRequest): Promise<RankedEvidence>

  retention?(
    key: AccountKey,
    chatId: Id,
    options: RetentionOptions,
    evidence?: { cohort: string; cursor?: string },
  ): Promise<RetentionResult>

  adminStatisticsQuery?(execution: QueryExecution, request: AdminStoreRequest): Promise<AdminStoreResult>

  rankQuery?(execution: QueryExecution, request: RankingRequest): Promise<RankedStoreFound>

  matchQuery?(execution: QueryExecution): Promise<Page<ScoredHit>>

  /** The same matches as `matchQuery`, each counted once, grouped by chat, sender or quarter hour. */
  countQuery?(execution: QueryExecution, by: QueryGrouping): Promise<QueryGroup[]>

  matchWords(query: WordQuery, scope: SearchScope, options: WordOptions): Promise<Page<ScoredHit>>

  /** The substring index, newest first (step 5); pieces under three letters are dropped. */
  matchSubstring(query: WordQuery, scope: SearchScope, options: { limit: number }): Promise<Page<ScoredHit>>

  /** Messages matching the scope alone, newest first: a search with filters and no word. */
  matchFilters(scope: SearchScope, options: { limit: number }): Promise<Page<ScoredHit>>

  /** Of `terms`, those the index knows as a word or the beginning of one. */
  knownTerms(terms: string[]): Promise<Set<string>>

  /** Known words sharing these trigrams, within the lengths, most shared first. */
  termCandidates(
    trigrams: string[],
    lengths: { shortest: number; longest: number },
  ): Promise<{ term: string; docs: number }[]>

  /** How far the word index is built; `undefined` on a file before it existed. */
  searchIndexState(): Promise<SearchIndexState | undefined>

  /**
   * Builds the word index towards "ready" in short batches — the normalized text, the messages up to
   * the watermark, the typo vocabulary — until done or `until` says stop. Each batch is its own write.
   */
  fillSearchIndex(options?: { until?: () => boolean }): Promise<SearchIndexFill>

  /** How far the stems are built, and by which stemmer choices; `undefined` on a file before they existed. */
  stemsState(): Promise<StemsState | undefined>

  /** Builds the stems towards "ready" in short batches until done or `until` says stop; never rebuilds. */
  fillStems(options?: { until?: () => boolean }): Promise<StemsFill>

  /**
   * The stemmer choices saved in the store for every profile, tg and MAX; `undefined` while the defaults
   * apply, `null` when a newer tool saved one this build does not know.
   */
  stemmers(): Promise<Stemmers | null | undefined>

  /** Saves them; stems built by other choices wait for `store reindex` or `store migrate`. */
  saveStemmers(stemmers: Stemmers): Promise<void>

  /** One run of a search or stats; the same unnamed run again counts on its row. `saved` is the saved search it ran. */
  recordSearch(run: SearchRecord, options?: { saved?: string }): Promise<void>

  /** A saved search by name; a name already taken is refused unless `replace`. */
  saveSearch(name: string, search: SearchRecord, options?: { replace?: boolean }): Promise<StoredSearch>

  /** A saved search by name, or any row by id. */
  storedSearch(reference: string): Promise<StoredSearch | undefined>

  savedSearches(): Promise<StoredSearch[]>

  /** Runs, newest first, one more than `limit` when there are more. */
  searchHistory(limit: number): Promise<StoredSearch[]>

  deleteSearch(reference: string): Promise<StoredSearch>

  /** Drops the unnamed runs; answers how many. */
  clearSearchHistory(): Promise<number>
}
