import type { CounterState } from "../../domain/counters.js"
import type { rankReplyGraph } from "../../domain/rankings-graph.js"
import type { RankingComponent, RankingOptions, ScoreComponents } from "../../domain/rankings-options.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { SqlValue } from "../driver.js"

export interface RankingRequest {
  options: RankingOptions
  timezone: string
  contextChat?: QueryExecution["chat"]
}

export interface RankedStoreRow {
  provider: string
  account: string
  id: string
  chatId: string | null
  name: string | null
  pk: number | null
  kind: string | null
  rank: number
  value: number
  components: Record<string, number | null>
  messages: number
  knownReactions: number
  unknownReactions: number
  score: ScoreComponents | null
  counterObservations?: CounterState[]
  graphComplete?: boolean
}

export interface RankedStoreFound {
  total: number
  population: number
  eligible: number
  excludedMinimum: number
  excludedMissing: number
  excludedUnknownSender: number
  excludedUnknownKind: number
  items: RankedStoreRow[]
  maxima: Partial<Record<RankingComponent, number>>
  hasMore: boolean
  graphQuality?: ReturnType<typeof rankReplyGraph>["quality"]
}

/** Aggregate and normalize the whole population, returning only a bounded page. */
export interface RankingSnapshot {
  prefix: string
  params: SqlValue[]
  filtered: string
  found: RankedStoreFound
  check: () => void
}
