import { CliError } from "@wirecat/cli-base"
import type { QueryAst, QueryNode } from "@wirecat/cli-base/query"
import { holdsKind } from "../domain/providers.js"
import {
  formatMeetingReference,
  liftMeetingFields,
  type Meeting,
  type MeetingHitSearchRequest,
  parseMeetingQuery,
  READ_BUDGET_EXCEEDED,
  type SearchHit,
} from "../meetings/index.js"
import { fold } from "../store/normalize.js"
import type { AccountKey, MessageStore, StoredAccount } from "../store/store.js"
import { excerpt } from "./excerpt.js"
import { resolveMeetingSelection } from "./meeting-hit-search.js"
import type { Skipped } from "./search-all.js"

export interface MeetingSearchItem {
  kind: "meeting"
  /** `meeting:<account id>/<meeting id>`, the reference memo's notes, facts and memories cite as evidence. */
  ref: string
  provider: string
  account: string
  accountId: number
  title: string | null
  timestamp: string | null
  /** About 240 characters around the match. */
  text: string
  meetingId: number
  /** `title`: the meeting's title holds the words; `id` is then the meeting's. */
  scope: SearchHit["scope"] | "title"
  id: number
  startMs: number | null
  /** A transcript hit's cue, `meeting:<account>/<meeting>/<transcript>/<cue>`, which `meetings passage` opens. */
  cueRef?: string
  speakerName?: string | null
  language?: string | null
  line?: number
  linesTotal?: number
  foundBy: ("title" | "words")[]
  /** `corrected`: a query word matched only a spelling speech recognition may have garbled, listed in `corrections`. */
  match?: "corrected"
  corrections?: { from: string; to: string[] }[]
}

/** What one meeting account's index could answer. */
export interface MeetingAccountCoverage {
  provider: string
  account: string
  /** `pending`: passages saved since the index was last built are not found yet; `search meetings` builds it. */
  indexing: "ready" | "pending"
  hasMore: boolean
}

export interface MeetingLaneRequest {
  /** The query as `search all` reads it: fields meetings lack are refused, not read as words. */
  text: string
  exact?: boolean
  /** `text` is a question's words, any of which finds a passage; a title must hold every one. */
  question?: boolean
  timezone?: string
  /** How many hits the merged page needs from this lane. */
  window: number
  /** The meeting accounts `--source` chose; absent, every one in `scopes`. */
  accounts?: AccountKey[]
  /** The scopes whose meeting accounts are read; absent, the scope of the caller's stored account only. */
  scopes?: readonly StoredAccount["scope"][]
  /** Meetings were asked for by name (`--only meetings`): having none to read is then a skip, not silence. */
  asked?: boolean
  signal?: AbortSignal
}

export interface MeetingLaneFound {
  items: MeetingSearchItem[]
  hasMore: boolean
  read: StoredAccount[]
  skipped: Skipped<"meetings">[]
  coverage: MeetingAccountCoverage[]
}

/** More passages of one meeting would crowd out every other source. */
export const MOST_HITS_PER_MEETING = 3
/** Rows per page: the store refuses a page past 4 MB of text, which would skip the whole account. */
const PAGE_ROWS = 200
const MOST_PAGES = 25

const exactly = (node: QueryNode): QueryNode =>
  node.kind === "boolean"
    ? { ...node, clauses: node.clauses.map((clause) => ({ ...clause, node: exactly(clause.node) })) }
    : node.field === "text"
      ? { ...node, field: "exact" }
      : node

const positive = (node: QueryNode): boolean =>
  node.kind === "predicate" || node.clauses.some(({ occur, node }) => occur !== "must_not" && positive(node))

