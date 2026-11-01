import { CliError } from "@wirecat/cli-base"
import { parseLucene, type QueryNode } from "@wirecat/cli-base/query"
import type { SearchHit } from "../meetings/index.js"
import { formatMeetingReference } from "../meetings/index.js"
import { entriesOfList, fitting } from "../search/account-list.js"
import { SEARCH_QUERY } from "../search/lucene/types.js"
import { codeOf } from "../sends/guarded.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { SearchFound, SearchQuery } from "./messages.js"
import { MAX_SEARCH_OFFSET } from "./messages-archive-search.js"
import type { MeaningLane } from "./messages-discovery.js"
import { RRF_K } from "./notes-search.js"
import {
  RESOURCES_SEARCHED,
  type SearchAllFound,
  type SearchAllItem,
  type SearchAllMessenger,
  type SearchAllRequest,
  type SearchedResource,
  type Skipped,
  searchAll,
} from "./search-all.js"
import { listContextOf } from "./search-kind.js"

export const RESOURCES_SEARCHED_WITH_MEETINGS = [...RESOURCES_SEARCHED, "meetings"] as const
export type ResourceWithMeetings = (typeof RESOURCES_SEARCHED_WITH_MEETINGS)[number]
export interface MeetingSearchItem {
  kind: "meeting"
  /** `meeting:<account id>/<meeting id>`, the reference memo's notes, facts and memories cite as evidence. */
  ref: string
  provider: string
  account: string
  accountId: number
  title: string | null
  timestamp: string | null
  text: string
  meetingId: number
  scope: SearchHit["scope"]
  id: number
  startMs: number | null
  /** A transcript hit's cue, `meeting:<account>/<meeting>/<transcript>/<cue>`, which `meetings passage` opens. */
  cueRef?: string
  speakerName?: string | null
}
export interface MeetingSearchCursor {
  accountId: number
  /** The supported query's words, bound to the selected account. */
  query: string
  meetingOffset: number
  hitOffset: number
}
export interface SearchAllIncludingMeetingsRequest extends Omit<SearchAllRequest, "only"> {
  only?: readonly ResourceWithMeetings[]
  /** Defaults to the caller's selected account; other meeting accounts are explicit. */
  meetingAccount?: AccountKey
  /**
   * Candidate meetings visited, newest first, not hit rows allocated by the store. Defaults to 100; `all` visits
   * every one. Meetings have no search index yet, so each visit is two queries.
   */
  maxMeetings?: number | "all"
  /** Source continuation only: requires only: ["meetings"]. Offsets are not a snapshot. */
  meetingCursor?: MeetingSearchCursor
}
export interface MeetingSearchCoverage {
  accountId: number
  by: "word-prefixes"
  meetingsScanned: number
  complete: boolean
  nextCursor?: MeetingSearchCursor
}
export interface SearchAllIncludingMeetingsFound
  extends Omit<SearchAllFound, "items" | "searched" | "skipped" | "hasMore"> {
  items: (SearchAllItem | MeetingSearchItem)[]
  /** null means a bounded meeting scan did not prove whether another match exists. */
  hasMore: boolean | null
  searched: ResourceWithMeetings[]
  skipped: Skipped<ResourceWithMeetings>[]
  meetings?: MeetingSearchCoverage
}

