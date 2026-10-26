import { CliError } from "@wirecat/cli-base"
import { kindIn } from "../domain/providers.js"
import type { EventHit } from "../store/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { excerpt } from "./excerpt.js"
import { storeQuery } from "./notes-search.js"

export interface EventsQuery {
  limit?: number
  offset?: number
  /** Calendar accounts to read; every one the store holds when absent. */
  accounts?: readonly AccountKey[]
  /** Every word as written: no stems. */
  exact?: boolean
  /** Latest start first instead of best first. */
  newest?: boolean
  /** For `date:`, which reads an event's start — the zone a bare day is read in. */
  timezone?: string
  signal?: AbortSignal
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
}

export interface EventsFound {
  query: string
  hits: FoundEvent[]
  has_more: boolean
  next_offset?: number
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
    .filter(({ provider }) => kindIn(provider) === "events")
    .map(({ provider, account }) => ({ provider, account }))

export const foundEvent = (hit: EventHit, query: string, foundBy: FoundEvent["found_by"]): FoundEvent => ({
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

/**
 * Calendar events by words, in the query language messages use: title, cleaned description, place and attendees'
 * names. The occurrences of one series are one hit. Working location, focus time, out of office and birthdays are
 * never found.
 */
export const searchEvents = async (
  store: MessageStore,
  query: string,
  { limit = 20, offset = 0, accounts, exact, newest, timezone, signal }: EventsQuery = {},
): Promise<EventsFound> => {
  if (!query.trim()) throw new CliError("validation_error", "say what to find in the events")
  const { root, stemmer } = await storeQuery(store, query, {
    ...(exact ? { exact: true } : {}),
    ...(timezone === undefined ? {} : { timezone }),
  })
  const accountIds = accounts === undefined ? undefined : await accountIdsOf(store, accounts)
  if (accountIds?.length === 0) return { query, hits: [], has_more: false }
  const found = await store.calendar.search({
    root,
    limit,
    offset,
    ...(accountIds === undefined ? {} : { accountIds }),
    ...(newest ? { newest: true } : {}),
    ...(stemmer ? { stemmer } : {}),
    ...(signal ? { signal } : {}),
  })
  const window = offset + limit
  return {
    query,
    hits: found.items.map((hit) => foundEvent(hit, query, ["words"])),
    has_more: found.hasMore,
    ...(found.hasMore && window <= MAX_EVENTS_OFFSET ? { next_offset: window } : {}),
  }
}
