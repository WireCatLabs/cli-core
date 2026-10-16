import type { Stemmers } from "../search/stem.js"
import type { StoreContext } from "./sqlite/open.js"
import type { SearchIndexFill, SearchIndexState } from "./sqlite/search-index.js"
import * as searchIndex from "./sqlite/search-index.js"
import type { StemsFill, StemsState } from "./sqlite/stems.js"
import * as stems from "./sqlite/stems.js"
import { fillStems } from "./sqlite/stems-fill.js"
import { write } from "./sqlite/transaction.js"
import * as words from "./sqlite/words.js"

export interface SearchIndexStore {
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
}

export const searchIndexStoreOver = (context: StoreContext): SearchIndexStore => {
  const { database } = context
  return {
    knownTerms: async (terms) => words.knownTerms(context, terms),
    termCandidates: async (trigrams, lengths) => words.termCandidates(context, trigrams, lengths),
    searchIndexState: async () => searchIndex.searchIndexState(database),
    fillSearchIndex: async ({ until } = {}) =>
      searchIndex.fillSearchIndex(database, { now: context.now, ...(until ? { until } : {}) }),
    stemsState: async () => stems.stemsState(database),
    fillStems: async ({ until } = {}) => fillStems(database, { now: context.now, ...(until ? { until } : {}) }),
    stemmers: async () => stems.savedStemmers(database),
    saveStemmers: async (stemmers) => write(database, () => stems.saveStoreStemmers(database, stemmers, context.now())),
  }
}