const whole = (value: number, minimum: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new CliError("validation_error", `${label} must be an integer from ${minimum} through ${maximum}`)
  return value
}
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "search was cancelled", { complete: false })
}
const meetingQuery = (text: string, exact?: boolean): { query: string } | { reason: string } => {
  if (exact) return { reason: "meetings use word prefixes and cannot answer --exact" }
  try {
    const terms: string[] = []
    const supported = (node: QueryNode): boolean => {
      if (node.kind === "boolean") return node.clauses.every(({ occur, node }) => occur === "must" && supported(node))
      if (node.field !== "text" || node.operator !== "term" || !/^[\p{L}\p{N}]+$/u.test(node.value)) return false
      terms.push(node.value)
      return true
    }
    if (!supported(parseLucene(text, SEARCH_QUERY).root) || !terms.length)
      return {
        reason:
          "meetings support letter/digit words joined by AND; phrases, OR/NOT, patterns and filters are unsupported",
      }
    return { query: terms.join(" ") }
  } catch (error) {
    if (codeOf(error) !== "validation_error") throw error
    return { reason: error instanceof Error ? error.message : "invalid meeting search query" }
  }
}
interface CollectedMeetings {
  items: { item: MeetingSearchItem; before: MeetingSearchCursor }[]
  coverage: Omit<MeetingSearchCoverage, "nextCursor">
  after: MeetingSearchCursor
}
const collectMeetings = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllIncludingMeetingsRequest,
  query: string,
): Promise<CollectedMeetings> => {
  cancelled(request.signal)
  const selected = await store.accounts.storedAccount(account)
  cancelled(request.signal)
  whole(selected.id, 1, Number.MAX_SAFE_INTEGER, "meeting account id")
  if (account.scope !== undefined && selected.scope !== account.scope)
    throw new CliError("not_found", "the selected meeting account has a different scope")
  const cursor = request.meetingCursor
  if (cursor && (cursor.accountId !== selected.id || cursor.query !== query))
    throw new CliError("validation_error", "meeting cursor belongs to a different account or query")
  let meetingOffset = cursor?.meetingOffset ?? 0
  let hitOffset = cursor?.hitOffset ?? 0
  const position = (): MeetingSearchCursor => ({ accountId: selected.id, query, meetingOffset, hitOffset })
  const collected: CollectedMeetings = {
    items: [],
    coverage: { accountId: selected.id, by: "word-prefixes", meetingsScanned: 0, complete: false },
    after: position(),
  }
  const seen = new Set<string>()
  const most = request.maxMeetings === "all" ? Number.POSITIVE_INFINITY : (request.maxMeetings ?? 100)
  while (collected.coverage.meetingsScanned < most) {
    cancelled(request.signal)
    const page = await store.meetings.meetings({ accountId: selected.id, limit: 2, offset: meetingOffset })
    cancelled(request.signal)
    const meeting = page[0]
    if (!meeting) {
      collected.coverage.complete = true
      break
    }
    const hits = await store.meetings.search(query, { accountId: selected.id, limit: 1, offset: meetingOffset })
    cancelled(request.signal)
    if (
      meeting.accountId !== selected.id ||
      meeting.deletedAt !== null ||
      hits.some((hit) => hit.meetingId !== meeting.id)
    )
      throw new CliError("validation_error", "meeting archive changed during search; restart from the first page", {
        complete: false,
      })
    if (hitOffset > hits.length)
      throw new CliError("validation_error", "meeting cursor is past the current hit list; restart from the first page")
    collected.coverage.meetingsScanned++
    for (; hitOffset < hits.length; hitOffset++) {
      const hit = hits[hitOffset] as SearchHit
      const key = JSON.stringify([selected.id, hit.meetingId, hit.scope, hit.id])
      if (seen.has(key)) continue
      seen.add(key)
      collected.items.push({
        before: position(),
        item: {
          kind: "meeting",
          ref: formatMeetingReference({ type: "meeting", accountId: selected.id, meetingId: hit.meetingId }),
          provider: selected.provider,
          account: selected.account,
          accountId: selected.id,
          title: meeting.title,
          timestamp: meeting.startedAt === null ? null : new Date(meeting.startedAt).toISOString(),
          text: hit.text.slice(0, 2000),
          meetingId: hit.meetingId,
          scope: hit.scope,
          id: hit.id,
          startMs: hit.startMs,
          ...(hit.scope === "transcript" && hit.ref !== undefined
            ? { cueRef: hit.ref, speakerName: hit.speakerName ?? null }
            : {}),
        },
      })
      if (collected.items.length > request.limit) {
        hitOffset++
        break
      }
    }
    if (hitOffset === hits.length) {
      meetingOffset++
      hitOffset = 0
      if (page.length < 2) collected.coverage.complete = true
    }
    collected.after = position()
    if (collected.coverage.complete || collected.items.length > request.limit) break
  }
  return collected
}

