import { CliError } from "@wirecat/cli-base"
import { holdsKind } from "../domain/providers.js"
import type { WarmEmbedders } from "../embeddings/embed.js"
import { meaningFloor } from "../embeddings/models.js"
import { plainQuery } from "../search/lucene/plain.js"
import { questionLookup, questionText } from "../search/question-plan.js"
import type { EventHit, NearestEvent } from "../store/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { excerpt } from "./excerpt.js"
import { meaningModel } from "./meaning-model.js"
import { localModel, RRF_K, storeQuery, withLocal } from "./notes-search.js"
import { plainQueryWords } from "./notes-title-tier.js"

export interface EventsQuery {
  limit?: number
  offset?: number
  /** Calendar accounts to read; every one the store holds when absent. */
  accounts?: readonly AccountKey[]
  /** Every word as written: no stems. */
  exact?: boolean
  /** A question typed as a sentence finds what holds some of its words, as `search messages --discover` does. */
  discover?: boolean
  /** Latest start first instead of best first. */
  newest?: boolean
  /** For `date:`, which reads an event's start — the zone a bare day is read in. */
  timezone?: string
  signal?: AbortSignal
  /** How many matching events are read before grouping; for tests. */
  candidates?: number
  env?: NodeJS.ProcessEnv
  /** The tool's command, named in the hint when the model is missing. */
  command?: string
  /** The search's own models, when another part of it loads the same one. */
  embedders?: Pick<WarmEmbedders, "get">
}

export interface FoundEvent {
  /** `event:<id>`, of the occurrence shown: of a series, the match nearest now that is not cancelled. */
  ref: string
  /** The calendar account it is in; `null` for an event no calendar holds, such as a Zoom meeting's own. */
  provider: string | null
  account: string | null
  title: string | null
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  /** confirmed, tentative or cancelled. */
  status: string | null
  location: string | null
  /** The event's page at the calendar. */
  url?: string
  /** Around the first word of the query in its description, place and attendees. */
  excerpt: string
  /** How many occurrences of its series matched; 1 for an event that does not repeat. */
  occurrences: number
  /** When the store's copy last changed. */
  updated_at: string
  found_by: ("words" | "meaning")[]
  /** The cosine of its series' nearest piece, when meaning found it: comparable with other records under the same model. */
  meaning_score?: number
}

export interface EventsFound {
  query: string
  /** Words and word stems always; meaning too when the model is there and the query is plain words. */
  by: "words" | "words and meaning"
  /** Why meaning was not searched, when it was not. */
  meaning_skipped?: string
  items: FoundEvent[]
  hasMore: boolean
  /** More events matched than one search reads (50,000); the later ones were not read — narrow the query. */
  truncated?: true
  nextOffset?: number
}

const MAX_EVENTS_OFFSET = 1000

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())

/** The stored ids of the calendar accounts named; a name the store does not hold reads nothing. */
const accountIdsOf = async (store: MessageStore, accounts: readonly AccountKey[]): Promise<string[]> => {
  const held = await store.accounts.storedAccounts()
  return held
    .filter((one) => accounts.some(({ provider, account }) => one.provider === provider && one.account === account))
    .map(({ id }) => String(id))
}

/** The calendar accounts the store holds: every account whose provider is of the `events` kind. */
export const calendarAccounts = async (store: MessageStore): Promise<AccountKey[]> =>
  (await store.accounts.storedAccounts())
    .filter(({ provider }) => holdsKind(provider, "events"))
    .map(({ provider, account }) => ({ provider, account }))

export const foundEvent = (
  hit: Omit<EventHit, "relevance">,
  query: string,
  foundBy: FoundEvent["found_by"],
): FoundEvent => ({
  ref: hit.ref,
  provider: hit.account?.provider ?? null,
  account: hit.account?.account ?? null,
  title: hit.event.title,
  starts_at: iso(hit.event.startsAt),
  ends_at: iso(hit.event.endsAt),
  all_day: hit.event.allDay === true,
  status: hit.event.status ?? null,
  location: hit.event.location,
  ...(hit.url ? { url: hit.url } : {}),
  excerpt: excerpt(hit.text || (hit.event.title ?? ""), query),
  occurrences: hit.occurrences,
  updated_at: new Date(hit.event.updatedAt).toISOString(),
  found_by: foundBy,
})

/** How deep each half is read before the two are merged. */
const CANDIDATES = 50

/** Events nearest in meaning to plain words, one per series, best first; only events already embedded are found. */
const nearestEvents = async (
  store: MessageStore,
  words: string,
  {
    limit,
    accountIds,
    env,
    command,
    embedders,
  }: Pick<EventsQuery, "env" | "command" | "embedders"> & { limit: number; accountIds?: string[] },
): Promise<NearestEvent[]> => {
  const { model, directory, key } = localModel(await meaningModel(store, env), env, command)
  if (!(await store.calendar.embedded(key, accountIds ? { accountIds } : {})))
    throw new CliError("not_found", `no event has vectors of ${model.id} yet, so only words were matched`)
  const [vector] = await withLocal(
    model,
    directory,
    undefined,
    (embedder) => embedder.embed([words], "query"),
    embedders,
  )
  const floor = meaningFloor(key)
  return (
    await store.calendar.nearest(key, vector as Float32Array, { limit, ...(accountIds ? { accountIds } : {}) })
  ).filter(({ score }) => score > floor)
}

