import { CliError } from "@wirecat/cli-base"
import { RULES_VERSION } from "../conversations/link.js"
import { formatLocator } from "../domain/locator.js"
import type { Id, WindowedMessage } from "../domain/models.js"
import { isCliFailure } from "../errors/failures.js"
import type { AccountKey, MessageStore, StoredLink } from "../store/store.js"

export const THREAD_BOUNDS = { maxHops: 8, maxMessages: 50, maxBytes: 65_536, withinMs: 86_400_000 }
export interface ThreadOptions {
  maxHops?: number
  maxMessages?: number
  maxBytes?: number
  withinMs?: number
  before?: number
  after?: number
  signal?: AbortSignal
}
export interface ThreadContext {
  ref: string
  chat: Id
  message: Id
  mode: "thread" | "time"
  fallback?: "not_built" | "not_stored" | "not_linked"
  items: WindowedMessage[]
  links: (StoredLink & { messageId: Id; chosen: boolean })[]
  chain: Id[]
  stale: boolean
  builtAt: string | null
  stopped: ("hops" | "messages" | "bytes" | "time" | "links" | "cycle" | "aborted" | "thread")[]
  bounds: typeof THREAD_BOUNDS
}
const bytes = (items: ThreadContext["items"], links: ThreadContext["links"]) =>
  Buffer.byteLength(JSON.stringify({ items, links }), "utf8")

export const threadBounds = (options: ThreadOptions = {}): typeof THREAD_BOUNDS => {
  const bounds = {
    maxHops: options.maxHops ?? THREAD_BOUNDS.maxHops,
    maxMessages: options.maxMessages ?? THREAD_BOUNDS.maxMessages,
    maxBytes: options.maxBytes ?? THREAD_BOUNDS.maxBytes,
    withinMs: options.withinMs ?? THREAD_BOUNDS.withinMs,
  }
  for (const [name, value, maximum] of [
    ["maxHops", bounds.maxHops, 50],
    ["maxMessages", bounds.maxMessages, 500],
    ["maxBytes", bounds.maxBytes, 1_048_576],
    ["withinMs", bounds.withinMs, 2_592_000_000],
    ["before", options.before ?? 5, 100],
    ["after", options.after ?? 5, 100],
  ] as const) {
    if (
      !Number.isSafeInteger(value) ||
      value < (name === "maxHops" || name === "before" || name === "after" ? 0 : 1) ||
      value > maximum
    )
      throw new CliError("validation_error", `${name} is outside the thread context bounds (maximum ${maximum})`)
  }
  return bounds
}