/** Opt-in fusion of the existing unified ranking and one explicitly scoped meeting archive. */
export const searchAllIncludingMeetings = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllIncludingMeetingsRequest,
  messenger: SearchAllMessenger = {},
  searchMessages?: (query: SearchQuery) => Promise<SearchFound>,
  meaning?: MeaningLane,
): Promise<SearchAllIncludingMeetingsFound> => {
  whole(request.limit, 1, 1000, "limit")
  if (request.maxMeetings !== "all") whole(request.maxMeetings ?? 100, 1, Number.MAX_SAFE_INTEGER, "maxMeetings")
  const only = request.only ?? RESOURCES_SEARCHED_WITH_MEETINGS
  if (
    !only.length ||
    only.some((resource) => !(RESOURCES_SEARCHED_WITH_MEETINGS as readonly string[]).includes(resource))
  )
    throw new CliError("validation_error", "only takes messages, mail, notes, events and meetings")
  if (request.meetingCursor) {
    if (only.length !== 1 || only[0] !== "meetings")
      throw new CliError("validation_error", "meeting cursor requires only: [meetings]")
    whole(request.meetingCursor.accountId, 1, Number.MAX_SAFE_INTEGER, "cursor account id")
    whole(request.meetingCursor.meetingOffset, 0, Number.MAX_SAFE_INTEGER - 2, "cursor meeting offset")
    whole(request.meetingCursor.hitOffset, 0, Number.MAX_SAFE_INTEGER, "cursor hit offset")
  }
  cancelled(request.signal)
  const others = { ...request, only: only.filter((one): one is SearchedResource => one !== "meetings") }
  if (!only.includes("meetings")) {
    const found = await searchAll(store, account, others, messenger, searchMessages, meaning)
    cancelled(request.signal)
    return found
  }
  // Meetings rank with the rest, so a later page is the same merge read deeper, then cut.
  const offset = request.offset ?? 0
  const window = offset + request.limit
  const legacy = await searchAll(
    store,
    account,
    { ...others, offset: 0, limit: window },
    messenger,
    searchMessages,
    meaning,
  )
  cancelled(request.signal)
  const compiled = meetingQuery(request.text, request.exact)
  if ("reason" in compiled)
    return {
      ...legacy,
      items: legacy.items.slice(offset),
      skipped: [...legacy.skipped, { resource: "meetings", code: "validation_error", reason: compiled.reason }],
    }
  let meetings: CollectedMeetings
  const meetingAccount = request.meetingAccount ?? account
  try {
    meetings = await collectMeetings(store, meetingAccount, { ...request, limit: window }, compiled.query)
  } catch (error) {
    if (codeOf(error) !== "not_found") throw error
    return {
      ...legacy,
      items: legacy.items.slice(offset),
      skipped: [
        ...legacy.skipped,
        { resource: "meetings", code: "not_found", reason: "the selected meeting account is not stored" },
      ],
    }
  }
  const ranked = new Map<string, { item: SearchAllItem | MeetingSearchItem; score: number }>()
  for (const list of [legacy.items, meetings.items.map(({ item }) => item)])
    list.forEach((item, rank) => {
      const key =
        item.kind === "meeting"
          ? JSON.stringify([item.kind, item.accountId, item.meetingId, item.scope, item.id])
          : item.ref
      const held = ranked.get(key) ?? { item, score: 0 }
      held.score += 1 / (RRF_K + rank + 1)
      ranked.set(key, held)
    })
  const ordered = [...ranked.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  const items = ordered.slice(offset, window)
  const returnedMeetings = ordered.slice(0, window).filter((item) => item.kind === "meeting").length
  const nextCursor =
    meetings.items[returnedMeetings]?.before ?? (!meetings.coverage.complete ? meetings.after : undefined)
  const more = legacy.hasMore || ordered.length > window
  const { nextOffset: _, ...rest } = legacy
  return {
    ...rest,
    items,
    hasMore: more ? true : meetings.coverage.complete ? false : null,
    ...(more && window <= MAX_SEARCH_OFFSET ? { nextOffset: window } : {}),
    searched: [...legacy.searched, "meetings"],
    accounts: [
      ...legacy.accounts,
      { resource: "meetings", provider: meetingAccount.provider, account: meetingAccount.account },
    ],
    meetings: { ...meetings.coverage, ...(nextCursor ? { nextCursor } : {}) },
  }
}

export interface SearchAllWithMeetingsRequest extends Omit<SearchAllIncludingMeetingsRequest, "meetingAccount"> {
  /**
   * `--source`: each kind reads the accounts the list names of it and a kind it names none of is skipped.
   * Meetings are read only when it names a meeting account; without it they are skipped.
   */
  source?: string
}

/** Meetings have no index to search every account at once, so they are read only when named. */
export const MEETINGS_UNNAMED = "meetings are searched only when --source names a meeting account, zoom or meetings"

/** `search all`: every kind but meetings, unless `--source` names a meeting account. */
export const searchAllWithMeetings = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllWithMeetingsRequest,
  messenger: SearchAllMessenger = {},
  searchMessages?: (query: SearchQuery) => Promise<SearchFound>,
  meaning?: MeaningLane,
): Promise<SearchAllIncludingMeetingsFound> => {
  if (request.source !== undefined)
    return searchAllOfSource(store, account, request.source, request, messenger, searchMessages, meaning)
  const only = request.only ?? RESOURCES_SEARCHED_WITH_MEETINGS
  if (only.length === 1 && only[0] === "meetings")
    throw new CliError("validation_error", `--only meetings: ${MEETINGS_UNNAMED}`)
  if (request.maxMeetings !== undefined) throw new CliError("validation_error", `--max-meetings: ${MEETINGS_UNNAMED}`)
  const found = await searchAll(
    store,
    account,
    { ...request, only: only.filter((resource): resource is SearchedResource => resource !== "meetings") },
    messenger,
    searchMessages,
    meaning,
  )
  return only.includes("meetings")
    ? {
        ...found,
        skipped: [...found.skipped, { resource: "meetings", code: "validation_error", reason: MEETINGS_UNNAMED }],
      }
    : found
}

