import { CliError, type ErrorCode } from "@wirecat/cli-base"
import { parseLucene, type QueryNode } from "@wirecat/cli-base/query"
import { parseLocator } from "../domain/locator.js"
import type { MailFields } from "../domain/models.js"
import { INTERNAL_NOTES, kindIn } from "../domain/providers.js"
import { runEmbedders } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL } from "../embeddings/models.js"
import type { MessengerTraits } from "../ports/traits.js"
import { MESSAGE_PARSING } from "../search/lucene/types.js"
import { planQuestion } from "../search/question-plan.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { calendarAccounts, searchEvents } from "./events-search.js"
import { excerpt } from "./excerpt.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { MAX_SEARCH_OFFSET, searchStore } from "./messages-archive-search.js"
import { type MeaningLane, type MeaningSkipped, nearEligible } from "./messages-discovery.js"
import { notesScopeOf, RRF_K, searchNotes } from "./notes-search.js"
import type { Backend, ServerOptions, ServerSearched } from "./server-search.js"

export const RESOURCES_SEARCHED = ["messages", "mail", "notes", "events"] as const
export type SearchedResource = (typeof RESOURCES_SEARCHED)[number]

export interface SearchAllItem {
  kind: "message" | "mail" | "note" | "document" | "event"
  /** `msg:…` for a message or a mail, `note:…` for a note, `event:…` for a calendar event. */
  ref: string
  provider: string
  /** The account it was found in; a note's folder id, or `internal` for a note written in memo. */
  account: string
  /** The chat, the mail thread's subject, the note's or the event's title. */
  url?: string
  title: string | null
  timestamp: string
  /** An excerpt around the match: a note's matching line, about 240 characters of a message or mail. */
  text: string
  /** Who wrote it; `ref` is the `person:` reference where the store has one. A note has none. */
  from?: { name: string | null; ref: string | null }
  /** A mail's people, labels and thread, as `search mail` gives them. */
  email?: MailFields
  /** Which search found it: words, meaning or both. */
  foundBy: ("title" | "words" | "meaning")[]
}

/** One account a search read, by the kind it was read for: the shape memo's `search all` answers too. */
export interface SearchedAccount {
  resource: string
  provider: string
  account: string
}

/** A resource not read, or a `--source` entry naming no account the search reads. */
export type Skipped<R extends string> = { code: ErrorCode; reason: string } & (
  | { resource: R; source?: undefined }
  | { source: string; resource?: undefined }
)

export interface SearchAllFound {
  query: string
  items: SearchAllItem[]
  hasMore: boolean
  /** Where the next page starts, as `offset`; absent on the last page. */
  nextOffset?: number
  searched: SearchedResource[]
  /** Every account read, kind by kind. */
  accounts: SearchedAccount[]
  /** A resource the query could not be asked of, and why: a field it lacks, or nothing stored yet. */
  skipped: Skipped<SearchedResource>[]
  /** How the notes were searched, when they were. */
  notes?: { by: "words" | "words and meaning"; meaningSkipped?: string }
  /** How the messages were searched, when they were; never by meaning with `exact` or the server alone. */
  messages?: { by: "words" | "words and meaning"; meaningSkipped?: MeaningSkipped }
  /** The messenger's server step for messages, as `search messages` reports it. */
  server?: ServerSearched
}

export interface SearchAllRequest {
  text: string
  limit: number
  /** Skip this many of the merged hits: the `nextOffset` of the page before. */
  offset?: number
  only?: readonly SearchedResource[]
  exact?: boolean
  timezone?: string
  /** For messages only; mail, notes and events are always the local store's. */
  backend?: Backend
  server?: ServerOptions
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** The accounts `--source` chose, per kind; a kind left out reads every account of its own. */
  scope?: Partial<Record<SearchedResource, AccountKey[]>>
}

/** A query a resource cannot answer is skipped with its reason, never a failure of the whole search. */
const skippable = (error: unknown): error is CliError =>
  error instanceof CliError && (error.code === "validation_error" || error.code === "not_found")

export type SearchAllMessenger = Partial<Pick<MessengerTraits, "savedChatId" | "app">> & {
  /**
   * The tool named in a model-download hint, when it is not `app.command`: memo passes tg's identity for `group:`
   * lists but has no `models` command. `null` names the tools that have one.
   */
  hintCommand?: string | null
}

