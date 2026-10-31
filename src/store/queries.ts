import type { Page } from "../domain/models.js"
import type { QueryExecution } from "../search/lucene/resolved.js"
import type { Stemmer, Stemmers } from "../search/stem.js"
import { type AdminStoreRequest, type AdminStoreResult, adminStatisticsQuery } from "./sqlite/admin-statistics.js"
import { type ConversationEligibility, conversationEligibility } from "./sqlite/conversation-eligibility.js"
import { drainEmailIndex } from "./sqlite/email-index.js"
import type { QueryGroup, QueryGrouping } from "./sqlite/lucene.js"
import * as lucene from "./sqlite/lucene.js"
import type { StoreContext } from "./sqlite/open.js"
import { type RankedEvidence, type RankingEvidenceRequest, rankingEvidence } from "./sqlite/ranking-evidence.js"
import { type RankedStoreFound, type RankingRequest, rankQuery } from "./sqlite/rankings.js"
import type { ScoredHit } from "./sqlite/words.js"

/** A resolved Lucene query run over the store: hits, counts, rankings and the statistics behind them. */
export interface QueriesStore {
  matchQuery(execution: QueryExecution): Promise<Page<ScoredHit>>
  /** The same matches as `matchQuery`, each counted once, grouped by chat, sender or quarter hour. */
  countQuery(execution: QueryExecution, by: QueryGrouping): Promise<QueryGroup[]>
  /** How many messages match, counted no further than `cap + 1`; `undefined` when only a full search could tell. */
  countMatches(execution: QueryExecution, cap: number): Promise<number | undefined>
  conversationEligibility(execution: QueryExecution): Promise<ConversationEligibility>
  rankQuery(execution: QueryExecution, request: RankingRequest): Promise<RankedStoreFound>
  rankingEvidence(execution: QueryExecution, request: RankingEvidenceRequest): Promise<RankedEvidence>
  adminStatisticsQuery(execution: QueryExecution, request: AdminStoreRequest): Promise<AdminStoreResult>
}

export const queriesStoreOver = (context: StoreContext, stemmerFor: (stemmers: Stemmers) => Stemmer): QueriesStore => {
  const mailIndexed = (execution: QueryExecution) => {
    if (execution.corpus === "mail") drainEmailIndex(context.database, stemmerFor)
    return execution
  }
  return {
    matchQuery: async (execution) => lucene.matchQuery(context, mailIndexed(execution)),
    countQuery: async (execution, by) => lucene.countQuery(context, mailIndexed(execution), by),
    countMatches: async (execution, cap) => lucene.countMatches(context, mailIndexed(execution), cap),
    conversationEligibility: async (execution) => conversationEligibility(context, execution),
    rankQuery: async (execution, request) => rankQuery(context, execution, request),
    rankingEvidence: async (execution, request) => rankingEvidence(context, execution, request),
    adminStatisticsQuery: async (execution, request) => adminStatisticsQuery(context, execution, request),
  }
}
