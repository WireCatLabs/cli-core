import { CliError } from "@wirecat/cli-base"
import { parseLocator } from "../domain/locator.js"
import type { AccountKey, MessageStore, StoredHit } from "../store/store.js"
import type { Saved } from "./message-resolution.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { type MeaningLane, type RerankLane, searchDiscovery } from "./messages-discovery.js"
import { type MessageStats, type StatsGrouping, searchLucene, statsLucene } from "./messages-search.js"
import { readThreadContext, threadBounds } from "./thread-context.js"

/** How long a search may spend building the word index, then the stems, first (phase 2 plan S3: about 200 ms). */
export const SEARCH_FILL_MS = 200

export const statsStore = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery & { by: StatsGrouping },
  messenger: Saved = {},
): Promise<MessageStats> => {
  const stop = Date.now() + SEARCH_FILL_MS
  await store.searchIndex.fillSearchIndex({ until: () => Date.now() >= stop })
  await store.searchIndex.fillStems({ until: () => Date.now() >= stop })
  return statsLucene(store, account, request, messenger)
}

const withThreads = async (store: MessageStore, found: SearchFound, request: SearchQuery): Promise<SearchFound> => {
  if (!request.thread) return found
  const items: FoundMessage[] = []
  for (const hit of found.items)
    items.push({
      ...hit,
      thread: await readThreadContext(store, accountOf(hit), hit.chatId, hit.id, {
        before: request.context ?? 0,
        after: request.context ?? 0,
        ...request.thread,
        signal: request.signal,
      }),
    })
  return { ...found, items }
}

/**
 * `search messages` over a store, from the account given — or from `query.accounts`, which a caller such
 * as a bot's search passes after checking it may read them.
 */
// A large file builds its word index a slice per search as well as in `store migrate` (NEED-453 A).
export const topUp = async (store: MessageStore) => {
  const stop = Date.now() + SEARCH_FILL_MS
  await store.searchIndex.fillSearchIndex({ until: () => Date.now() >= stop })
  await store.searchIndex.fillStems({ until: () => Date.now() >= stop })
}

/** How deep a search pages: each page reads every hit before it again. */
export const MAX_SEARCH_OFFSET = 1000

/**
 * Search the store, one page at a time: `offset` skips the hits a page before held, and `nextOffset` says where
 * the next page starts. A page is the hits up to `offset + limit` read again and cut, so deep pages cost more.
 */
export const searchStore = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Saved = {},
  meaning?: MeaningLane,
  rerank?: RerankLane,
): Promise<SearchFound> => {
  const offset = request.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET)
    throw new CliError("validation_error", `offset takes a whole number from 0 to ${MAX_SEARCH_OFFSET}`)
  const found = await searchPage(
    store,
    account,
    { ...request, limit: request.limit + offset },
    messenger,
    meaning,
    rerank,
  )
  return {
    ...found,
    items: found.items.slice(offset),
    ...(found.hasMore && offset + request.limit <= MAX_SEARCH_OFFSET ? { nextOffset: offset + request.limit } : {}),
  }
}

const searchPage = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Saved,
  meaning: MeaningLane | undefined,
  rerank: RerankLane | undefined,
): Promise<SearchFound> => {
  if (request.signal?.aborted)
    throw new CliError("validation_error", "search was aborted", { reason: "query.aborted", complete: false })
  if (request.thread) threadBounds(request.thread)
  if (request.discover !== undefined && typeof request.discover !== "boolean")
    throw new CliError("validation_error", "discover takes a boolean")
  if (request.discover && request.backend === "server")
    throw new CliError("validation_error", "discovery searches the local archive; use backend archive")
  await topUp(store)
  const found = request.discover
    ? await searchDiscovery(store, account, { ...request, thread: undefined }, messenger, meaning, rerank)
    : await searchLucene(store, account, request, messenger)
  return withThreads(store, found, request)
}

export const accountOf = (hit: StoredHit): AccountKey => {
  const { provider, account } = parseLocator(hit.locator)
  return { provider, account }
}

export const keyOf = ({ provider, account }: AccountKey) => `${provider}/${account}`
