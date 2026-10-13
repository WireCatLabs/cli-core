import { CliError } from "@wirecat/cli-base"
import type { SearchStore } from "../contracts/search.js"
import { adminStatisticsQuery } from "../sqlite/admin-statistics.js"
import { findRegex } from "../sqlite/legacy-regex.js"
import * as lucene from "../sqlite/lucene.js"
import { rankingEvidence } from "../sqlite/ranking-evidence.js"
import { rankQuery } from "../sqlite/rankings.js"
import { retentionQuery } from "../sqlite/retention.js"
import * as search from "../sqlite/search.js"
import * as searchIndex from "../sqlite/search-index.js"
import type { StoredSearch } from "../sqlite/searches.js"
import * as searchRecords from "../sqlite/searches.js"
import * as stems from "../sqlite/stems.js"
import * as words from "../sqlite/words.js"
import type { StoreRuntime } from "./runtime.js"

export const searchStoreOver = ({
  context,
  database,
  inTransaction,
  mailIndexed,
  findAccountPk,
  findChatPk,
}: Pick<
  StoreRuntime,
  "context" | "database" | "inTransaction" | "mailIndexed" | "findAccountPk" | "findChatPk"
>): SearchStore => {
  return {
    search: async (query, { limit, account }) =>
      search.find(context, { text: query, limit, ...(account ? { account } : {}) }),

    find: async (filter) => (filter.pattern ? findRegex(context, filter) : search.find(context, filter)),

    rankingDiscussionChats: async (account, chatId) => {
      const rows = database
        .prepare(
          "SELECT DISTINCT json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.discussionChatId') AS id FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND c.kind='channel' AND m.deleted_at IS NULL AND json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.version')=1 AND json_type(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.discussionChatId')='text' LIMIT 101",
        )
        .all(account.provider, account.account, chatId)
      if (rows.length > 100)
        throw new CliError("validation_error", "too many linked discussion groups — narrow the channel scope")
      return rows.map(({ id }) => String(id))
    },

    rankingEvidence: async (execution, request) => rankingEvidence(context, execution, request),

    retention: async (key, chatId, options, evidence) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (accountKey === undefined || chatKey === undefined)
        throw new CliError("validation_error", "retention needs a stored chat and membership observations")
      context.database.exec("BEGIN")
      try {
        const result = retentionQuery(context, accountKey, chatKey, chatId, options, evidence)
        context.database.exec("COMMIT")
        return result
      } catch (error) {
        context.database.exec("ROLLBACK")
        throw error
      }
    },

    adminStatisticsQuery: async (execution, request) => adminStatisticsQuery(context, execution, request),

    rankQuery: async (execution, request) => rankQuery(context, execution, request),

    matchQuery: async (execution) => lucene.matchQuery(context, mailIndexed(execution)),

    countQuery: async (execution, by) => lucene.countQuery(context, mailIndexed(execution), by),

    matchWords: async (query, scope, options) => words.matchWords(context, query, scope, options),

    matchSubstring: async (query, scope, options) => words.matchSubstring(context, query, scope, options),

    matchFilters: async (scope, options) => words.matchFilters(context, scope, options),

    knownTerms: async (terms) => words.knownTerms(context, terms),

    termCandidates: async (trigrams, lengths) => words.termCandidates(context, trigrams, lengths),

    searchIndexState: async () => searchIndex.searchIndexState(database),

    fillSearchIndex: async ({ until } = {}) =>
      searchIndex.fillSearchIndex(database, { now: context.now, ...(until ? { until } : {}) }),

    stemsState: async () => stems.stemsState(database),

    fillStems: async ({ until } = {}) => stems.fillStems(database, { now: context.now, ...(until ? { until } : {}) }),

    stemmers: async () => stems.savedStemmers(database),

    saveStemmers: async (stemmers) => inTransaction(() => stems.saveStoreStemmers(database, stemmers, context.now())),

    recordSearch: async (run, { saved } = {}) => inTransaction(() => searchRecords.recordRun(context, run, saved)),

    saveSearch: async (name, search, { replace = false } = {}) => {
      let saved: StoredSearch | undefined
      inTransaction(() => {
        saved = searchRecords.saveSearch(context, name, search, replace)
      })
      return saved as StoredSearch
    },

    storedSearch: async (reference) => searchRecords.findSearch(context, reference),

    savedSearches: async () => searchRecords.savedSearches(context),

    searchHistory: async (limit) => searchRecords.searchHistory(context, limit),

    deleteSearch: async (reference) => {
      let deleted: StoredSearch | undefined
      inTransaction(() => {
        deleted = searchRecords.deleteSearch(context, reference)
      })
      return deleted as StoredSearch
    },

    clearSearchHistory: async () => {
      let cleared = 0
      inTransaction(() => {
        cleared = searchRecords.clearHistory(context)
      })
      return cleared
    },
  }
}