/** One hit per series, whichever half found it. */
const keyOf = ({ event }: { event: EventHit["event"] }) =>
  event.eventSeriesId === null ? `e${event.id}` : `s${event.eventSeriesId}`

/**
 * Calendar events by words and, when the local text model is there and the query is plain words, by meaning, merged
 * by reciprocal rank: title, cleaned description, place and attendees' names. The occurrences of one series are one
 * hit. Working location, focus time, out of office, birthdays and busy-only slots are never found.
 */
export const searchEvents = async (
  store: MessageStore,
  query: string,
  {
    limit = 20,
    offset = 0,
    accounts,
    exact,
    discover,
    newest,
    timezone,
    signal,
    candidates,
    env,
    command,
    embedders,
  }: EventsQuery = {},
): Promise<EventsFound> => {
  if (!query.trim()) throw new CliError("validation_error", "say what to find in the events")
  query = plainQuery(query)
  const asked = discover && !exact && !newest ? questionLookup(query) : undefined
  const { root, stemmer } = await storeQuery(store, asked ?? query, {
    ...(exact ? { exact: true } : {}),
    ...(timezone === undefined ? {} : { timezone }),
  })
  const accountIds = accounts === undefined ? undefined : await accountIdsOf(store, accounts)
  if (accountIds?.length === 0) return { query, by: "words", items: [], hasMore: false }
  const words = plainQueryWords(asked === undefined ? query : questionText(query))
  const window = offset + limit
  let meaningSkipped: string | undefined
  let meaning: NearestEvent[] | undefined
  if (exact) meaningSkipped = "--exact searches words as written"
  else if (newest) meaningSkipped = "newest first orders by time"
  else if (words === undefined) meaningSkipped = "the query has fields or operators, which meaning cannot follow"
  else
    try {
      meaning = await nearestEvents(store, words, {
        limit: Math.max(window, CANDIDATES),
        ...(accountIds ? { accountIds } : {}),
        ...(env === undefined ? {} : { env }),
        ...(command === undefined ? {} : { command }),
        ...(embedders === undefined ? {} : { embedders }),
      })
    } catch (error) {
      if (!(error instanceof CliError && error.code === "not_found")) throw error
      meaningSkipped = error.message
    }
  const found = await store.calendar.search({
    root,
    limit: meaning === undefined ? limit : Math.max(window, CANDIDATES),
    offset: meaning === undefined ? offset : 0,
    ...(accountIds === undefined ? {} : { accountIds }),
    ...(newest ? { newest: true } : {}),
    ...(stemmer ? { stemmer } : {}),
    ...(signal ? { signal } : {}),
    ...(candidates === undefined ? {} : { candidates }),
  })
  const truncated = found.truncated ? { truncated: true as const } : {}
  const by = meaning === undefined ? "words" : "words and meaning"
  const skipped = meaningSkipped === undefined ? {} : { meaning_skipped: meaningSkipped }
  if (meaning === undefined)
    return {
      query,
      by,
      ...skipped,
      items: found.items.map((hit) => foundEvent(hit, query, ["words"])),
      hasMore: found.hasMore,
      ...(found.hasMore && window <= MAX_EVENTS_OFFSET ? { nextOffset: window } : {}),
      ...truncated,
    }
  const ranked = new Map<string, { hit: Omit<EventHit, "relevance">; score: number; by: FoundEvent["found_by"] }>()
  const add = (list: Omit<EventHit, "relevance">[], half: "words" | "meaning") =>
    list.forEach((hit, rank) => {
      const held = ranked.get(keyOf(hit)) ?? { hit, score: 0, by: [] }
      held.score += 1 / (RRF_K + rank + 1)
      held.by.push(half)
      ranked.set(keyOf(hit), held)
    })
  add(found.items, "words")
  add(meaning, "meaning")
  const cosines = new Map(meaning.map((hit) => [keyOf(hit), hit.score]))
  const ordered = [...ranked.values()].sort((a, b) => b.score - a.score)
  const hasMore = ordered.length > window || found.hasMore
  return {
    query,
    by,
    items: ordered.slice(offset, window).map(({ hit, by: halves }) => {
      const cosine = cosines.get(keyOf(hit))
      return { ...foundEvent(hit, query, halves), ...(cosine === undefined ? {} : { meaning_score: cosine }) }
    }),
    hasMore: hasMore,
    ...(hasMore && window <= MAX_EVENTS_OFFSET ? { nextOffset: window } : {}),
    ...truncated,
  }
}
