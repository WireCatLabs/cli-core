import { CliError } from "@wirecat/cli-base"
import type { Chat, Id, MessageHit } from "../domain/models.js"
import { capability, type MessengerAdapter, type ServerQuery } from "../ports/messenger.js"
import type { ResolvedNode } from "../search/lucene/resolved.js"
import type { AccountKey } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import type { SearchQuery } from "./messages.js"
import { prepareLucene } from "./messages-search.js"

export const SERVER_SEARCH_KEY = "messages.server-search"
/** `maxMessageBytes`: a candidate larger than this is not downloaded; a sync reads it, and the answer says so. */
export const SERVER_BOUNDS = { timeMs: 5_000, perCall: 100, maxCalls: 3, maxMessageBytes: 5_000_000 }
export const DEFAULT_BACKEND = "both"
export type Backend = "archive" | "server" | "both"
export interface ServerOptions {
  timeMs?: number
}
export type ServerSkip =
  | "unsupported"
  | "pushed_history"
  | "offline"
  | "not_allowed"
  | "other_accounts"
  | "no_words"
  | "needs_chat"
export interface ServerSearched {
  backend: "server" | "both"
  skipped: ServerSkip | null
  calls: number
  returned: number
  /** Messages the store did not hold before this search. */
  new: number
  failed: { chat: string | null; reason: "rate_limited" | "search_failed" | "time_or_abort_bound" }[]
  /** Candidates larger than `SERVER_BOUNDS.maxMessageBytes`, left on the server unread. */
  tooLarge?: number
  complete: boolean
}
export type HitSource = "archive" | "server" | "both"
export interface ServerStep {
  report: ServerSearched
  /** `chat id`/`message id` of each message the server returned → whether the store held it already. */
  sources: Map<string, "server" | "both">
}

export const sourceKey = (chatId: Id, id: Id) => JSON.stringify([chatId, id])

type Branch = { words: string[] } & Omit<ServerQuery, "text">

const merge = (one: Branch, other: Branch): Branch | undefined => {
  if (one.chat !== undefined && other.chat !== undefined && one.chat !== other.chat) return undefined
  if (one.from !== undefined && other.from !== undefined && one.from !== other.from) return undefined
  const chat = one.chat ?? other.chat
  const from = one.from ?? other.from
  const minDate = Math.max(one.minDate ?? -Infinity, other.minDate ?? -Infinity)
  const maxDate = Math.min(one.maxDate ?? Infinity, other.maxDate ?? Infinity)
  return {
    words: [...one.words, ...other.words],
    ...(chat === undefined ? {} : { chat }),
    ...(from === undefined ? {} : { from }),
    ...(Number.isFinite(minDate) ? { minDate } : {}),
    ...(Number.isFinite(maxDate) ? { maxDate } : {}),
  }
}

const sameAccount = (one: AccountKey, other: AccountKey) =>
  one.provider === other.provider && one.account === other.account

// Each branch is one server call that narrows the candidates; the strict local query decides. A
// part the server cannot read is left out, which only widens a branch, never drops a hit.
const branchesOf = (node: ResolvedNode, account: AccountKey): Branch[] => {
  if (node.kind === "predicate") {
    if ((node.field === "text" || node.field === "exact") && (node.operator === "term" || node.operator === "phrase"))
      return node.value === "" ? [{ words: [] }] : [{ words: [node.value] }]
    const { chat, sender, date } = node.resolution ?? {}
    if (chat) return sameAccount(chat.account, account) ? [{ words: [], chat: chat.chatId }] : []
    if (sender?.provider === account.provider) return [{ words: [], from: sender.id }]
    if (date)
      return [
        {
          words: [],
          ...(date.lower === undefined ? {} : { minDate: date.lower_inclusive ? date.lower : date.lower + 1 }),
          ...(date.upper === undefined ? {} : { maxDate: date.upper_inclusive ? date.upper : date.upper - 1 }),
        },
      ]
    return [{ words: [] }]
  }
  const must = node.clauses.filter(({ occur }) => occur === "must")
  if (must.length)
    return must.reduce<Branch[]>(
      (product, { node }) =>
        product.flatMap((one) => branchesOf(node, account).flatMap((other) => merge(one, other) ?? [])),
      [{ words: [] }],
    )
  const should = node.clauses.filter(({ occur }) => occur === "should")
  return should.length ? should.flatMap(({ node }) => branchesOf(node, account)) : [{ words: [] }]
}

const asQuery = ({ words, from, ...rest }: Branch): ServerQuery => ({
  text: words.join(" "),
  ...rest,
  ...(from !== undefined && rest.chat !== undefined ? { from } : {}),
})

const refusal: Record<ServerSkip, string> = {
  unsupported: "this messenger's server cannot search messages — use --backend archive",
  pushed_history: "this messenger's server cannot search messages — use --backend archive",
  offline: "--backend server needs the network — not with --offline",
  not_allowed: "the server search is not allowed by this profile",
  other_accounts: "the server searches only the account this runs as",
  no_words: "--backend server needs words to send to the server",
  needs_chat: "this messenger's server searches one chat at a time — name it with chat:",
}

const BOUND = Symbol("bound")

/**
 * Asks the messenger's server for candidates and saves them, so the strict local query that runs
 * next sees them. `both`, the default, falls back to the archive with a reason — silently when it was
 * not typed; only an explicit `server` refuses.
 * A reply that comes after the time bound is dropped unsaved, so nothing writes after the answer.
 */
