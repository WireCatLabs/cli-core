import { CliError } from "@wirecat/cli-base"
import { parseDuration } from "../cli/settings.js"
import type { QueryExecution, ResolvedNode } from "../search/lucene/resolved.js"
import type { AccountKey } from "../store/store.js"
import { archiveService } from "./archive.js"
import type { ServiceDeps } from "./deps.js"
import { type SearchQuery, scopeOf, validateSearchDialect } from "./messages.js"
import { prepareLucene } from "./messages-search.js"

export const SYNC_KEY = "messages.sync-first"
export const SYNC_BOUNDS = { maxChats: 5, timeMs: 30_000, maxMessages: 500 }
export interface SyncOptions {
  maxChats?: number
  timeMs?: number
  maxMessages?: number
  note?: (message: string) => void
}
export interface SearchRefreshed {
  chats: string[]
  messages: number
  failed: { account: AccountKey; chat: string | null; reason: string }[]
  complete: boolean
}

type ChatScope = NonNullable<QueryExecution["chat"]>
const keyOf = (chat: ChatScope) => JSON.stringify([chat.account.provider, chat.account.account, chat.chatId])
const sameAccount = (one: AccountKey, other: AccountKey) =>
  one.provider === other.provider && one.account === other.account

const chatScope = (node: ResolvedNode): ChatScope[] | undefined => {
  if (node.kind === "predicate") return node.resolution?.chat ? [node.resolution.chat] : undefined
  const required = node.clauses.filter(({ occur }) => occur === "must").map(({ node }) => chatScope(node))
  const bounded = required.filter((scope) => scope !== undefined)
  if (bounded.length)
    return bounded.reduce((one, other) => one.filter((chat) => other.some((at) => keyOf(at) === keyOf(chat))))
  const optional = node.clauses.filter(({ occur }) => occur === "should").map(({ node }) => chatScope(node))
  if (!optional.length || optional.some((scope) => scope === undefined)) return undefined
  return optional.flatMap((scope) => scope ?? [])
}

const matchesChat = (node: ResolvedNode, chat: ChatScope): boolean | undefined => {
  if (node.kind === "predicate") return node.resolution?.chat ? keyOf(node.resolution.chat) === keyOf(chat) : undefined
  const must = node.clauses.filter(({ occur }) => occur === "must").map(({ node }) => matchesChat(node, chat))
  const excluded = node.clauses.filter(({ occur }) => occur === "must_not").map(({ node }) => matchesChat(node, chat))
  if (must.includes(false) || excluded.includes(true)) return false
  const should = node.clauses.filter(({ occur }) => occur === "should").map(({ node }) => matchesChat(node, chat))
  if (!must.length && should.length && should.every((match) => match === false)) return false
  if (must.includes(undefined) || excluded.includes(undefined) || (!must.length && should.includes(undefined)))
    return undefined
  return true
}

export const refreshSearch = async (deps: ServiceDeps, request: SearchQuery): Promise<SearchRefreshed | undefined> => {
  if (!request.syncFirst) return undefined
  for (const [name, value, max] of [
    ["maxChats", request.syncFirst.maxChats ?? SYNC_BOUNDS.maxChats, 100],
    ["timeMs", request.syncFirst.timeMs ?? SYNC_BOUNDS.timeMs, 300_000],
    ["maxMessages", request.syncFirst.maxMessages ?? SYNC_BOUNDS.maxMessages, 10_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new CliError("validation_error", `${name} takes a whole number from 1 to ${max}`)
  }
  validateSearchDialect(request)
  const guardRequest = { chatId: null, kind: "reaction" as const, key: SYNC_KEY }
  await deps.guard.ask?.(guardRequest)
  deps.guard.check(guardRequest, { reserve: false })
  const store = await deps.store()
  const account = await deps.account()
  const strict = request.language === "lucene" || request.ast !== undefined
  const execution = strict
    ? (await prepareLucene(store, account, request, deps.messenger)).execution
    : (
        await scopeOf(deps.messenger, store, account, { ...request, text: request.pattern ? "" : (request.text ?? "") })
      )[1]
  const scoped = execution.chat ? [execution.chat] : "root" in execution ? chatScope(execution.root) : undefined
  const options = { ...SYNC_BOUNDS, ...request.syncFirst }
  const note = options.note ?? (() => {})
  const result: SearchRefreshed = { chats: [], messages: 0, failed: [], complete: true }
  const candidates: ChatScope[] = []
  for (const selected of execution.accounts) {
    if (scoped !== undefined && !scoped.some((chat) => sameAccount(chat.account, selected))) continue
    if (!sameAccount(account, selected)) {
      result.failed.push({ account: selected, chat: null, reason: "account_not_connected" })
      result.complete = false
      continue
    }
    if (scoped === undefined)
      for (const { id } of (await store.chats(selected, {})).items) candidates.push({ account: selected, chatId: id })
    else for (const chat of scoped) if (sameAccount(chat.account, selected)) candidates.push(chat)
  }
  const eligible =
    "root" in execution ? candidates.filter((chat) => matchesChat(execution.root, chat) !== false) : candidates
  const unique = [...new Map(eligible.map((chat) => [keyOf(chat), chat])).values()]
  if (unique.length > options.maxChats) result.complete = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeMs)
  const stop = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
  try {
    for (const { chatId } of unique.slice(0, options.maxChats)) {
      if (stop.aborted || result.messages >= options.maxMessages) {
        result.complete = false
        result.failed.push({ account, chat: chatId, reason: stop.aborted ? "time_or_abort_bound" : "message_bound" })
        break
      }
      result.chats.push(chatId)
      if (deps.offline || deps.reads === "store") {
        result.failed.push({ account, chat: chatId, reason: deps.offline ? "offline" : "pushed_history" })
        result.complete = false
        continue
      }
      try {
        const newest = (await store.messages(account, chatId, { limit: 1 })).items[0]
        let counted = 0
        const fetched = await archiveService(deps).fetch(chatId, {
          limit: options.maxMessages - result.messages,
          pageSize: Math.min(100, deps.messenger.fetching?.maxPageSize ?? 100),
          pauseMs: parseDuration(deps.messenger.fetching?.pause ?? "1s", "fetch pause"),
          ...(newest ? { sinceMs: Date.parse(newest.timestamp) + 1 } : {}),
          stop,
          note,
          onPage: ({ fetched }) => {
            result.messages += fetched - counted
            counted = fetched
          },
        })
        result.messages += fetched.fetched - counted
        if (fetched.stopped || (!fetched.complete && !fetched.reachedSince)) {
          result.complete = false
          result.failed.push({
            account,
            chat: chatId,
            reason: fetched.stopped ? "time_or_abort_bound" : "message_bound",
          })
        }
      } catch {
        result.complete = false
        result.failed.push({ account, chat: chatId, reason: stop.aborted ? "time_or_abort_bound" : "fetch_failed" })
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (!result.complete) note("refresh incomplete — the local answer may be stale")
  return result
}

export const withRefresh = <T extends { coverage?: { state: string } }>(found: T, refreshed?: SearchRefreshed) => ({
  ...found,
  ...(refreshed ? { refreshed } : {}),
  ...(!refreshed || refreshed.complete ? {} : { coverage: { ...found.coverage, state: "stale" as const } }),
})