export const readThreadContext = async (
  store: MessageStore,
  account: AccountKey,
  chat: Id,
  message: Id,
  options: ThreadOptions = {},
): Promise<ThreadContext> => {
  const bounds = threadBounds(options)
  const result: ThreadContext = {
    ref: formatLocator({ ...account, chat, message }),
    chat,
    message,
    mode: "thread",
    items: [],
    links: [],
    chain: [],
    stale: false,
    builtAt: null,
    stopped: [],
    bounds,
  }
  const stopped = (reason: ThreadContext["stopped"][number]) => {
    if (!result.stopped.includes(reason)) result.stopped.push(reason)
  }
  if (options.signal?.aborted) {
    stopped("aborted")
    return result
  }
  const around = (id: Id, before = 0, after = 0) =>
    store.around(account, chat, id, { before, after }).catch((error: unknown) => {
      if (isCliFailure(error) && error.code === "not_found") return []
      throw error
    })
  const [anchor] = await around(message)
  const state = await store.conversationState(account, chat)
  result.builtAt = state?.builtAt ?? null
  const linked = anchor && state?.builtAt ? (await store.conversationOf(account, chat, message)) !== undefined : false
  const repliesTo = store.replies.bind(store)
  if (!anchor || !state?.builtAt || !linked) {
    result.mode = "time"
    result.fallback = !anchor ? "not_stored" : !state?.builtAt ? "not_built" : "not_linked"
    result.stale = state?.builtAt !== undefined && state?.builtAt !== null && !linked
    const wantedBefore = options.before ?? 5
    const wantedAfter = options.after ?? 5
    const available = bounds.maxMessages - 1
    let before = Math.min(wantedBefore, Math.ceil(available / 2))
    const after = Math.min(wantedAfter, available - before)
    before = Math.min(wantedBefore, available - after)
    if (anchor && before + after < wantedBefore + wantedAfter) stopped("messages")
    const neighbours = anchor ? await around(message, before, after) : []
    // Keep the hit when the byte/message cap cannot fit its neighbours.
    const nearest = neighbours.sort(
      (a, b) =>
        Number(a.id !== message) - Number(b.id !== message) ||
        Math.abs(Date.parse(a.timestamp) - Date.parse(anchor?.timestamp ?? "")) -
          Math.abs(Date.parse(b.timestamp) - Date.parse(anchor?.timestamp ?? "")),
    )
    for (const item of nearest) {
      if (item.threadId !== anchor?.threadId) {
        stopped("thread")
        continue
      }
      if (result.items.length >= bounds.maxMessages) {
        stopped("messages")
        break
      }
      if (Math.abs(Date.parse(item.timestamp) - Date.parse(anchor?.timestamp ?? "")) > bounds.withinMs) {
        stopped("time")
        continue
      }
      if (bytes([...result.items, item], []) > bounds.maxBytes) {
        stopped("bytes")
        break
      }
      result.items.push(item)
    }
    result.items.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
    return result
  }
  result.stale = state.algorithmVersion !== RULES_VERSION
  const at = Date.parse(anchor.timestamp)
  const cache = new Map<Id, StoredLink[]>()
  const linksOf = async (id: Id) => {
    if (!cache.has(id)) {
      const rows = await store.links(account, chat, id, { limit: bounds.maxMessages + 1 })
      if (rows.length > bounds.maxMessages) stopped("links")
      cache.set(
        id,
        rows.slice(0, bounds.maxMessages).map((link) => ({
          ...link,
          stale: link.stale || (link.source !== "agent" && state.algorithmVersion !== RULES_VERSION),
        })),
      )
    }
    return cache.get(id) as StoredLink[]
  }
  const chosen = (links: StoredLink[]) => links.find((link) => !link.stale)
  const queue: { id: Id; hops: number; previous?: Id }[] = [{ id: message, hops: 0 }]
  const queued = new Set<Id>([message])
  const parents = new Map<Id, Id>()
  for (let index = 0; index < queue.length; index++) {
    if (options.signal?.aborted) {
      stopped("aborted")
      break
    }
    const node = queue[index] as (typeof queue)[number]
    const [item] = node.id === message ? [anchor] : await around(node.id)
    if (!item) {
      result.stale = true
      continue
    }
    if (Math.abs(Date.parse(item.timestamp) - at) > bounds.withinMs) {
      stopped("time")
      continue
    }
    if (item.threadId !== anchor.threadId) {
      stopped("thread")
      continue
    }
    if (result.items.length >= bounds.maxMessages) {
      stopped("messages")
      break
    }
    const { anchor: _anchor, ...body } = item
    const displayed: WindowedMessage = node.id === message ? { ...body, anchor: true } : body
    const own = await linksOf(node.id)
    const parent = chosen(own)
    const evidence = own
      .filter((link) => link === parent || link.stale)
      .map((link) => ({ ...link, messageId: node.id, chosen: link === parent }))
      .filter(
        (link) =>
          !result.links.some(
            (old) =>
              old.messageId === link.messageId &&
              old.parentId === link.parentId &&
              old.source === link.source &&
              old.kind === link.kind &&
              old.method === link.method,
          ),
      )
    result.stale ||= evidence.some((link) => link.stale)
    if (bytes([...result.items, displayed], [...result.links, ...evidence]) > bounds.maxBytes) {
      stopped("bytes")
      break
    }
    result.items.push(displayed)
    result.links.push(...evidence)
    if (parent?.parentId) parents.set(node.id, parent.parentId)
    const add = (id: Id) => {
      if (queued.has(id)) return
      if (node.hops >= bounds.maxHops) {
        stopped("hops")
        return
      }
      if (queued.size >= bounds.maxMessages) {
        stopped("messages")
        return
      }
      queued.add(id)
      queue.push({ id, hops: node.hops + 1, previous: node.id })
    }
    if (parent?.parentId && parent.parentId !== node.previous) add(parent.parentId)
    const replies = await repliesTo(account, chat, node.id, Math.max(1, bounds.maxMessages - cache.size))
    if (replies.hasMore) stopped("messages")
    for (const child of replies.items) {
      if (cache.size >= bounds.maxMessages && !cache.has(child.messageId)) {
        stopped("links")
        break
      }
      const childLinks = await linksOf(child.messageId)
      if (chosen(childLinks)?.parentId === node.id) add(child.messageId)
      else if (childLinks.some((link) => link.stale && link.parentId === node.id)) {
        result.stale = true
        const stale = childLinks
          .filter((link) => link.stale && link.parentId === node.id)
          .map((link) => ({ ...link, messageId: child.messageId, chosen: false }))
          .filter(
            (link) =>
              !result.links.some(
                (old) =>
                  old.messageId === link.messageId &&
                  old.parentId === link.parentId &&
                  old.source === link.source &&
                  old.kind === link.kind &&
                  old.method === link.method,
              ),
          )
        if (bytes(result.items, [...result.links, ...stale]) <= bounds.maxBytes) result.links.push(...stale)
        else stopped("bytes")
      }
    }
  }
  const held = new Set(result.items.map(({ id }) => id))
  const seen = new Set<Id>([message])
  for (let parent = parents.get(message); parent !== undefined && held.has(parent); parent = parents.get(parent)) {
    if (seen.has(parent)) {
      stopped("cycle")
      break
    }
    seen.add(parent)
    result.chain.push(parent)
  }
  result.items.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
  return result
}
