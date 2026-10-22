import { CliError, singleLine } from "@wirecat/cli-base"
import type { SearchesStore, StoredSearch } from "../store/store.js"
import { searchRecordOf } from "./search-record.js"
import { nameOf } from "./searches.js"

/** A meeting search as `search meetings` takes it: the query and the options typed with it, already checked. */
export interface MeetingSearchParams {
  query: string
  options: Readonly<Record<string, string | number | boolean>>
}

export interface SavedMeetingSearch extends MeetingSearchParams {
  id: string
  name: string | null
}

export interface MeetingSearchesService {
  create(name: string, params: MeetingSearchParams, options?: { replace?: boolean }): Promise<StoredSearch>
  list(): Promise<StoredSearch[]>
  show(reference: string): Promise<StoredSearch>
  delete(reference: string): Promise<StoredSearch>
  /** `--saved`: the stored query and options, counted as one more run. */
  run(reference: string): Promise<SavedMeetingSearch>
}

const KIND = ["meetings-search"] as const

/**
 * Saved meeting searches, in the table every CLI on the store shares: only rows of their own kind are listed, and a
 * saved message search is refused by name rather than run as a meeting one.
 */
export const meetingSearchesService = (searches: () => Promise<SearchesStore>): MeetingSearchesService => {
  const found = async (reference: string): Promise<StoredSearch> => {
    const search = await (await searches()).storedSearch(reference.trim().toLowerCase())
    if (!search) throw new CliError("not_found", `no saved search "${singleLine(reference)}"`)
    if (search.command !== "meetings-search")
      throw new CliError("validation_error", `"${singleLine(reference)}" is a saved search of messages, not meetings`, {
        reason: "search.kind",
        command: search.command,
      })
    return search
  }
  const record = ({ query, options }: MeetingSearchParams) =>
    searchRecordOf("meetings-search", { ...options, text: query })
  return {
    create: async (name, params, { replace = false } = {}) =>
      (await searches()).saveSearch(nameOf(name), record(params), { replace }),
    list: async () => (await searches()).savedSearches(KIND),
    show: found,
    delete: async (reference) => (await searches()).deleteSearch((await found(reference)).id),
    run: async (reference) => {
      const search = await found(reference)
      const { text, ...options } = search.params as Record<string, string | number | boolean>
      const query = { query: String(text ?? ""), options }
      await (await searches()).recordSearch(record(query), { saved: search.id })
      return { id: search.id, name: search.name, ...query }
    },
  }
}
