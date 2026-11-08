import { CliError, type ErrorCode } from "@wirecat/cli-base"
import { parseLucene, type QueryNode } from "@wirecat/cli-base/query"
import { type HitFile, hitFiles } from "../domain/attachments.js"
import type { DealKind } from "../domain/deals.js"
import { parseLocator } from "../domain/locator.js"
import { type MailFields, senderIsMe } from "../domain/models.js"
import { holdsKind, INTERNAL_NOTES } from "../domain/providers.js"
import { runEmbedders } from "../embeddings/embed.js"
import { chosenTextModel } from "../embeddings/models.js"
import type { MessengerTraits } from "../ports/traits.js"
import { plainQuery } from "../search/lucene/plain.js"
import { MESSAGE_PARSING, SEARCH_QUERY } from "../search/lucene/types.js"
import { planQuestion, questionLookup } from "../search/question-plan.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { calendarAccounts, searchEvents } from "./events-search.js"
import { excerpt } from "./excerpt.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { MAX_SEARCH_OFFSET, searchStore } from "./messages-archive-search.js"
import { type MeaningLane, type MeaningSkipped, nearEligible } from "./messages-discovery.js"
import type { SearchCoverage } from "./messages-search.js"
import { notesScopeOf, RRF_K, searchNotes } from "./notes-search.js"
import type { Backend, ServerOptions, ServerSearched } from "./server-search.js"

export const RESOURCES_SEARCHED = ["messages", "mail", "notes", "events", "crm"] as const
export type SearchedResource = (typeof RESOURCES_SEARCHED)[number]

