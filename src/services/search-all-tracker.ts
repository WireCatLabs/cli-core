import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import { hasGlobalItemIds } from "../domain/providers.js"
import { type TrackerIssue, trackerBodyOf, trackerTitleOf } from "../domain/tracker.js"
import { runEmbedders, type WarmEmbedders } from "../embeddings/embed.js"
import { plainQuery } from "../search/lucene/plain.js"
import { questionPeriod } from "../search/question-period.js"
import { questionLookup, questionText } from "../search/question-plan.js"
import type { AccountKey, MessageStore, TrackerItem, TrackerNearest } from "../store/store.js"
import { excerpt } from "./excerpt.js"
import type { SearchAllFound, SearchAllRecordItem } from "./search-all.js"
import {
  contentWords,
  fusedLane,
  insidePeriodFirst,
  meaningWordsOf,
  oneList,
  PERIOD_DEPTH,
  titleWords,
} from "./search-all-rank.js"
import { nearestTracker } from "./tracker-meaning.js"

const TRACKER_HIT_KINDS = { issue: "issue", project: "project", comment: "issue_comment" } as const

/** An issue is titled as people say it, `ENG-12 Fix login`; anything else by its name or its first line. */
const trackerTitle = ({ kind, record }: TrackerItem): string => {
  const title = trackerTitleOf(kind, record)
  const key = kind === "issue" ? (record as TrackerIssue).key : undefined
  return key ? `${key} ${title}` : title
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

interface TrackerLaneRequest {
  text: string
  accounts: AccountKey[]
  depth: number
  discover: boolean
  exact?: boolean
  /** Filled with each hit found by meaning, by its cosine. */
  cosines: Map<string, number>
  embedders: Pick<WarmEmbedders, "get">
  command?: string
  env?: NodeJS.ProcessEnv
}

const TRACKER_DEPTH = 500

/**
 * Issues, projects and comments by words, and by meaning when the model and some vectors are there, fused as notes
 * fuse theirs; `records` gives each hit's record by its ref. A query naming a field an issue lacks is a `validation_error`.
 */
export const trackerLane = async (
  store: MessageStore,
  { text, accounts: read, depth, discover, exact, cosines, embedders, command, env }: TrackerLaneRequest,
) => {
  const { words, anyWord } = contentWords(
    titleWords(text, "issues, projects and comments are found by the words and meaning of their title and text only"),
    discover,
  )
  // Two sign-ins to one workspace hold each item twice, and the copies fold into one hit: read deep enough that the
  // folded list still fills the page.
  const deep = Math.min(depth * read.length, TRACKER_DEPTH)
  const found = await store.tracker.find({
    words,
    anyWord: anyWord || discover,
    ...(exact ? { exact: true } : {}),
    kinds: ["issue", "project", "comment"],
    limit: deep,
    accounts: read,
  })
  const items = new Map<string, string>()
  const records = new Map<string, TrackerItem>()
  const hitOf = (
    at: AccountKey,
    item: TrackerItem,
    excerpt: string,
    foundBy: SearchAllRecordItem["foundBy"],
  ): SearchAllRecordItem => {
    const ref = `tracker:${at.provider}/${at.account}/${item.kind}/${item.record.externalId}`
    if (hasGlobalItemIds(at.provider)) items.set(ref, JSON.stringify([at.provider, item.kind, item.record.externalId]))
    records.set(ref, item)
    return {
      kind: TRACKER_HIT_KINDS[item.kind as keyof typeof TRACKER_HIT_KINDS],
      // Two sign-ins see the same issue under the same id, so the account keeps their hits apart.
      ref,
      provider: at.provider,
      account: at.account,
      ...((item.record as { url?: string | null }).url ? { url: (item.record as { url: string }).url } : {}),
      title: trackerTitle(item),
      timestamp: new Date(item.record.updatedAt ?? item.syncedAt).toISOString(),
      text: excerpt,
      foundBy,
    }
  }
  const byWords = found.items.map(({ account: at, item, excerpt: text }) => hitOf(at, item, text, ["words"]))
  const plain = meaningWordsOf(discover ? questionText(text) : text)
  let near: TrackerNearest[] | undefined
  let meaningSkipped: string | undefined
  let meaningReason: string | undefined
  if (exact) meaningSkipped = "--exact searches words as written"
  else if (plain === undefined) meaningSkipped = "the query names a title, which meaning cannot follow"
  else
    try {
      near = await nearestTracker(store, plain, {
        limit: deep,
        accounts: read,
        embedders,
        ...(command === undefined ? {} : { command }),
        ...(env === undefined ? {} : { env }),
      })
    } catch (error) {
      if (!(error instanceof CliError && error.code === "not_found")) throw error
      meaningSkipped = error.message
      const { reason } = error.details as { reason?: unknown }
      if (typeof reason === "string") meaningReason = reason
    }
  const tracker: NonNullable<SearchAllFound["tracker"]> = {
    by: near === undefined ? "words" : "words and meaning",
    ...(meaningSkipped === undefined ? {} : { meaningSkipped }),
  }
  const hits =
    near === undefined
      ? oneHitPerItem(byWords, cosines, items)
      : oneHitPerItem(
          fusedLane(
            byWords,
            near.map(({ account: at, item, score }) => ({
              hit: hitOf(at, item, trackerExcerpt(item, text), ["meaning"]),
              score,
            })),
            discover,
            cosines,
          ),
          cosines,
          items,
        )
  return { hits, records, hasMore: found.hasMore, tracker, ...(meaningReason ? { meaningReason } : {}) }
}

/** One hit of `searchTracker`: the record beside how `search all` shows it. */
export interface TrackerSearchHit {
  hit: SearchAllRecordItem
  item: TrackerItem
}

export interface TrackerSearchFound {
  items: TrackerSearchHit[]
  hasMore: boolean
  by: "words" | "words and meaning"
  /** Why meaning was not searched, when it was not. */
  meaningSkipped?: string
  /** `model.not-downloaded`, or `tracker.no-vectors` when the model is there but nothing is embedded with it. */
  meaningReason?: string
}

/**
 * A tracker CLI's own search over its accounts' copies, ranked as the tracker lane of `search all` ranks them: words,
 * and meaning once `sync --embed` built the vectors; a question finds what holds some of its words.
 */
export const searchTracker = async (
  store: MessageStore,
  request: {
    text: string
    accounts: AccountKey[]
    limit: number
    offset?: number
    now?: number
    timezone?: string
    command?: string
    env?: NodeJS.ProcessEnv
  },
): Promise<TrackerSearchFound> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find")
  const text = plainQuery(request.text)
  const offset = request.offset ?? 0
  const window = offset + request.limit
  const period = questionPeriod(text, request.now ?? Date.now(), timezoneOf(request.timezone))
  const cosines = new Map<string, number>()
  const embedders = runEmbedders()
  try {
    const found = await trackerLane(store, {
      text,
      accounts: request.accounts,
      depth: Math.max(window, period ? PERIOD_DEPTH : 0),
      discover: questionLookup(text) !== undefined,
      cosines,
      embedders,
      ...(request.command === undefined ? {} : { command: request.command }),
      ...(request.env === undefined ? {} : { env: request.env }),
    })
    const ordered = insidePeriodFirst(oneList([found.hits], cosines), period) as SearchAllRecordItem[]
    return {
      items: ordered.slice(offset, window).map((hit) => ({ hit, item: found.records.get(hit.ref) as TrackerItem })),
      // The lane reads at most 500 rows, so a page past them would be empty and say there are more.
      hasMore: window < TRACKER_DEPTH && (found.hasMore || ordered.length > window),
      by: found.tracker.by,
      ...(found.tracker.meaningSkipped === undefined ? {} : { meaningSkipped: found.tracker.meaningSkipped }),
      ...(found.meaningReason === undefined ? {} : { meaningReason: found.meaningReason }),
    }
  } finally {
    await embedders.close()
  }
}
