import { CliError, type ErrorCode } from "@wirecat/cli-base"
import { parseLucene, type QueryNode, timezoneOf } from "@wirecat/cli-base/query"
import { crmViewerOf } from "../crm/index.js"
import { type HitFile, hitFiles } from "../domain/attachments.js"
import type { DealKind } from "../domain/deals.js"
import { parseLocator } from "../domain/locator.js"
import { type MailFields, senderIsMe } from "../domain/models.js"
import { hasGlobalItemIds, holdsKind, INTERNAL_NOTES, isDocumentAccountProvider } from "../domain/providers.js"
import { type TrackerIssue, trackerBodyOf, trackerTitleOf } from "../domain/tracker.js"
import { runEmbedders } from "../embeddings/embed.js"
import { chosenTextModel } from "../embeddings/models.js"
import { formatMeetingReference } from "../meetings/index.js"
import type { MessengerTraits } from "../ports/traits.js"
import { entriesOfList, fitting, type ListedAccount, listedHolds } from "../search/account-list.js"
import { RRF_K } from "../search/fusion.js"
import { meaningWords } from "../search/lucene/meaning-parts.js"
import { plainQuery } from "../search/lucene/plain.js"
import { MESSAGE_PARSING, SEARCH_QUERY } from "../search/lucene/types.js"
import { type Period, questionPeriod } from "../search/question-period.js"
import {
  isFunctionWord,
  words as plainWords,
  planQuestion,
  questionLookup,
  questionText,
} from "../search/question-plan.js"
import type {
  AccountKey,
  BusinessKind,
  BusinessSource,
  CopyViewer,
  MessageStore,
  StoredAccount,
  TrackerItem,
  TrackerNearest,
} from "../store/store.js"
import { nearestCrmActivities } from "./crm-meaning.js"
import { calendarAccounts, searchEvents } from "./events-search.js"
import { excerpt } from "./excerpt.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { MAX_SEARCH_OFFSET, searchStore } from "./messages-archive-search.js"
import { type MeaningLane, type MeaningSkipped, nearEligible } from "./messages-discovery.js"
import type { SearchCoverage } from "./messages-search.js"
import { importAccounts, notesScopeOf, searchNotes } from "./notes-search.js"
import { BUSINESS_WORDS_ONLY, searchBusiness } from "./search-all-business.js"
import { type MeetingAccountCoverage, type MeetingSearchItem, meetingLane } from "./search-all-meetings.js"
import { HARDER_CANDIDATES, type HarderOptions, type HarderResult, reorderHarder } from "./search-harder.js"
import { listContextOf } from "./search-kind.js"
import type { Backend, ServerOptions, ServerSearched } from "./server-search.js"
import { nearestTracker } from "./tracker-meaning.js"

export const RESOURCES_SEARCHED = [
  "messages",
  "mail",
  "notes",
  "events",
  "crm",
  "business",
  "meetings",
  "tracker",
] as const
export type SearchedResource = (typeof RESOURCES_SEARCHED)[number]

/** One hit of `search all`: a stored record, or a passage of a meeting. */
export type SearchAllItem = SearchAllRecordItem | MeetingSearchItem

export interface SearchAllRecordItem {
  kind:
    | "message"
    | "mail"
    | "note"
    | "document"
    | "event"
    | "deal"
    | "lead"
    | "crm_file"
    | TrackerHitKind
    | BusinessKind
  /**
   * `msg:…` for a message or a mail, `note:…`, `event:…`, `deal:…`, `lead:…`, `crmfile:<file id>` for a downloaded CRM
   * file, `tracker:<provider>/<account>/<kind>/<id>` for an issue, a project or a comment, or a business ref: `invoice:…`.
   */
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
  /** A tracker hit that more than one sign-in holds: every account it was found in, `account` first. */
  accounts?: string[]
  /** Which search found it: words, meaning or both; a deal or a lead by `title`, or `words` of its company or contacts. */
  foundBy: ("title" | "words" | "meaning")[]
  /** A deal's or a lead's: `corrected` when it matched only once a misspelt query word was corrected. */
  match?: "corrected"
  /** For a `corrected` hit, the stored words each corrected query word became. */
  corrections?: { from: string; to: string[] }[]
  /** A business hit's: whether the owner confirmed it, or it waits for him. */
  review?: "proposed" | "confirmed"
  /** A business hit's source record, when an import made it. */
  sourceRecord?: BusinessSource
  /** A document's: the meeting it is the transcript, recording or notes of (`meeting:<account>/<meeting>`). */
  meeting?: string
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
  /** How issues, projects and comments were searched, when they were; never by meaning with `exact`. */
  tracker?: { by: "words" | "words and meaning"; meaningSkipped?: string }
  /** How deals and leads were searched, when they were: by meaning too through their activities' vectors. */
  crm?: {
    by: "words" | "words and meaning"
    meaningSkipped?: string
    /** No model, or no activity embedded yet: the CRM's `sync --embed` builds the vectors. */
    needsVectors?: true
  }
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
  /** What each meeting account read could answer; absent when no meeting account was read. */
  meetings?: MeetingAccountCoverage[]
  /** What `harder` did, when it was asked: reordered, or kept the plain order and why. */
  harder?: HarderResult
}