export interface SearchAllItem {
  kind: "message" | "mail" | "note" | "document" | "event" | "deal" | "lead"
  /** `msg:…` for a message or a mail, `note:…` for a note, `event:…` for a calendar event, `deal:…`, `lead:…`. */
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
  /** A message's or a mail's: whether the owner wrote it. */
  senderIsMe?: boolean
  /** A mail's people, labels and thread, as `search mail` gives them. */
  email?: MailFields
  /** A message's or a mail's files, as `search messages` names them. */
  attachments?: HitFile[]
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
/**
 * `reason` is the sentence for a person; `code` and `why` (a dotted reason such as `query.unknown-value`) are for a
 * program, and `token` is the part of the query the source refused, when the refusal points at one.
 */
export type Skipped<R extends string> = { code: ErrorCode; reason: string; why?: string; token?: string } & (
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
  /** How calendar events were searched, when they were. */
  events?: { by: "words" | "words and meaning"; meaningSkipped?: string }
  /** How the messages were searched, when they were; never by meaning with `exact` or the server alone. */
  messages?: { by: "words" | "words and meaning"; meaningSkipped?: MeaningSkipped }
  /** How the mail was searched, when it was; never by meaning with `exact`. */
  mail?: { by: "words" | "words and meaning"; meaningSkipped?: MeaningSkipped }
  /** The messenger's server step for messages, as `search messages` reports it. */
  server?: ServerSearched
  /** What the store held of the chats the messages were searched in; absent when messages were not searched. */
  coverage?: SearchCoverage
  /** When nothing was found by all the words: the words that alone find nothing in `searched` either. */
  unmatched?: string[]
}

export interface SearchAllRequest {
  text: string
  limit: number
  /** Skip this many of the merged hits: the `nextOffset` of the page before. */
  offset?: number
  only?: readonly SearchedResource[]
  exact?: boolean
  timezone?: string
  /** For messages only; mail, notes, events and CRM copies are always the local store's. */
  backend?: Backend
  server?: ServerOptions
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** The accounts `--source` chose, per kind; a kind left out reads every account of its own. */
  scope?: Partial<Record<SearchedResource, AccountKey[]>>
  /** The CRM kinds `crm` reads; absent, deals and leads. */
  crmKinds?: readonly DealKind[]
}

const refusal = (error: CliError, text: string): { why?: string; token?: string } => {
  const { reason, span } = (error.details ?? {}) as { reason?: unknown; span?: { start?: unknown; end?: unknown } }
  const why = typeof reason === "string" ? reason : undefined
  const token =
    span && Number.isInteger(span.start) && Number.isInteger(span.end)
      ? text.slice(span.start as number, span.end as number).trim()
      : ""
  return { ...(why ? { why } : {}), ...(token ? { token } : {}) }
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
 * What a deal or a lead is found by: words or phrases of its title, all of them, or any with OR. Anything else is
 * refused, so `search all` skips deals with the reason instead of matching a field they do not have.
 */
export const titleWords = (text: string): { words: string[]; anyWord: boolean } => {
  const { root } = parseLucene(text, SEARCH_QUERY)
  const clauses = root.kind === "boolean" ? root.clauses : [{ node: root, occur: "must" as const }]
  const words = clauses.map(({ node, occur }) =>
    occur !== "must_not" &&
    node.kind === "predicate" &&
    node.field === "text" &&
    (node.operator === "term" || node.operator === "phrase")
      ? // A title holds "invoice", not the question mark of "invoice?".
        node.value.replace(/\?+$/u, "") || node.value
      : (() => {
          throw new CliError("validation_error", "deals and leads are found by the words of their title only")
        })(),
  )
  return { words, anyWord: clauses.length > 1 && clauses.every(({ occur }) => occur === "should") }
}

/** The single words of an all-words query, when it has two to eight of them; none for OR, fields or phrases. */
const strictWords = (text: string): string[] => {
  try {
    const { words, anyWord } = titleWords(text)
    const unique = [...new Set(words)]
    return anyWord || unique.length < 2 || unique.length > 8 || unique.some((word) => /\s/u.test(word)) ? [] : unique
  } catch (error) {
    if (error instanceof CliError) return []
    throw error
  }
}

/** The accounts of every CRM the store holds copies of. */
export const crmAccounts = async (store: MessageStore): Promise<AccountKey[]> =>
  (await store.accounts.accounts()).filter(({ provider }) => holdsKind(provider, "crm"))

/**
 * `search all`: messages, mail, notes, calendar events and CRM deals and leads from the local store — messages also from the messenger's
 * server, as `search messages` asks it — each list best first, merged by reciprocal rank so no
 * resource's own scores have to be compared with another's. Events are read only when the store holds a calendar.
 */
export const searchAll = async (
  store: MessageStore,
  account: AccountKey,
  asked: SearchAllRequest,
  messenger: SearchAllMessenger = {},
  searchMessages: (query: SearchQuery) => Promise<SearchFound> = (query) =>
    searchStore(store, account, query, messenger),
  meaning?: MeaningLane,
): Promise<SearchAllFound> => {
  if (!asked.text.trim()) throw new CliError("validation_error", "say what to find")
  const request = { ...asked, text: plainQuery(asked.text) }
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
  let events: SearchAllFound["events"]
  const by: { messages?: SearchAllFound["messages"]; mail?: SearchAllFound["mail"] } = {}
  let server: ServerSearched | undefined
  // Every word of a sentence is rarely in one record: a question finds what holds some of them, as `--discover` does.
  const discover = !request.exact && questionLookup(request.text) !== undefined
  /** Each hit found by meaning, by its cosine: one model for every source, so these compare across them. */
  const cosines = new Map<string, number>()
  let coverage: SearchCoverage | undefined

  const messagesOf = async (kind: "messages" | "mail") => {
    const given = request.scope?.[kind]
    // The server still gets the question as typed: a query that is not a sentence still finds what it holds.
    const discovers = discover && (kind === "mail" || request.backend !== "server")
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
      ...(discovers ? { discover: true } : {}),
      ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    // Messages go the way `search messages` goes, server included, so `search all` finds whatever it finds.
    const found =
      kind === "messages" ? await searchMessages(query) : await searchStore(store, account, query, messenger)
    if (found.server) server = found.server
    if (kind === "messages" && found.coverage) coverage = found.coverage
    hasMore ||= found.hasMore
    const read =
      found.coverage?.accounts ??
      given ??
      (await store.accounts.accounts()).filter(({ provider }) => holdsKind(provider, kind))
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
        senderIsMe: senderIsMe(hit, at.account),
        ...(hit.email ? { email: hit.email } : {}),
        attachments: hitFiles(hit.attachments),
        foundBy,
      }
    }
    const byWords = found.items.map((hit) => itemOf(hit, ["words"]))
    // Server hits are only those the server returned; the local vectors would add others.
    if (!meaning || request.exact || (kind === "messages" && request.backend === "server")) return byWords
    const filters = filtersBeside(request.text)
    const lane =
      filters === undefined
        ? {
            skipped: {
              reason: "the query uses NOT, or a filter under OR or in a group, which meaning cannot follow",
              model: chosenTextModel(request.env).id,
            },
          }
        : await meaning(request.text, read, embedders)
    if ("skipped" in lane) {
      by[kind] = { by: "words", meaningSkipped: lane.skipped }
      return byWords
    }
    by[kind] = { by: "words and meaning", ...(lane.partly ? { meaningSkipped: lane.partly } : {}) }
    const near = await nearEligible(store, account, query, messenger, lane.ranked, filters ? { text: filters } : {})
    // One list per resource, as notes give theirs, so messages get no second vote against mail.
    const fused = new Map<string, { item: SearchAllItem; score: number }>()
    byWords.forEach((item, rank) => {
      fused.set(item.ref, { item, score: 1 / (RRF_K + rank + 1) })
    })
    near.forEach((hit, rank) => {
      cosines.set(hit.locator, hit.cosine)
      const held = fused.get(hit.locator)
      if (held) held.item.foundBy = ["words", "meaning"]
      const vote = 1 / (RRF_K + rank + 1)
      // As in notes: a question's any-word list holds most of what meaning finds, so a second vote would bury the rest.
      if (held && discovers) held.score = Math.max(held.score, vote)
      else fused.set(hit.locator, { item: held?.item ?? itemOf(hit, ["meaning"]), score: (held?.score ?? 0) + vote })
    })
    return [...fused.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  }

  // Messages, notes and events all look up by meaning with the same model: loading it costs most of a second.
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
            ...(discover ? { discover: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.env === undefined ? {} : { env: request.env }),
          })
          hasMore ||= found.has_more
          notes = {
            by: found.by,
            ...(found.meaning_skipped === undefined ? {} : { meaningSkipped: found.meaning_skipped }),
          }
          for (const hit of found.hits) if (hit.meaning_score !== undefined) cosines.set(hit.ref, hit.meaning_score)
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
            ...[await store.notes.addedAccount()].flatMap((added) => (added ? [added.id] : [])),
          ]
          accounts.push(...read.map((account) => ({ resource, provider: "notes", account })))
        } else if (resource === "events") {
          const read = request.scope?.events ?? (await calendarAccounts(store))
          if (!read.length) continue
          const found = await searchEvents(store, request.text, {
            limit: window,
            accounts: read,
            embedders,
            ...(command === undefined ? {} : { command }),
            ...(request.env === undefined ? {} : { env: request.env }),
            ...(request.exact ? { exact: true } : {}),
            ...(discover ? { discover: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          hasMore ||= found.has_more
          events = {
            by: found.by,
            ...(found.meaning_skipped === undefined ? {} : { meaningSkipped: found.meaning_skipped }),
          }
          for (const hit of found.hits) if (hit.meaning_score !== undefined) cosines.set(hit.ref, hit.meaning_score)
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
        } else if (resource === "crm") {
          const { words, anyWord } = titleWords(request.text)
          const chosen = request.scope?.crm
          const found = await store.deals.find({
            words,
            anyWord: anyWord || discover,
            ...(request.crmKinds === undefined ? {} : { kinds: request.crmKinds }),
            limit: Math.min(window + 1, 500),
            ...(chosen === undefined ? {} : { accounts: chosen }),
          })
          hasMore ||= found.length > window
          lists.push(
            found.slice(0, window).map((deal) => ({
              kind: deal.kind,
              ref: deal.ref,
              provider: deal.account?.provider ?? "crm",
              account: deal.account?.account ?? INTERNAL_NOTES,
              title: deal.title,
              timestamp: deal.updatedAt,
              text: deal.summary,
              foundBy: ["title"],
            })),
          )
          const read = chosen ?? [...(await crmAccounts(store)), { provider: "crm", account: INTERNAL_NOTES }]
          for (const { provider, account } of read) accounts.push({ resource, provider, account })
        } else lists.push(await messagesOf(resource))
        searched.push(resource)
      } catch (error) {
        if (!skippable(error)) throw error
        skipped.push({ resource, code: error.code, reason: error.message, ...refusal(error, request.text) })
      }
    }
  } finally {
    await embedders.close()
  }

  const ordered = oneList(lists, cosines)
  const more = hasMore || ordered.length > window
  const { backend: _backend, server: _server, ...local } = asked
  const unmatched = []
  if (!ordered.length && !offset && !discover)
    for (const word of strictWords(request.text)) {
      const alone = await searchAll(store, account, { ...local, text: word, limit: 1, only: searched })
      if (!alone.items.length) unmatched.push(word)
    }
  return {
    query: asked.text,
    items: ordered.slice(offset, window),
    hasMore: more,
    ...(more && window <= MAX_SEARCH_OFFSET ? { nextOffset: window } : {}),
    searched,
    accounts,
    skipped,
    ...(notes === undefined ? {} : { notes }),
    ...(events === undefined ? {} : { events }),
    ...(by.messages === undefined ? {} : { messages: by.messages }),
    ...(by.mail === undefined ? {} : { mail: by.mail }),
    ...(server === undefined ? {} : { server }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(unmatched.length ? { unmatched } : {}),
  }
}

/**
 * Every source's hits as one list: by the rank each has in its own source, then by cosine. Rank alone gave every
 * source's hit at one rank the same score, so the sources took turns and the order among them was the order they were
 * read in (MEMO-37). One model scores every source, so cosine compares across them; a hit meaning did not find comes
 * after those it did at the same rank. Each source's own order is kept, so recall at any depth past the number of
 * sources does not change.
 */
const oneList = (lists: SearchAllItem[][], cosines: Map<string, number>): SearchAllItem[] => {
  const place = new Map<string, { item: SearchAllItem; rank: number }>()
  for (const list of lists)
    list.forEach((item, rank) => {
      const held = place.get(item.ref)
      if (!held || rank < held.rank) place.set(item.ref, { item, rank })
    })
  const cosine = (ref: string) => cosines.get(ref) ?? Number.NEGATIVE_INFINITY
  return [...place.values()]
    .sort((a, b) => a.rank - b.rank || cosine(b.item.ref) - cosine(a.item.ref))
    .map(({ item }) => item)
}
