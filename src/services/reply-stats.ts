import { CliError } from "@wirecat/cli-base"
import { parseLucene, type QueryNode, timezoneOf } from "@wirecat/cli-base/query"
import { delayStats } from "../domain/admin-statistics.js"
import { calendarKey } from "../domain/calendar.js"
import { rankingQuestion } from "../domain/rankings-options.js"
import type { ResolvedNode } from "../search/lucene/resolved.js"
import { MESSAGE_PARSING } from "../search/lucene/types.js"
import type { ChatScope, NewestMessage } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { prepareLucene } from "./messages-search.js"

export type ReplyWho = "me" | "others"
export interface ReplyFigures {
  replies: number
  medianMs: number | null
  p90Ms: number | null
  meanMs: number | null
}
export interface ReplyTimes extends ReplyFigures {
  who: ReplyWho
  by: "day" | "total"
  buckets: { under5m: number; under1h: number; under1d: number; over1d: number }
  rows: (ReplyFigures & { key: string })[]
}
export interface Waiting {
  chats: number
  messages: number
  oldestAt: string | null
  byKind: { private: number; group: number }
}
export interface ReplyQuery {
  text?: string
  source?: string
  timezone?: string
}
export interface ReplyStatsService {
  responses(query: ReplyQuery & { who: ReplyWho; by: "day" | "total" }): Promise<ReplyTimes>
  waiting(query: ReplyQuery): Promise<Waiting>
}

const FIELDS = ["date", "chat", "kind"]
/** Per waiting chat, how far back its unanswered messages are counted. */
export const WAITING_TAIL = 100

/** Only AND-ed `date:`, `chat:` and `kind:` terms: each becomes an index bound, so no query reads every message. */
const plainOnly = (text: string | undefined, command: string) => {
  if (text === undefined) return
  const refuse = (): never => {
    throw new CliError(
      "validation_error",
      `${command} reads date:, chat: and kind: terms, AND-ed — not words, other fields, OR or NOT`,
      { reason: "query.unsupported-field" },
    )
  }
  const visit = (node: QueryNode): void => {
    if (node.kind === "boolean")
      for (const clause of node.clauses) {
        if (clause.occur !== "must") refuse()
        visit(clause.node)
      }
    else if (!FIELDS.includes(node.field) || !["term", "phrase", "range"].includes(node.operator)) refuse()
  }
  visit(parseLucene(text, { ...MESSAGE_PARSING, defaultField: "text" }).root)
}

const scopeOf = (root: ResolvedNode, accounts: ChatScope["accounts"]): ChatScope => {
  const scope: ChatScope = { accounts, chats: [], kinds: [] }
  const visit = (node: ResolvedNode): void => {
    if (node.kind === "boolean") {
      for (const clause of node.clauses) visit(clause.node)
      return
    }
    const { chat, date } = node.resolution ?? {}
    if (chat) scope.chats.push(chat)
    else if (node.field === "kind") scope.kinds.push(node.value.toLowerCase())
    else if (date) {
      if (date.lower !== undefined) {
        const lower = date.lower + (date.lower_inclusive ? 0 : 1)
        scope.since = Math.max(scope.since ?? lower, lower)
      }
      if (date.upper !== undefined) {
        const upper = date.upper - (date.upper_inclusive ? 0 : 1)
        scope.until = Math.min(scope.until ?? upper, upper)
      }
    }
  }
  visit(root)
  return scope
}

const figuresOf = (delays: number[]): ReplyFigures => {
  const { medianMilliseconds, p90Milliseconds } = delayStats(delays)
  return {
    replies: delays.length,
    medianMs: medianMilliseconds,
    p90Ms: p90Milliseconds,
    meanMs: delays.length ? Math.round(delays.reduce((sum, one) => sum + one, 0) / delays.length) : null,
  }
}

const MINUTE = 60_000

/** Asks the owner something: a question in a one-to-one chat; in a group, a mention by id or `@handle`, or a reply. */
export const waitsOnOwner = (newest: NewestMessage): boolean => {
  if (newest.mine) return false
  if (newest.kind === "private") return !newest.quiet && rankingQuestion(newest.text)
  return (
    newest.addressed ||
    (newest.ownerUsername !== null &&
      new RegExp(`(^|[^\\w@])@${newest.ownerUsername.replace(/[^\w]/g, "\\$&")}(?!\\w)`, "i").test(newest.text))
  )
}

export const replyStatsService = (deps: ServiceDeps): ReplyStatsService => {
  const prepared = async (query: ReplyQuery, command: string) => {
    plainOnly(query.text, command)
    const store = await deps.store()
    const found = await prepareLucene(
      store,
      await deps.account(),
      {
        ...(query.text === undefined ? {} : { text: query.text }),
        ...(query.source === undefined ? {} : { source: query.source }),
        timezone: timezoneOf(query.timezone),
        limit: 1,
      },
      deps.messenger,
    )
    return { store, timezone: found.timezone, scope: scopeOf(found.execution.root, found.scopeAccounts) }
  }
  return {
    responses: async ({ who, by, ...query }) => {
      const { store, timezone, scope } = await prepared(query, "stats messages responses")
      const delays = scope.accounts.length ? await store.queries.replyDelays(scope, who) : []
      const buckets = { under5m: 0, under1h: 0, under1d: 0, over1d: 0 }
      for (const { delayMs } of delays) {
        if (delayMs < 5 * MINUTE) buckets.under5m++
        else if (delayMs < 60 * MINUTE) buckets.under1h++
        else if (delayMs < 24 * 60 * MINUTE) buckets.under1d++
        else buckets.over1d++
      }
      const days = new Map<string, number[]>()
      if (by === "day") {
        const keyOf = calendarKey(timezone, "day")
        for (const { repliedAt, delayMs } of delays) {
          const key = keyOf(repliedAt)
          const list = days.get(key) ?? []
          list.push(delayMs)
          days.set(key, list)
        }
      }
      return {
        who,
        by,
        ...figuresOf(delays.map(({ delayMs }) => delayMs)),
        buckets,
        rows: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ key, ...figuresOf(list) })),
      }
    },
    waiting: async (query) => {
      const { store, scope } = await prepared(query, "stats messages waiting")
      const chats = scope.accounts.length ? await store.queries.waitingChats(scope, waitsOnOwner, WAITING_TAIL) : []
      const firsts = chats.flatMap(({ unanswered }) => unanswered.at(-1) ?? [])
      return {
        chats: chats.length,
        messages: chats.reduce((sum, { unanswered }) => sum + unanswered.length, 0),
        oldestAt: firsts.length ? new Date(firsts.reduce((low, one) => Math.min(low, one))).toISOString() : null,
        byKind: {
          private: chats.filter(({ kind }) => kind === "private").length,
          group: chats.filter(({ kind }) => kind === "group").length,
        },
      }
    },
  }
}