/** A word or phrase as the start of a title's word, as the passage index matches word starts. */
const titleNode = (node: QueryNode): QueryNode | undefined => {
  if (node.kind === "boolean") {
    const clauses = node.clauses.map((clause) => ({ ...clause, node: titleNode(clause.node) }))
    return clauses.every((clause) => clause.node) ? { ...node, clauses: clauses as typeof node.clauses } : undefined
  }
  if (
    (node.field !== "text" && node.field !== "exact") ||
    (node.operator !== "term" && node.operator !== "phrase") ||
    node.slop !== undefined
  )
    return undefined
  const word = node.value.replace(/[\\*?[]/gu, "\\$&")
  const starting = (value: string): QueryNode => ({ ...node, field: "title", operator: "wildcard", value })
  return {
    kind: "boolean",
    span: node.span,
    clauses: [
      { occur: "should", node: starting(`${word}*`) },
      { occur: "should", node: starting(`* ${word}*`) },
    ],
  }
}

/** A question finds passages by any of its words; a title holding one of them is no answer, so it needs them all. */
const everyWord = (node: QueryNode): QueryNode =>
  node.kind === "boolean"
    ? {
        ...node,
        clauses: node.clauses.map((clause) => (clause.occur === "should" ? { ...clause, occur: "must" } : clause)),
      }
    : node

/**
 * The query's words as a `meetings list` query over the folded title, or `undefined` when a title cannot answer it:
 * a speaker or nearness is about what was said, and project and tag are not title filters.
 */
const titleQuery = (query: QueryAst, input: MeetingHitSearchRequest, question: boolean): QueryAst | undefined => {
  if (input.projectId !== undefined || input.tagId !== undefined || !positive(query.root)) return undefined
  const root = titleNode(question ? everyWord(query.root) : query.root)
  return root && { ...query, root }
}

const titleWords = (title: string) => fold(title).match(/[\p{L}\p{N}]+/gu) ?? []

/** The SQL matches word starts; an exact word must be a whole word of the title. */
const holdsExactly = (node: QueryNode, words: string[]): boolean => {
  if (node.kind === "boolean") {
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const should = node.clauses.filter(({ occur }) => occur === "should")
    return (
      must.every((clause) => holdsExactly(clause.node, words)) &&
      !node.clauses.some(({ occur, node }) => occur === "must_not" && holdsExactly(node, words)) &&
      (must.length > 0 || should.length === 0 || should.some((clause) => holdsExactly(clause.node, words)))
    )
  }
  const wanted = titleWords(node.value)
  if (node.field !== "exact") return wanted.every((one) => words.some((word) => word.startsWith(one)))
  return ` ${words.join(" ")} `.includes(` ${wanted.join(" ")} `)
}

const sameAccount = (one: AccountKey, other: AccountKey) =>
  one.provider === other.provider && one.account === other.account

/**
 * The caller's stored account's scope, as a person's context reads: a work profile never reads personal meetings.
 * A caller the store does not hold reads its stated scope, or none.
 */
const callerScopes = async (all: readonly StoredAccount[], caller: AccountKey): Promise<StoredAccount["scope"][]> => {
  const own = all.find((one) => sameAccount(one, caller))
  if (own && caller.scope !== undefined && caller.scope !== own.scope)
    throw new CliError("not_found", `no ${caller.provider} account ${caller.account} in the store`)
  const scope = own?.scope ?? caller.scope
  return scope === undefined ? [] : [scope]
}

/**
 * Meetings for `search all`, from each meeting account's search index: never refreshed here, since search all only
 * reads. A query meetings cannot answer is refused before any account is read; a failure of one account is that
 * account's skip, and the others still answer.
 */
export const meetingLane = async (
  store: MessageStore,
  caller: AccountKey,
  request: MeetingLaneRequest,
): Promise<MeetingLaneFound> => {
  const all = await store.accounts.storedAccounts()
  const scopes = request.scopes ?? (await callerScopes(all, caller))
  const unknownCaller = request.scopes === undefined && !all.some((one) => sameAccount(one, caller))
  const meetings = all.filter((one) => holdsKind(one.provider, "meetings"))
  const stored = meetings.filter((one) => scopes.includes(one.scope))
  const chosen = request.accounts
  const read = chosen ? stored.filter((one) => chosen.some((key) => sameAccount(key, one))) : stored
  const skipped: Skipped<"meetings">[] = (chosen ?? [])
    .filter((key) => !read.some((one) => sameAccount(key, one)))
    .map(({ provider, account }) => {
      const other = meetings.find((one) => sameAccount({ provider, account }, one))
      return {
        source: `${provider}:${account}`,
        code: "not_found",
        reason: !other
          ? "no meetings stored for it"
          : unknownCaller
            ? "this account is not in the store yet, so no scope is read"
            : `a ${other.scope} account; this run reads ${scopes.join(" and ")} accounts`,
      }
    })
  const [first] = read
  // Like events, meetings the store does not hold are no gap in an answer that did not ask for them.
  if (!first) {
    if (!skipped.length && request.asked)
      skipped.push({
        resource: "meetings",
        code: "not_found",
        reason: !meetings.length
          ? "no meeting account stored"
          : unknownCaller
            ? "this account is not in the store yet"
            : "no meeting account in this scope",
      })
    return { items: [], hasMore: false, read, skipped, coverage: [] }
  }

  const lifted = liftMeetingFields(request.text, { accountId: first.id }, undefined, request.timezone)
  const parsed = parseMeetingQuery(lifted.query)
  const query: QueryAst = request.exact ? { ...parsed, root: exactly(parsed.root) } : parsed
  const { input } = await resolveMeetingSelection(store, {
    ...lifted.request,
    ...(request.signal ? { signal: request.signal } : {}),
  })

  const lists: Ranked[][] = []
  const coverage: MeetingAccountCoverage[] = []
  const answered: StoredAccount[] = []
  for (const account of read) {
    try {
      const found = await accountHits(store, account, query, { ...input, accountId: account.id }, request)
      lists.push(found.ranked)
      coverage.push({ provider: account.provider, account: account.account, ...found.coverage })
      answered.push(account)
    } catch (error) {
      if (!(error instanceof CliError) || error.code === "cancelled") throw error
      skipped.push({ source: `${account.provider}:${account.account}`, code: error.code, reason: error.message })
    }
  }
  return { items: merged(lists), hasMore: coverage.some((one) => one.hasMore), read: answered, skipped, coverage }
}

/** A hit with what orders it among other accounts' hits: its tier, then how recent its meeting is. */
interface Ranked {
  item: MeetingSearchItem
  tier: number
  started: number
}

/**
 * Every account's hits as one list, each account's own order kept: the better head goes first, so an account with
 * many hits cannot push another's newer or closer ones off the page.
 */
const merged = (lists: Ranked[][]): MeetingSearchItem[] => {
  const heads = lists.map((list) => ({ list, at: 0 }))
  const items: MeetingSearchItem[] = []
  for (;;) {
    let best: { list: Ranked[]; at: number } | undefined
    for (const one of heads) {
      const head = one.list[one.at]
      const leader = best?.list[best.at]
      if (head && (!leader || head.tier < leader.tier || (head.tier === leader.tier && head.started > leader.started)))
        best = one
    }
    const next = best?.list[best.at]
    if (!best || !next) return items
    items.push(next.item)
    best.at++
  }
}

const accountHits = async (
  store: MessageStore,
  account: StoredAccount,
  query: QueryAst,
  input: MeetingHitSearchRequest,
  { text, window, signal, question, exact }: MeetingLaneRequest,
) => {
  const ranked: Ranked[] = []
  const perMeeting = new Map<number, number>()
  const keep = (one: Ranked) => {
    const seen = perMeeting.get(one.item.meetingId) ?? 0
    if (seen >= MOST_HITS_PER_MEETING) return false
    perMeeting.set(one.item.meetingId, seen + 1)
    ranked.push(one)
    return true
  }
  let indexing: MeetingAccountCoverage["indexing"] = "ready"
  let hasMore = false
  let passages = 0
  const titles = titleQuery(query, input, question === true)
  if (titles)
    for (const meeting of await store.meetings.meetings({
      accountId: account.id,
      query: titles,
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      limit: window + 1,
    }))
      if (!exact || holdsExactly(query.root, titleWords(meeting.title ?? "")))
        keep({ item: titleItem(account, meeting, text), tier: 1, started: meeting.startedAt ?? 0 })
  let after: string | undefined
  let rows = Math.min(PAGE_ROWS, window + 1)
  for (let page = 1; ; page++) {
    let found: Awaited<ReturnType<typeof store.meetings.searchHits>>
    try {
      found = await store.meetings.searchHits(query, {
        ...input,
        limit: rows,
        ...(after === undefined ? {} : { after }),
      })
    } catch (error) {
      // Long summaries can pass the store's byte budget in a few rows; fewer rows a page still reads the account.
      if (!(error instanceof CliError) || error.message !== READ_BUDGET_EXCEEDED || rows === 1) throw error
      rows = Math.ceil(rows / 2)
      page--
      continue
    }
    signal?.throwIfAborted()
    if (found.coverage.indexing === "pending") indexing = "pending"
    for (const hit of found.items)
      if (
        keep({
          item: meetingItem(account, hit, text),
          tier: hit.match === "corrected" ? 2 : 1,
          started: hit.source?.startedAt ?? 0,
        })
      )
        passages++
    // Titles rank among the passages, so the passages alone must reach past the page.
    if (passages > window || !found.hasMore || found.nextCursor === null) break
    if (page === MOST_PAGES) {
      hasMore = true
      break
    }
    after = found.nextCursor
  }
  // A title hit ranks as a passage that holds the words: by tier, then the newer meeting; sort keeps it before its own.
  ranked.sort((one, other) => one.tier - other.tier || other.started - one.started)
  return {
    ranked: ranked.slice(0, window),
    coverage: { indexing, hasMore: hasMore || ranked.length > window },
  }
}

const meetingItem = (account: StoredAccount, hit: SearchHit & { ref: string }, query: string): MeetingSearchItem => ({
  kind: "meeting",
  ref: formatMeetingReference({ type: "meeting", accountId: account.id, meetingId: hit.meetingId }),
  provider: account.provider,
  account: account.account,
  accountId: account.id,
  title: hit.source?.title ?? null,
  timestamp: typeof hit.source?.startedAt === "number" ? new Date(hit.source.startedAt).toISOString() : null,
  // Centred on the words the index matched: another form, a garbled spelling, never a word only under NOT.
  text: hit.matchedWords?.length
    ? excerpt(hit.text, hit.matchedWords.join(" "), 240, { literal: true })
    : excerpt(hit.text, query),
  meetingId: hit.meetingId,
  scope: hit.scope,
  id: hit.id,
  startMs: hit.startMs,
  foundBy: ["words"],
  ...(hit.match === "corrected" ? { match: hit.match, corrections: hit.corrections ?? [] } : {}),
  ...(hit.scope === "transcript"
    ? {
        cueRef: hit.ref,
        speakerName: hit.speakerName ?? null,
        language: hit.language ?? null,
        ...(hit.line === undefined ? {} : { line: hit.line, linesTotal: hit.linesTotal }),
      }
    : {}),
})

const titleItem = (account: StoredAccount, meeting: Meeting, query: string): MeetingSearchItem => ({
  kind: "meeting",
  ref: formatMeetingReference({ type: "meeting", accountId: account.id, meetingId: meeting.id }),
  provider: account.provider,
  account: account.account,
  accountId: account.id,
  title: meeting.title,
  timestamp: meeting.startedAt === null ? null : new Date(meeting.startedAt).toISOString(),
  text: excerpt(meeting.title ?? "", query),
  meetingId: meeting.id,
  scope: "title",
  id: meeting.id,
  startMs: null,
  foundBy: ["title"],
})
