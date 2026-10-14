import type { AdminReport } from "../domain/admin-statistics.js"
import type { RankingInput, RankingTarget } from "../domain/rankings-options.js"
import { FIELD_VERSION } from "../search/lucene/registry.js"
import { QUERY_VERSION } from "../search/lucene/types.js"
import type { SearchCommand, SearchRecord } from "../store/store.js"
import type { StatsGrouping } from "./messages-search.js"

/** What a run or a saved search keeps: the query and options as given, never a message or a result. */
export interface SearchParams extends RankingInput {
  discover?: boolean
  adminReport?: AdminReport
  selection?: unknown
  target?: RankingTarget
  text?: string
  ast?: unknown
  chat?: string
  source?: string
  timezone?: string
  limit?: number
  newest?: boolean
  /** Bare words and quotes match their exact form only (`--exact`). */
  exact?: boolean
  context?: number
  by?: StatsGrouping
}

const canonical = (value: unknown, nested = false): unknown =>
  Array.isArray(value)
    ? value.map((one) => canonical(one, true))
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, one]) => one !== undefined && (nested || one !== false))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, one]) => [key, canonical(one, true)]),
        )
      : value

/** One run or one saved search as the store keeps it; the same parameters always give the same text. */
export const searchRecordOf = (command: SearchCommand, params: SearchParams): SearchRecord => ({
  command,
  params: JSON.stringify(canonical(params)),
  language: "lucene-v1",
  version: QUERY_VERSION,
  fieldsVersion: FIELD_VERSION,
})