export const searchServer = async (deps: ServiceDeps, request: SearchQuery): Promise<ServerStep | undefined> => {
  const backend = request.backend ?? DEFAULT_BACKEND
  if (backend === "archive") return undefined
  // Unasked, a search the server cannot take is just the archive's, with nothing to report.
  const quiet = request.backend === undefined
  const timeMs = request.server?.timeMs ?? SERVER_BOUNDS.timeMs
  if (!Number.isSafeInteger(timeMs) || timeMs < 1 || timeMs > 60_000)
    throw new CliError("validation_error", "the server time takes a whole number of milliseconds from 1 to 60000")
  const report: ServerSearched = { backend, skipped: null, calls: 0, returned: 0, new: 0, failed: [], complete: true }
  const sources = new Map<string, "server" | "both">()
  const skip = (reason: ServerSkip): ServerStep | undefined => {
    if (quiet) return undefined
    if (backend === "server")
      throw new CliError(reason === "not_allowed" ? "permission_error" : "validation_error", refusal[reason], {
        reason,
      })
    return { report: { ...report, skipped: reason, complete: false }, sources }
  }
  if (!deps.messenger.serverSearch) return skip("unsupported")
  if (deps.reads === "store") return skip("pushed_history")
  if (deps.offline) return skip("offline")
  const guardRequest = { chatId: null, kind: "reaction" as const, key: SERVER_SEARCH_KEY }
  // Never asked, as sync-first: over MCP an `ask` goes ahead, and the server search needs `allow`.
  try {
    deps.guard.check(guardRequest, { reserve: false })
  } catch (error) {
    if (backend === "server") throw error
    return skip("not_allowed")
  }
  const store = await deps.store()
  const account = await deps.account()
  const { execution } = await prepareLucene(store, account, request, deps.messenger)
  if (!execution.accounts.some((one) => sameAccount(one, account))) return skip("other_accounts")
  const scoped = execution.chat
    ? sameAccount(execution.chat.account, account)
      ? { words: [], chat: execution.chat.chatId }
      : undefined
    : { words: [] }
  if (!scoped) return skip("other_accounts")
  const all = branchesOf(execution.root, account).flatMap((branch) => merge(scoped, branch) ?? [])
  const unique = [
    ...new Map(all.filter(({ words }) => words.length).map((branch) => [JSON.stringify(branch), branch])).values(),
  ]
  if (!unique.length) return skip("no_words")
  if (deps.messenger.serverSearch === "chat" && unique.some(({ chat }) => chat === undefined)) return skip("needs_chat")
  if (unique.length > SERVER_BOUNDS.maxCalls) report.complete = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeMs)
  const stop = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
  const bound = new Promise<typeof BOUND>((resolve) => {
    if (stop.aborted) resolve(BOUND)
    stop.addEventListener("abort", () => resolve(BOUND), { once: true })
  })
  const calls = unique.slice(0, SERVER_BOUNDS.maxCalls)
  const pending = new Set(calls)
  const found: { items: MessageHit[]; chats: Chat[] }[] = []
  let open = true
  const fail = (branch: Branch, reason: ServerSearched["failed"][number]["reason"]) => {
    pending.delete(branch)
    report.complete = false
    report.failed.push({ chat: branch.chat ?? null, reason })
  }
  const ask = async (adapter: MessengerAdapter) => {
    const search = capability(adapter, "searchMessages", "search messages on its server")
    await Promise.all(
      calls.map(async (branch) => {
        if (!open) return
        report.calls += 1
        try {
          const page = await search(asQuery(branch), { limit: SERVER_BOUNDS.perCall, signal: stop })
          if (!open) return
          pending.delete(branch)
          if (page.hasMore) report.complete = false
          found.push(page)
        } catch (error) {
          if (!open) return
          fail(branch, error instanceof CliError && error.code === "rate_limited" ? "rate_limited" : "search_failed")
        }
      }),
    )
  }
  try {
    // A late page is dropped, never saved: nothing may write after the answer.
    const run = deps.withConnection ? deps.withConnection(ask) : deps.connection().then(ask)
    const outcome = await Promise.race([
      run.then(
        () => "done" as const,
        () => "failed" as const,
      ),
      bound,
    ])
    open = false
    for (const branch of [...pending]) fail(branch, outcome === "failed" ? "search_failed" : "time_or_abort_bound")
  } finally {
    open = false
    clearTimeout(timer)
  }
  const chats = new Map(found.flatMap(({ chats }) => chats).map((chat) => [chat.id, chat]))
  const byChat = new Map<Id, MessageHit[]>()
  for (const hit of found.flatMap(({ items }) => items)) {
    const key = sourceKey(hit.chatId, hit.id)
    if (sources.has(key)) continue
    report.returned += 1
    const held = await store.messages.message(account, hit.id, { chatId: hit.chatId })
    sources.set(key, held ? "both" : "server")
    if (!held) report.new += 1
    byChat.set(hit.chatId, [...(byChat.get(hit.chatId) ?? []), hit])
  }
  // A hit's chat carries no unread count or last activity, so it only fills in a chat the store lacks.
  const unknown: Chat[] = []
  for (const [chatId, chat] of chats)
    if (!(await store.messages.messages(account, chatId, { limit: 1 })).items.length) unknown.push(chat)
  if (unknown.length) await store.chats.saveChats(account, unknown)
  for (const [chatId, hits] of byChat)
    await store.messages.saveMessages(
      account,
      chatId,
      hits.map(({ chatTitle, ...message }) => message),
      { via: "search" },
    )
  return { report, sources }
}