export interface SearchAllRequest {
  text: string
  limit: number
  /** Skip this many of the merged hits: the `nextOffset` of the page before. */
  offset?: number
  only?: readonly SearchedResource[]
  exact?: boolean
  timezone?: string
  /** The clock a question's "last week" or "in March" is read on; absent, the time of the call. */
  now?: number
  /** For messages only; mail, notes, events and CRM copies are always the local store's. */
  backend?: Backend
  server?: ServerOptions
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** The accounts `--source` chose, per kind; a kind left out reads every account of its own. */
  scope?: Partial<Record<SearchedResource, AccountKey[]>>
  /**
   * `--source` as typed: each kind reads the accounts the list names of it, and a kind it names none of is skipped.
   * It replaces `scope`.
   */
  source?: string
  /** The scopes whose meeting accounts are read; absent, the scope of the caller's stored account only. */
  meetingScopes?: readonly StoredAccount["scope"][]
  /**
   * The caller named meetings (`--only meetings`), so none to read is a skip that makes the answer incomplete; else
   * a store with no meeting account says nothing about them, as one with no calendar says nothing of events.
   */
  meetingsAsked?: boolean
  /** The CRM kinds `crm` reads; absent, deals and leads. */
  crmKinds?: readonly DealKind[]
  /** The CRM accounts' copies a CRM CLI's profile may read only part of, each by its own rule (SEC-197). */
  crmViewers?: CopyViewer[]
  /** `crm` also reads the text of downloaded CRM files under the same viewers; false when the profile denies it. */
  crmFiles?: boolean
  /**
   * `crm` also finds deals and leads by the meaning of their activities' text, shown in the hit; false when the
   * profile denies reading activities.
   */
  crmActivities?: boolean
  /**
   * Search harder: a hosted model reorders the first 30 hits, only with the owner's consent and a key. Absent, nothing
   * is read of the consent or the key and nothing is sent.
   */
  harder?: HarderOptions
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
 * What a deal or a lead is found by: plain words or phrases, all of them, or any with OR. Anything else is refused,
 * so `search all` skips deals with the reason instead of matching a field they do not have.
 */
export const titleWords = (
  text: string,
  refused = "deals and leads are found by the words of their title, company, contacts and activities only",
): { words: string[]; anyWord: boolean } => {
  const { root } = parseLucene(text, SEARCH_QUERY)
  const clauses = root.kind === "boolean" ? root.clauses : [{ node: root, occur: "must" as const }]
  const words = clauses.map(({ node, occur }) =>
    occur !== "must_not" &&
    node.kind === "predicate" &&
    (node.field === "text" || node.field === "title") &&
    (node.operator === "term" || node.operator === "phrase")
      ? // A title holds "invoice", not the question mark of "invoice?".
        node.value.replace(/\?+$/u, "") || node.value
      : (() => {
          throw new CliError("validation_error", refused)
        })(),
  )
  return { words, anyWord: clauses.length > 1 && clauses.every(({ occur }) => occur === "should") }
}

/** A question finds by any of its words, so «что», «кто» or "the" would match nearly every record. */
const contentWords = (found: { words: string[]; anyWord: boolean }, discover: boolean) => {
  if (!discover) return found
  const content = found.words.filter((word) => !plainWords(word).every(isFunctionWord))
  return content.length ? { ...found, words: content } : found
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

const accountKeyOf = ({ provider, account }: AccountKey) => `${provider}\u0000${account}`

/** `--source` as the accounts each kind reads; a kind it names no account of is skipped, not read in full. */
const sourceScope = async (
  store: MessageStore,
  account: AccountKey,
  source: string,
  asked: readonly SearchedResource[],
  messenger: SearchAllMessenger,
) => {
  const context = await listContextOf(store, account, messenger.app)
  const entries = entriesOfList(source, context)
  // Any provider's import may write business data, so its accounts are the ones that hold some, whatever their kind.
  const imported = asked.includes("business")
    ? new Set((await store.business.accounts()).map(accountKeyOf))
    : new Set<string>()
  const holdsBusiness = (one: AccountKey) => imported.has(accountKeyOf(one))
  // An import's account holds documents under its own key, and the notes lane reads them.
  const holdsDocuments = (one: AccountKey) => asked.includes("notes") && holdsKind(one.provider, "documents")
  const { skipped } = fitting(
    entries,
    asked.filter((one): one is Exclude<SearchedResource, "business"> => one !== "business"),
    "search all",
    (kind) => `--only leaves ${kind} out`,
    (one) => holdsBusiness(one) || holdsDocuments(one),
  )
  const holds = (resource: SearchedResource, one: ListedAccount) =>
    resource === "business"
      ? holdsBusiness(one)
      : listedHolds(one, resource) || (resource === "notes" && holdsDocuments(one))
  // A documents account named by its own key (`linear:user-1`, whose tracker copy is listed so) is read by the notes
  // lane as the `notes:<id>` it is also listed as, so naming it both ways reads it once.
  const asNotes = (one: AccountKey): AccountKey => {
    if (!isDocumentAccountProvider(one.provider)) return one
    const stored = context.held.find(({ provider, account }) => provider === one.provider && account === one.account)
    return stored ? { provider: "notes", account: String(stored.id) } : one
  }
  const named = (resource: SearchedResource): AccountKey[] => [
    ...new Map(
      entries
        .flatMap(({ accounts }) => accounts)
        .filter((one) => holds(resource, one))
        .map((one) => (resource === "notes" ? asNotes(one) : one))
        .map(({ provider, account }) => [`${provider}\u0000${account}`, { provider, account }] as const),
    ).values(),
  ]
  const scope = Object.fromEntries(asked.map((resource) => [resource, named(resource)]))
  const only = asked.filter((resource) => scope[resource]?.length)
  const unnamed: Skipped<SearchedResource>[] = asked
    .filter((resource) => !only.includes(resource))
    .map((resource) => ({ resource, code: "not_found", reason: `--source names no ${resource} account` }))
  return { only, scope, skipped: [...skipped, ...unnamed] }
}

/** Each CRM copy's viewer for the user its own sync signed in as (SEC-197): what a run outside its CLI may read. */
const copyViewers = async (store: MessageStore): Promise<CopyViewer[]> => {
  const viewers: CopyViewer[] = []
  for (const account of await crmAccounts(store)) {
    const { viewer } = await crmViewerOf(store, account, (await store.crm.ownUser(account)) ?? null)
    if (viewer) viewers.push(viewer)
  }
  return viewers
}

/** A tracker hit's kind: a comment is named for the issue it is on, beside a CRM's and a message's kinds. */
export type TrackerHitKind = "issue" | "project" | "issue_comment"

const TRACKER_HIT_KINDS = { issue: "issue", project: "project", comment: "issue_comment" } as const

/** The accounts of every tracker the store holds copies of. */
export const trackerAccounts = async (store: MessageStore): Promise<AccountKey[]> =>
  (await store.accounts.accounts()).filter(({ provider }) => holdsKind(provider, "tracker"))

/** An issue is titled as people say it, `ENG-12 Fix login`; anything else by its name or its first line. */
const trackerTitle = ({ kind, record }: TrackerItem): string => {
  const title = trackerTitleOf(kind, record)
  const key = kind === "issue" ? (record as TrackerIssue).key : undefined
  return key ? `${key} ${title}` : title
}

/**
 * What the meaning half embeds: the words and phrases asked for, OR included, as notes take them. `title:` narrows to
 * the title, which a hit by meaning cannot be held to, so such a query is searched by words only.
 */
const meaningWordsOf = (text: string): string | undefined => {
  try {
    const { root } = parseLucene(text, SEARCH_QUERY)
    const nodes = root.kind === "boolean" ? root.clauses.map(({ node }) => node) : [root]
    if (!nodes.every((node) => node.kind === "predicate" && node.field === "text")) return undefined
    return meaningWords(root) || undefined
  } catch {
    return undefined
  }
}

const trackerExcerpt = ({ kind, record }: TrackerItem, query: string): string =>
  excerpt([trackerTitleOf(kind, record), trackerBodyOf(kind, record)].filter(Boolean).join("\n"), query)

/**
 * One hit per tracker item, best first: the copies other sign-ins hold of one item (`items` maps a hit's ref to the
 * item, for a provider whose ids name one item across its accounts) join the best-placed one, which names every account and takes the best cosine and every way any was found.
 */
const oneHitPerItem = (
  ordered: SearchAllRecordItem[],
  cosines: Map<string, number>,
  items: Map<string, string>,
): SearchAllRecordItem[] => {
  const kept = new Map<string, SearchAllRecordItem>()
  for (const hit of ordered) {
    const key = items.get(hit.ref) ?? hit.ref
    const held = kept.get(key)
    if (!held) {
      kept.set(key, hit)
      continue
    }
    held.accounts = [...(held.accounts ?? [held.account]), hit.account]
    held.foundBy = (["words", "meaning"] as const).filter((by) =>
      [held, hit].some(({ foundBy }) => foundBy.includes(by)),
    )
    const cosine = cosines.get(hit.ref)
    if (cosine !== undefined && cosine > (cosines.get(held.ref) ?? Number.NEGATIVE_INFINITY))
      cosines.set(held.ref, cosine)
  }
  return [...kept.values()]
}

/**
 * One list for a lane found both ways, as notes and messages fuse theirs: each hit's rank in either list votes, a
 * question's hit voting once; a hit found both ways keeps its words' text and is found by meaning too.
 */
const fusedLane = (
  byWords: SearchAllRecordItem[],
  byMeaning: { hit: SearchAllRecordItem; score: number }[],
  discover: boolean,
  cosines: Map<string, number>,
): SearchAllRecordItem[] => {
  const fused = new Map<string, { item: SearchAllRecordItem; score: number }>()
  byWords.forEach((item, rank) => {
    fused.set(item.ref, { item, score: 1 / (RRF_K + rank + 1) })
  })
  byMeaning.forEach(({ hit, score }, rank) => {
    cosines.set(hit.ref, score)
    const held = fused.get(hit.ref)
    if (held && !held.item.foundBy.includes("meaning")) held.item.foundBy = [...held.item.foundBy, "meaning"]
    const vote = 1 / (RRF_K + rank + 1)
    if (held && discover) held.score = Math.max(held.score, vote)
    else fused.set(hit.ref, { item: held?.item ?? hit, score: (held?.score ?? 0) + vote })
  })
  return [...fused.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
}

/** The accounts of every CRM the store holds copies of. */
export const crmAccounts = async (store: MessageStore): Promise<AccountKey[]> =>
  (await store.accounts.accounts()).filter(({ provider }) => holdsKind(provider, "crm"))

/**
 * `search all`: messages, mail, notes, calendar events, CRM deals and leads, business data and meeting passages from
 * the local store — messages also from the messenger's server, as `search messages` asks it — each list best first,
 * merged by rank so no resource's own scores have to be compared with another's. Events are read only when the store
 * holds a calendar, meetings only when it holds a meeting account.
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
  const period = questionPeriod(request.text, request.now ?? Date.now(), timezoneOf(request.timezone))
  // Each resource is read deep enough for the merged page, then the merge is cut; a named period reads deeper, so a
  // hit inside it can move up from below the page.
  const window = offset + request.limit
  const depth = Math.max(window, period ? PERIOD_DEPTH : 0, request.harder ? HARDER_CANDIDATES : 0)
  const chosen =
    request.source === undefined
      ? { only: request.only ?? RESOURCES_SEARCHED, scope: request.scope, skipped: [] }
      : await sourceScope(store, account, request.source, request.only ?? RESOURCES_SEARCHED, messenger)
  const { only, scope } = chosen
  const command = messenger.hintCommand === undefined ? messenger.app?.command : (messenger.hintCommand ?? undefined)
  const lists: SearchAllItem[][] = []
  const searched: SearchedResource[] = []
  const accounts: SearchedAccount[] = []
  const skipped: SearchAllFound["skipped"] = [...chosen.skipped]
  let hasMore = false
  let notes: SearchAllFound["notes"]
  let events: SearchAllFound["events"]
  let tracker: SearchAllFound["tracker"]
  let crm: SearchAllFound["crm"]
  const by: { messages?: SearchAllFound["messages"]; mail?: SearchAllFound["mail"] } = {}
  let server: ServerSearched | undefined
  // Every word of a sentence is rarely in one record: a question finds what holds some of them, as `--discover` does.
  const discover = !request.exact && questionLookup(request.text) !== undefined
  /** Each hit found by meaning, by its cosine: one model for every source, so these compare across them. */
  const cosines = new Map<string, number>()
  let coverage: SearchCoverage | undefined
  const meetingAccountsRead = new Set<number>()
  let meetings: MeetingAccountCoverage[] | undefined

  const messagesOf = async (kind: "messages" | "mail") => {
    const given = scope?.[kind]
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
      limit: depth,
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
    const itemOf = (hit: FoundMessage, foundBy: SearchAllRecordItem["foundBy"]): SearchAllRecordItem => {
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
    const fused = new Map<string, { item: SearchAllRecordItem; score: number }>()
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
          const chosen = scope?.notes
          const found = await searchNotes(store, request.text, {
            limit: depth,
            command,
            embedders,
            ...(chosen === undefined ? {} : notesScopeOf(chosen, await store.accounts.storedAccounts())),
            ...(request.exact ? { exact: true } : {}),
            ...(discover ? { discover: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.env === undefined ? {} : { env: request.env }),
          })
          hasMore ||= found.hasMore
          notes = {
            by: found.by,
            ...(found.meaning_skipped === undefined ? {} : { meaningSkipped: found.meaning_skipped }),
          }
          for (const hit of found.items) if (hit.meaning_score !== undefined) cosines.set(hit.ref, hit.meaning_score)
          lists.push(
            found.items.map((hit) => ({
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
          const read = chosen ?? [
            ...[
              INTERNAL_NOTES,
              ...(await store.notes.folders()).map(({ id }) => id),
              ...(await store.notes.documentsAccounts()).map(({ id }) => id),
              ...[await store.notes.addedAccount()].flatMap((added) => (added ? [added.id] : [])),
            ].map((account) => ({ provider: "notes", account })),
            ...(await importAccounts(store)).map(({ provider, account }) => ({ provider, account })),
          ]
          accounts.push(...read.map(({ provider, account }) => ({ resource, provider, account })))
        } else if (resource === "events") {
          const read = scope?.events ?? (await calendarAccounts(store))
          if (!read.length) continue
          const found = await searchEvents(store, request.text, {
            limit: depth,
            accounts: read,
            embedders,
            ...(command === undefined ? {} : { command }),
            ...(request.env === undefined ? {} : { env: request.env }),
            ...(request.exact ? { exact: true } : {}),
            ...(discover ? { discover: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          hasMore ||= found.hasMore
          events = {
            by: found.by,
            ...(found.meaning_skipped === undefined ? {} : { meaningSkipped: found.meaning_skipped }),
          }
          for (const hit of found.items) if (hit.meaning_score !== undefined) cosines.set(hit.ref, hit.meaning_score)
          lists.push(
            found.items.map((hit) => ({
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
          const { words, anyWord } = contentWords(titleWords(request.text), discover)
          const chosen = scope?.crm
          // memo's, tg's and the MCP's search all pass no viewers: each copy's own rule decides, as a CRM CLI's does.
          const viewers = request.crmViewers ?? (await copyViewers(store))
          const found = await store.deals.find({
            words,
            anyWord: anyWord || discover,
            ...(request.exact ? { exact: true } : {}),
            ...(request.crmKinds === undefined ? {} : { kinds: request.crmKinds }),
            viewers,
            limit: Math.min(depth, 500),
            ...(chosen === undefined ? {} : { accounts: chosen }),
          })
          hasMore ||= found.hasMore
          const titled = /(?:^|[\s(+])title:/u.test(request.text)
          const byWords: SearchAllRecordItem[] = found.items
            .filter((deal) => !titled || deal.matched.includes("title"))
            .map((deal) => ({
              kind: deal.kind,
              ref: deal.ref,
              provider: deal.account?.provider ?? "crm",
              account: deal.account?.account ?? INTERNAL_NOTES,
              title: deal.title,
              timestamp: deal.updatedAt,
              text: deal.summary,
              foundBy: deal.matched.includes("title") ? ["title"] : ["words"],
              ...(deal.corrections ? { match: "corrected" as const, corrections: deal.corrections } : {}),
            }))
          const plain = titled ? undefined : meaningWordsOf(discover ? questionText(request.text) : request.text)
          let near: Awaited<ReturnType<typeof nearestCrmActivities>> | undefined
          let meaningSkipped: string | undefined
          if (request.crmActivities === false) meaningSkipped = "the profile may not read activities"
          else if (request.exact) meaningSkipped = "--exact searches words as written"
          else if (plain === undefined) meaningSkipped = "the query names a title, which meaning cannot follow"
          else
            try {
              near = await nearestCrmActivities(store, plain, {
                limit: Math.min(depth, 500),
                accounts: chosen,
                viewers,
                embedders,
                ...(request.crmKinds === undefined ? {} : { kinds: request.crmKinds }),
                ...(command === undefined ? {} : { command }),
                ...(request.env === undefined ? {} : { env: request.env }),
              })
            } catch (error) {
              if (!(error instanceof CliError && error.code === "not_found")) throw error
              meaningSkipped = error.message
            }
          crm = {
            by: near === undefined ? "words" : "words and meaning",
            ...(meaningSkipped === undefined ? {} : { meaningSkipped }),
            ...(near === undefined && plain !== undefined && !request.exact && request.crmActivities !== false
              ? { needsVectors: true as const }
              : {}),
          }
          if (near === undefined) lists.push(byWords)
          else {
            const byMeaning = await Promise.all(
              near.map(async ({ ref, kind, account: at, subject, body, score }) => {
                const deal = await store.deals.get(ref)
                const hit: SearchAllRecordItem = {
                  kind,
                  ref,
                  provider: at.provider,
                  account: at.account,
                  title: deal.title,
                  timestamp: deal.updatedAt,
                  text: excerpt([subject, body].filter(Boolean).join("\n"), request.text),
                  foundBy: ["meaning"],
                }
                return { hit, score }
              }),
            )
            lists.push(fusedLane(byWords, byMeaning, discover, cosines))
          }
          if (request.crmFiles !== false) {
            const files = await store.crmFiles.find({
              words,
              anyWord: anyWord || discover,
              ...(request.exact ? { exact: true } : {}),
              ...(chosen === undefined ? {} : { accounts: chosen }),
              viewers,
              limit: Math.min(depth, 500),
            })
            hasMore ||= files.hasMore
            lists.push(
              files.items.map((hit) => ({
                kind: "crm_file" as const,
                ref: `crmfile:${hit.file.externalId}`,
                provider: hit.account.provider,
                account: hit.account.account,
                title: hit.file.name,
                timestamp: new Date(hit.file.downloadedAt).toISOString(),
                text: hit.excerpt,
                foundBy: ["words"],
              })),
            )
          }
          const read = chosen ?? [...(await crmAccounts(store)), { provider: "crm", account: INTERNAL_NOTES }]
          for (const { provider, account } of read) accounts.push({ resource, provider, account })
        } else if (resource === "tracker") {
          // The registry says which providers are trackers; reading every account's rows would show hits the listed
          // accounts do not account for.
          const read = scope?.tracker ?? (await trackerAccounts(store))
          if (!read.length) continue
          const { words, anyWord } = contentWords(
            titleWords(
              request.text,
              "issues, projects and comments are found by the words and meaning of their title and text only",
            ),
            discover,
          )
          // Two sign-ins to one workspace hold each item twice, and the copies fold into one hit: read deep enough
          // that the folded list still fills the page.
          const deep = Math.min(depth * read.length, 500)
          const found = await store.tracker.find({
            words,
            anyWord: anyWord || discover,
            ...(request.exact ? { exact: true } : {}),
            kinds: ["issue", "project", "comment"],
            limit: deep,
            accounts: read,
          })
          hasMore ||= found.hasMore
          const items = new Map<string, string>()
          const hitOf = (
            at: AccountKey,
            item: TrackerItem,
            text: string,
            foundBy: SearchAllRecordItem["foundBy"],
          ): SearchAllRecordItem => {
            const ref = `tracker:${at.provider}/${at.account}/${item.kind}/${item.record.externalId}`
            if (hasGlobalItemIds(at.provider))
              items.set(ref, JSON.stringify([at.provider, item.kind, item.record.externalId]))
            return {
              kind: TRACKER_HIT_KINDS[item.kind as keyof typeof TRACKER_HIT_KINDS],
              // Two sign-ins see the same issue under the same id, so the account keeps their hits apart.
              ref,
              provider: at.provider,
              account: at.account,
              ...((item.record as { url?: string | null }).url ? { url: (item.record as { url: string }).url } : {}),
              title: trackerTitle(item),
              timestamp: new Date(item.record.updatedAt ?? item.syncedAt).toISOString(),
              text,
              foundBy,
            }
          }
          const byWords = found.items.map(({ account: at, item, excerpt: text }) => hitOf(at, item, text, ["words"]))
          const plain = meaningWordsOf(discover ? questionText(request.text) : request.text)
          let near: TrackerNearest[] | undefined
          let meaningSkipped: string | undefined
          if (request.exact) meaningSkipped = "--exact searches words as written"
          else if (plain === undefined) meaningSkipped = "the query names a title, which meaning cannot follow"
          else
            try {
              near = await nearestTracker(store, plain, {
                limit: deep,
                accounts: read,
                embedders,
                ...(command === undefined ? {} : { command }),
                ...(request.env === undefined ? {} : { env: request.env }),
              })
            } catch (error) {
              if (!(error instanceof CliError && error.code === "not_found")) throw error
              meaningSkipped = error.message
            }
          tracker = {
            by: near === undefined ? "words" : "words and meaning",
            ...(meaningSkipped === undefined ? {} : { meaningSkipped }),
          }
          if (near === undefined) lists.push(oneHitPerItem(byWords, cosines, items))
          else {
            const byMeaning = near.map(({ account: at, item, score }) => ({
              hit: hitOf(at, item, trackerExcerpt(item, request.text), ["meaning"]),
              score,
            }))
            lists.push(oneHitPerItem(fusedLane(byWords, byMeaning, discover, cosines), cosines, items))
          }
          for (const { provider, account } of read) accounts.push({ resource, provider, account })
        } else if (resource === "business") {
          const { words, anyWord } = contentWords(titleWords(request.text, BUSINESS_WORDS_ONLY), discover)
          const found = await searchBusiness(store, {
            words,
            anyWord: anyWord || discover,
            window: depth,
            accounts: scope?.business,
          })
          hasMore ||= found.hasMore
          lists.push(found.items)
          for (const { provider, account } of found.read) accounts.push({ resource, provider, account })
        } else if (resource === "meetings") {
          const found = await meetingLane(store, account, {
            // A question finds passages that hold some of its words, as every other source does.
            text: (discover ? questionLookup(request.text) : undefined) ?? request.text,
            ...(discover ? { question: true } : {}),
            window: depth,
            ...(scope?.meetings === undefined ? {} : { accounts: scope.meetings }),
            ...(request.meetingScopes === undefined ? {} : { scopes: request.meetingScopes }),
            ...(request.meetingsAsked ? { asked: true } : {}),
            ...(request.exact ? { exact: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          for (const one of found.skipped) skipped.push(one)
          if (!found.read.length) continue
          hasMore ||= found.hasMore
          meetings = found.coverage
          for (const { id } of found.read) meetingAccountsRead.add(id)
          lists.push(found.items)
          for (const { provider, account } of found.read) accounts.push({ resource, provider, account })
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

  let ordered = insidePeriodFirst(
    oneList(await withMeetingDocuments(store, lists, meetingAccountsRead), cosines),
    period,
  )
  let harder: HarderResult | undefined
  if (request.harder) {
    const asking = {
      ...request.harder,
      env: request.env ?? process.env,
      now: request.now ?? Date.now(),
      ...(command === undefined ? {} : { command }),
    }
    // The model reads the question as typed, not escaped for the query parser.
    const done = await reorderHarder(asked.text, ordered, { ...asking, laterPage: offset > 0 })
    ordered = done.items
    harder = done.harder
  }
  const more = hasMore || ordered.length > window
  const { backend: _backend, server: _server, harder: _harder, ...local } = asked
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
    ...(tracker === undefined ? {} : { tracker }),
    ...(crm === undefined ? {} : { crm }),
    ...(by.messages === undefined ? {} : { messages: by.messages }),
    ...(by.mail === undefined ? {} : { mail: by.mail }),
    ...(server === undefined ? {} : { server }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(unmatched.length ? { unmatched } : {}),
    ...(meetings === undefined ? {} : { meetings }),
    ...(harder === undefined ? {} : { harder }),
  }
}

/**
 * A document that is a meeting's transcript, recording or notes names that meeting, when this search read the
 * meeting's account: a search that may not read meetings, or not that account, never learns of it. A transcript that Drive also
 * imported as a document is one thing with its meeting: when the meeting is among the hits, the document's hit is
 * dropped. Alone, the document stays, so nothing found is lost.
 */
const withMeetingDocuments = async (
  store: MessageStore,
  lists: SearchAllItem[][],
  read: ReadonlySet<number>,
): Promise<SearchAllItem[][]> => {
  if (!read.size) return lists
  const documentOf = (item: SearchAllItem) =>
    item.kind === "document" && /^document:\d+$/.test(item.ref) ? Number(item.ref.slice("document:".length)) : undefined
  const documents = lists.flat().flatMap((item) => documentOf(item) ?? [])
  if (!documents.length) return lists
  const owners = await store.meetings.documentMeetings(documents)
  if (!owners.size) return lists
  const meetings = new Set(lists.flat().flatMap((item) => (item.kind === "meeting" ? [item.meetingId] : [])))
  return lists.map((list) =>
    list.flatMap((item) => {
      const document = documentOf(item)
      const owner = document === undefined ? undefined : owners.get(document)
      if (owner === undefined || item.kind === "meeting") return [item]
      if (owner.role === "transcript" && meetings.has(owner.meetingId)) return []
      if (!read.has(owner.accountId)) return [item]
      return [
        {
          ...item,
          meeting: formatMeetingReference({ type: "meeting", accountId: owner.accountId, meetingId: owner.meetingId }),
        },
      ]
    }),
  )
}

/** Passages of one meeting share its `ref`, the reference evidence cites; each is still a hit of its own. */
const hitKey = (item: SearchAllItem): string =>
  item.kind === "meeting" ? `${item.ref}\u0000${item.scope}\u0000${item.id}` : item.ref

/**
 * Every source's hits as one list: each source's best hit first, then every other hit by cosine, then by its rank in
 * its source. Taking turns by rank (MEMO-37) gave each of two sources half of a ten-hit page however weak its hits;
 * one model scores every source, so cosine compares across them (IDEA-249). A hit only words found takes the cosine of
 * the hit above it in its source: its source ranked it there, and with none it would follow every hit meaning found.
 */
const oneList = (lists: SearchAllItem[][], cosines: Map<string, number>): SearchAllItem[] => {
  const place = new Map<string, { item: SearchAllItem; rank: number; cosine: number }>()
  for (const list of lists) {
    let above = Number.NEGATIVE_INFINITY
    list.forEach((item, rank) => {
      const key = hitKey(item)
      above = cosines.get(item.ref) ?? above
      const held = place.get(key)
      if (!held || rank < held.rank) place.set(key, { item, rank, cosine: above })
    })
  }
  const head = (rank: number) => Math.min(rank, 1)
  return [...place.values()]
    .sort((a, b) => head(a.rank) - head(b.rank) || b.cosine - a.cosine || a.rank - b.rank)
    .map(({ item }) => item)
}

const PERIOD_DEPTH = 100
const PERIOD_BOOST = 0.5

/**
 * A hit dated inside the question's period gains 0.5 over its place, 1 - rank/100: by rank, because only some hits have
 * a cosine to compare. One scale for every page, so paging past the first 100 never reorders what came before.
 */
const insidePeriodFirst = (ordered: SearchAllItem[], period: Period | undefined): SearchAllItem[] => {
  if (!period) return ordered
  const inside = ({ timestamp }: SearchAllItem) => {
    const at = timestamp === null ? Number.NaN : Date.parse(timestamp)
    return at >= period.from && at < period.to
  }
  return ordered
    .map((item, rank) => ({ item, score: 1 - rank / PERIOD_DEPTH + (inside(item) ? PERIOD_BOOST : 0) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
}
