import { accountOf, keyOf, searchStore, statsStore, topUp } from "./messages-archive-search.js"

export { validateSearchDialect } from "./message-query-validation.js"
export { MAX_SEARCH_OFFSET, SEARCH_FILL_MS, searchStore, statsStore } from "./messages-archive-search.js"

import { CliError } from "@wirecat/cli-base"
import type { Id } from "../domain/models.js"
import type { AccountKey, MessageStore, SearchCommand } from "../store/store.js"
import { crossAccount, type ServiceDeps } from "./deps.js"
import type { MessagesService, SearchFound, SearchQuery } from "./message-contracts.js"
import type { StatsGrouping } from "./messages-search.js"
import { searchAll } from "./search-all.js"
import { searchAllWithMeetings } from "./search-all-meetings.js"
import { type SearchParams, searchRecordOf } from "./search-record.js"
import { refreshSearch, withRefresh } from "./search-refresh.js"
import { type ServerStep, searchServer, sourceKey } from "./server-search.js"
import { threadBounds } from "./thread-context.js"

/** The server answers for the account it runs as only; another account's message with the same ids is the archive's. */
const withServer = <T extends SearchFound>(found: T, account: AccountKey, server?: ServerStep): T =>
  server
    ? {
        ...found,
        server: server.report,
        items: found.items.map((hit) => ({
          ...hit,
          source:
            (keyOf(accountOf(hit)) === keyOf(account) && server.sources.get(sourceKey(hit.chatId, hit.id))) ||
            "archive",
        })),
      }
    : found

/** What a run is kept as: the query and options it was given — a regular expression as its source. */
const paramsOf = (command: SearchCommand, query: SearchQuery & { by?: StatsGrouping }): SearchParams => ({
  ...(query.pattern
    ? { text: query.pattern.source, regex: true }
    : query.text === undefined
      ? {}
      : { text: query.text }),
  ...(query.ast === undefined ? {} : { ast: query.ast }),
  ...(query.discover === undefined ? {} : { discover: query.discover }),
  ...(query.language === undefined ? {} : { language: query.language }),
  ...(query.chat === undefined ? {} : { chat: query.chat }),
  ...(query.source === undefined ? {} : { source: query.source }),
  ...(query.timezone === undefined ? {} : { timezone: query.timezone }),
  limit: query.limit,
  ...(command === "search"
    ? { newest: query.newest === true, ...(query.context === undefined ? {} : { context: query.context }) }
    : { by: query.by }),
})
export type MessagesSearchService = Pick<MessagesService, "search" | "searchAll" | "searchAllWithMeetings" | "stats">
export type MessagesSearchDeps = Pick<
  ServiceDeps,
  | "messenger"
  | "store"
  | "account"
  | "connection"
  | "withConnection"
  | "offline"
  | "reads"
  | "guard"
  | "history"
  | "searchCatchUp"
>

export const messagesSearchService = (deps: MessagesSearchDeps): MessagesSearchService => {
  const inStore = async <T>(read: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    read(await deps.store(), await deps.account())

  const serverThenStore = async (store: MessageStore, account: AccountKey, query: SearchQuery) => {
    const server = await searchServer(deps, query)
    const only =
      query.backend === "server" && server
        ? [...server.sources.keys()].map((key) => {
            const [chatId, id] = JSON.parse(key) as [Id, Id]
            return { ...account, chatId, id }
          })
        : undefined
    const found = await searchStore(store, account, only ? { ...query, only } : query, deps.messenger)
    return { found, server }
  }

  const unifiedMessages =
    (store: MessageStore, account: AccountKey) =>
    async (query: SearchQuery): Promise<SearchFound> => {
      await topUp(store)
      const { found, server } = await serverThenStore(store, account, query)
      return withServer(found, account, server)
    }

  /**
   * Only a run that answered is kept: a refused query is the caller's typo, not a search. The answer is
   * already in hand, so a history write that fails — the store busy under `serve` — never fails the search.
   */
  const remember = async (store: MessageStore, command: SearchCommand, query: SearchQuery & { by?: StatsGrouping }) => {
    if (deps.history === false) return
    await store
      .recordSearch(searchRecordOf(command, paramsOf(command, query)), {
        ...(query.saved === undefined ? {} : { saved: query.saved }),
      })
      .catch(() => undefined)
  }
  return {
    search: (request) => {
      if (request.discover && request.backend === "server")
        throw new CliError("validation_error", "discovery searches the local archive; use backend archive")
      const query: SearchQuery = {
        ...request,
        language: request.language ?? (request.pattern ? "legacy" : "lucene"),
        // Mail is only ever in the local store, and a saved search replays as `search messages`.
        ...(request.kind === "mail" || request.discover ? { backend: "archive" as const } : {}),
      }
      const opened =
        query.kind === "mail"
          ? crossAccount(deps, "search mail reads every mail account unless --account names one")
          : deps.store()
      return opened.then(async (store) => {
        const account = await deps.account()
        if (query.thread) threadBounds(query.thread)
        const refreshed = await refreshSearch(deps, query)
        // The server step reads the indexes to translate the query, so they are topped up first.
        if (query.backend !== undefined && query.backend !== "archive") await topUp(store)
        const { found, server } = await serverThenStore(store, account, query)
        if (query.kind !== "mail") await remember(store, "search", query)
        return withServer(withRefresh(found, refreshed), account, server)
      })
    },

    searchAll: (request) =>
      inStore((store, account) => searchAll(store, account, request, deps.messenger, unifiedMessages(store, account))),

    searchAllWithMeetings: (request) =>
      inStore((store, account) =>
        searchAllWithMeetings(store, account, request, deps.messenger, unifiedMessages(store, account)),
      ),

    stats: (request) => {
      const query: SearchQuery & { by: StatsGrouping } = {
        ...request,
        language: request.language ?? (request.pattern ? "legacy" : "lucene"),
      }
      return inStore(async (store, account) => {
        const refreshed = await refreshSearch(deps, query)
        const stats = await statsStore(store, account, query, deps.messenger)
        await remember(store, "stats", query)
        return withRefresh(stats, refreshed)
      })
    },
  }
}