/**
 * The filters the meaning hits must pass, or `undefined` when they cannot be followed: a NOT anywhere (meaning would
 * bring the excluded back), or a filter under OR or in a group, which the plain list of filters would turn into AND.
 */
const filtersBeside = (text: string): string | undefined => {
  const { root } = parseLucene(text, MESSAGE_PARSING)
  const followable = (node: QueryNode, required: boolean): boolean =>
    node.kind === "boolean"
      ? node.clauses.every(({ node: inner, occur }) => occur !== "must_not" && followable(inner, false))
      : node.kind === "predicate" && (required || node.field === "text" || node.field === "exact")
  const top = root.kind === "boolean" ? root.clauses : [{ node: root, occur: "must" as const }]
  return top.every(({ node, occur }) => occur !== "must_not" && followable(node, occur === "must"))
    ? planQuestion(text).scope
    : undefined
}

/**
 * `search all`: messages, mail, notes and calendar events from the local store — messages also from the messenger's
 * server, as `search messages` asks it — each list best first, merged by reciprocal rank so no
 * resource's own scores have to be compared with another's. Events are read only when the store holds a calendar.
 */
export const searchAll = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllRequest,
  messenger: SearchAllMessenger = {},
  searchMessages: (query: SearchQuery) => Promise<SearchFound> = (query) =>
    searchStore(store, account, query, messenger),
  meaning?: MeaningLane,
): Promise<SearchAllFound> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find")
  const offset = request.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET)
    throw new CliError("validation_error", `offset takes a whole number from 0 to ${MAX_SEARCH_OFFSET}`)
  // Each resource is read deep enough for the merged page, then the merge is cut.
  const window = offset + request.limit
  const only = request.only ?? RESOURCES_SEARCHED
  const command = messenger.hintCommand === undefined ? messenger.app?.command : (messenger.hintCommand ?? undefined)
  const lists: SearchAllItem[][] = []
  const searched: SearchedResource[] = []
  const accounts: SearchedAccount[] = []
  const skipped: SearchAllFound["skipped"] = []
  let hasMore = false
  let notes: SearchAllFound["notes"]
  let messagesBy: SearchAllFound["messages"]
  let server: ServerSearched | undefined

  const messagesOf = async (kind: "messages" | "mail") => {
    const given = request.scope?.[kind]
    const query: SearchQuery = {
      text: request.text,
      kind,
      ...(given ? { accounts: given } : {}),
      ...(kind === "messages"
        ? {
            // Server hits are matched by chat and message id, which another account can share.
            ...(request.backend === "server" || given ? {} : { source: "all" }),
            ...(request.backend === undefined ? {} : { backend: request.backend }),
            ...(request.server === undefined ? {} : { server: request.server }),
          }
        : {}),
      limit: window,
      ...(request.exact ? { exact: true } : {}),
      ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    // Messages go the way `search messages` goes, server included, so `search all` finds whatever it finds.
    const found =
      kind === "messages" ? await searchMessages(query) : await searchStore(store, account, query, messenger)
    if (found.server) server = found.server
    hasMore ||= found.hasMore
    const read =
      found.coverage?.accounts ??
      given ??
      (await store.accounts.accounts()).filter(({ provider }) => kindIn(provider) === kind)
    for (const one of found.skipped ?? []) if (!skipped.some(({ source }) => source === one.source)) skipped.push(one)
    accounts.push(...read.map(({ provider, account }) => ({ resource: kind, provider, account })))
    const itemOf = (hit: FoundMessage, foundBy: SearchAllItem["foundBy"]): SearchAllItem => {
      const at = parseLocator(hit.locator)
      return {
        kind: kind === "mail" ? "mail" : "message",
        ref: hit.locator,
        provider: at.provider,
        account: at.account,
        title: hit.chatTitle,
        timestamp: hit.timestamp,
        text: hit.excerpt ?? excerpt(hit.text ?? "", request.text),
        from: hit.email?.from
          ? { name: hit.email.from.name ?? hit.email.from.address, ref: hit.email.from.ref }
          : { name: hit.senderName, ref: null },
        ...(hit.email ? { email: hit.email } : {}),
        foundBy,
      }
    }
    const byWords = found.items.map((hit) => itemOf(hit, ["words"]))
    // Server hits are only those the server returned; the local vectors would add others.
    if (kind === "mail" || !meaning || request.exact || request.backend === "server") return byWords
    const filters = filtersBeside(request.text)
    const lane =
      filters === undefined
        ? {
            skipped: {
              reason: "the query uses NOT, or a filter under OR or in a group, which meaning cannot follow",
              model: DEFAULT_TEXT_MODEL,
            },
          }
        : await meaning(request.text, read, embedders)
    if ("skipped" in lane) {
      messagesBy = { by: "words", meaningSkipped: lane.skipped }
      return byWords
    }
    messagesBy = { by: "words and meaning", ...(lane.partly ? { meaningSkipped: lane.partly } : {}) }
    const near = await nearEligible(store, account, query, messenger, lane.ranked, filters ?? "")
    // One list per resource, as notes give theirs, so messages get no second vote against mail.
    const fused = new Map<string, { item: SearchAllItem; score: number }>()
    byWords.forEach((item, rank) => {
      fused.set(item.ref, { item, score: 1 / (RRF_K + rank + 1) })
    })
    near.forEach((hit, rank) => {
      const held = fused.get(hit.locator)
      if (held) held.item.foundBy = ["words", "meaning"]
      fused.set(hit.locator, {
        item: held?.item ?? itemOf(hit, ["meaning"]),
        score: (held?.score ?? 0) + 1 / (RRF_K + rank + 1),
      })
    })
    return [...fused.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  }

  // Messages and notes both look up by meaning with the same model: loading it costs most of a second.
  const embedders = runEmbedders()
  try {
    for (const resource of only) {
      try {
        if (resource === "notes") {
          const chosen = request.scope?.notes
          const found = await searchNotes(store, request.text, {
            limit: window,
            command,
            embedders,
            ...(chosen === undefined ? {} : notesScopeOf(chosen)),
            ...(request.exact ? { exact: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.env === undefined ? {} : { env: request.env }),
          })
          hasMore ||= found.has_more
          notes = {
            by: found.by,
            ...(found.meaning_skipped === undefined ? {} : { meaningSkipped: found.meaning_skipped }),
          }
          lists.push(
            found.hits.map((hit) => ({
              kind: hit.kind ?? "note",
              ref: hit.ref,
              provider: hit.provider ?? "notes",
              account: hit.account ?? hit.folder_id ?? INTERNAL_NOTES,
              ...(hit.url ? { url: hit.url } : {}),
              title: hit.title,
              timestamp: hit.updated_at,
              text: hit.excerpt,
              foundBy: hit.found_by,
            })),
          )
          const read = chosen?.map(({ account }) => account) ?? [
            INTERNAL_NOTES,
            ...(await store.notes.folders()).map(({ id }) => id),
            ...(await store.notes.documentsAccounts()).map(({ id }) => id),
          ]
          accounts.push(...read.map((account) => ({ resource, provider: "notes", account })))
        } else if (resource === "events") {
          const read = request.scope?.events ?? (await calendarAccounts(store))
          if (!read.length) continue
          const found = await searchEvents(store, request.text, {
            limit: window,
            accounts: read,
            ...(request.exact ? { exact: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          hasMore ||= found.has_more
          lists.push(
            found.hits.map((hit) => ({
              kind: "event",
              ref: hit.ref,
              provider: hit.provider ?? "calendar",
              account: hit.account ?? "",
              ...(hit.url ? { url: hit.url } : {}),
              title: hit.title,
              timestamp: hit.starts_at ?? hit.updated_at,
              text: hit.excerpt,
              foundBy: hit.found_by,
            })),
          )
          accounts.push(...read.map(({ provider, account }) => ({ resource, provider, account })))
        } else lists.push(await messagesOf(resource))
        searched.push(resource)
      } catch (error) {
        if (!skippable(error)) throw error
        skipped.push({ resource, code: error.code, reason: error.message })
      }
    }
  } finally {
    await embedders.close()
  }

  const ranked = new Map<string, { item: SearchAllItem; score: number }>()
  for (const list of lists)
    list.forEach((item, rank) => {
      const held = ranked.get(item.ref) ?? { item, score: 0 }
      held.score += 1 / (RRF_K + rank + 1)
      ranked.set(item.ref, held)
    })
  const ordered = [...ranked.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  const more = hasMore || ordered.length > window
  return {
    query: request.text,
    items: ordered.slice(offset, window),
    hasMore: more,
    ...(more && window <= MAX_SEARCH_OFFSET ? { nextOffset: window } : {}),
    searched,
    accounts,
    skipped,
    ...(notes === undefined ? {} : { notes }),
    ...(messagesBy === undefined ? {} : { messages: messagesBy }),
    ...(server === undefined ? {} : { server }),
  }
}
