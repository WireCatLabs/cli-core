import { CliError } from "@wirecat/cli-base"
import { parseLocator } from "../domain/locator.js"
import { plainQuery } from "../search/lucene/plain.js"
import { isQueryLimit } from "../search/lucene/types.js"
import { respelled } from "../search/respell.js"
import { TOTAL_CAP, totalOf } from "../search/total.js"
import type { AccountKey, MessageStore, StoredHit } from "../store/store.js"
import type { Saved } from "./message-resolution.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { discoveryRequest, type MeaningLane, type RerankLane, searchDiscovery } from "./messages-discovery.js"
import { countLucene, type MessageStats, type StatsGrouping, searchLucene, statsLucene } from "./messages-search.js"
import { namedChat, queryWords, without } from "./named-chat.js"
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
  const typed = request.text
  const helped = await helpPlainWords(store, account, request, messenger)
  if (helped.text !== undefined) request = { ...request, text: plainQuery(helped.text) }
  const page = (asked: SearchQuery) =>
    searchPage(store, account, { ...asked, limit: asked.limit + offset }, messenger, meaning, rerank)
  const all = await page(request)
  const { named } = helped
  const inside =
    named && typed !== undefined
      ? await page({
          ...request,
          text: plainQuery(without(helped.text ?? typed, named.word) || typed),
          chat: named.chatId,
        })
      : undefined
  const shown = new Set(inside?.items.map(({ locator }) => locator))
  const found = inside
    ? {
        ...all,
        items: [...inside.items, ...all.items.filter(({ locator }) => !shown.has(locator))].slice(
          0,
          request.limit + offset,
        ),
      }
    : all
  const discovery = found.query?.discovery
  const total = discovery
    ? totalOf(discovery.candidates, found.items.length, found.hasMore, !discovery.truncated)
    : totalOf(
        await countLucene(
          store,
          account,
          { ...(request.discover ? discoveryRequest(request) : request), limit: request.limit + offset },
          messenger,
          TOTAL_CAP,
        ).catch((error: unknown) => {
          if (isQueryLimit(error)) return undefined
          throw error
        }),
        found.items.length,
        found.hasMore,
      )
  return {
    ...found,
    ...(named ? { named: { word: named.word, chatId: named.chatId, title: named.title } } : {}),
    ...(helped.respelled.size ? { respelled: Object.fromEntries(helped.respelled) } : {}),
    total,
    items: found.items.slice(offset),
    ...(found.hasMore && offset + request.limit <= MAX_SEARCH_OFFSET ? { nextOffset: offset + request.limit } : {}),
  }
}

// Plain words only: a query with fields, quotes, groups or operators says exactly what it wants.
const PLAIN = /^[\p{L}\p{N}\s,.?!]+$/u
const OPERATORS = /(?<![\p{L}\p{N}])(?:AND|OR|NOT)(?![\p{L}\p{N}])/u

/**
 * For a query of plain words over every chat: each word no message holds also searched as the words it may stand for
 * (`respelled`), and the private chat a word names (`namedChat`), searched first.
 */
const helpPlainWords = async (store: MessageStore, account: AccountKey, request: SearchQuery, messenger: Saved) => {
  const none = { text: request.text, respelled: new Map<string, string[]>(), named: undefined }
  const { text } = request
  if (text === undefined || request.exact || request.discover || request.kind === "mail" || request.only) return none
  const chat = /(?<!\S)chat:\S+/gu
  const bare = text.replace(chat, " ")
  if (!PLAIN.test(bare) || OPERATORS.test(bare)) return none
  const words = queryWords(bare)
  const respellings = await respelled(store.searchIndex, words)
  let helped = text
  for (const [word, forms] of respellings)
    helped = helped.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu"),
      `(${[word, ...forms].join(" OR ")})`,
    )
  const named =
    request.chat === undefined && bare === text
      ? await namedChat(store, account, messenger, request.accounts, words).catch((error: unknown) => {
          if (isQueryLimit(error)) return undefined
          throw error
        })
      : undefined
  return { text: helped, respelled: respellings, named }
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
