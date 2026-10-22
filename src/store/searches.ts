import type { StoreContext } from "./sqlite/open.js"
import type { SearchCommand, SearchRecord, StoredSearch } from "./sqlite/searches.js"
import * as searchRecords from "./sqlite/searches.js"
import { write } from "./sqlite/transaction.js"

export interface SearchesStore {
  /** One run of a search or stats; the same unnamed run again counts on its row. `saved` is the saved search it ran. */
  recordSearch(run: SearchRecord, options?: { saved?: string }): Promise<void>
  /** A saved search by name; a name already taken is refused unless `replace`. */
  saveSearch(name: string, search: SearchRecord, options?: { replace?: boolean }): Promise<StoredSearch>
  /** A saved search by name, or any row by id. */
  storedSearch(reference: string): Promise<StoredSearch | undefined>
  /** `commands`: only rows of these kinds; the table is shared by every CLI on the store. */
  savedSearches(commands?: readonly SearchCommand[]): Promise<StoredSearch[]>
  /** Runs, newest first, one more than `limit` when there are more. */
  searchHistory(limit: number, offset?: number, commands?: readonly SearchCommand[]): Promise<StoredSearch[]>
  deleteSearch(reference: string): Promise<StoredSearch>
  /** Drops the unnamed runs; answers how many. */
  clearSearchHistory(commands?: readonly SearchCommand[]): Promise<number>
}

export const searchesStoreOver = (context: StoreContext): SearchesStore => {
  const { database } = context
  return {
    recordSearch: async (run, { saved } = {}) => write(database, () => searchRecords.recordRun(context, run, saved)),

    saveSearch: async (name, search, { replace = false } = {}) => {
      return write(database, () => searchRecords.saveSearch(context, name, search, replace))
    },

    storedSearch: async (reference) => searchRecords.findSearch(context, reference),

    savedSearches: async (commands) => searchRecords.savedSearches(context, commands),

    searchHistory: async (limit, offset, commands) => searchRecords.searchHistory(context, limit, offset, commands),

    deleteSearch: async (reference) => {
      return write(database, () => searchRecords.deleteSearch(context, reference))
    },

    clearSearchHistory: async (commands) => {
      let cleared = 0
      write(database, () => {
        cleared = searchRecords.clearHistory(context, commands)
      })
      return cleared
    },
  }
}