/** Of several meeting accounts, the ones that hold meetings: a bare `zoom` names every row, signed in or not. */
const holdingMeetings = async (store: MessageStore, named: AccountKey[]): Promise<AccountKey[]> => {
  if (named.length < 2) return named
  const holding: AccountKey[] = []
  for (const key of named) {
    const { id } = await store.accounts.storedAccount(key)
    if ((await store.meetings.meetings({ accountId: id, limit: 1 })).length) holding.push(key)
  }
  return holding.length ? holding : named
}

const searchAllOfSource = async (
  store: MessageStore,
  account: AccountKey,
  source: string,
  request: SearchAllWithMeetingsRequest,
  messenger: SearchAllMessenger,
  searchMessages?: (query: SearchQuery) => Promise<SearchFound>,
  meaning?: MeaningLane,
): Promise<SearchAllIncludingMeetingsFound> => {
  const only = request.only ?? RESOURCES_SEARCHED_WITH_MEETINGS
  const entries = entriesOfList(source, await listContextOf(store, account, messenger.app))
  const { skipped } = fitting(entries, only, "search all", (kind) => `--only leaves ${kind} out`)
  const named = (resource: ResourceWithMeetings): AccountKey[] => [
    ...new Map(
      entries
        .flatMap(({ accounts }) => accounts)
        .filter(({ kind }) => kind === resource)
        .map(({ provider, account }) => [`${provider}\u0000${account}`, { provider, account }] as const),
    ).values(),
  ]
  const meetings = await holdingMeetings(store, named("meetings"))
  const empty = named("meetings")
    .filter((one) => !meetings.some(({ provider, account }) => provider === one.provider && account === one.account))
    .map(({ provider, account }) => ({
      source: `${provider}:${account}`,
      code: "not_found" as const,
      reason: "no meetings stored for it",
    }))
  if (only.includes("meetings") && meetings.length > 1)
    throw new CliError(
      "validation_error",
      `--source names several meeting accounts; search all reads one: ${meetings.map(({ provider, account }) => `${provider}:${account}`).join(", ")}`,
    )
  const read = only.filter((resource) => named(resource).length > 0)
  if (read.includes("meetings") && request.offset !== undefined)
    throw new CliError("validation_error", "--offset pages messages, mail and notes; not with a meeting account yet")
  const found = await searchAllIncludingMeetings(
    store,
    account,
    {
      ...request,
      only: read,
      scope: {
        messages: named("messages"),
        mail: named("mail"),
        notes: named("notes"),
        events: named("events"),
      },
      ...(meetings[0] ? { meetingAccount: meetings[0] } : {}),
    },
    messenger,
    searchMessages,
    meaning,
  )
  const unnamed = only
    .filter((resource) => !read.includes(resource))
    .map((resource) => ({ resource, code: "not_found" as const, reason: `--source names no ${resource} account` }))
  return { ...found, skipped: [...skipped, ...empty, ...unnamed, ...found.skipped] }
}
