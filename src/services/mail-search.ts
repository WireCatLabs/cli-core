import { CliError } from "@wirecat/cli-core"
import { parseLocator } from "../domain/locator.js"
import type { Chat, Message, Page } from "../domain/models.js"
import type { AccountKey, MessageStore, ScoredHit, StoredHit } from "../store/store.js"
import { messageOfEmail } from "../store/store.js"

const THREADS_PAGE = 500

const threadsOf = async (store: MessageStore, key: AccountKey): Promise<Chat[]> => {
  const account = await store.storedAccount(key).catch(() => undefined)
  if (!account) return []
  const chats: Chat[] = []
  for (let offset = 0; ; offset += THREADS_PAGE) {
    const threads = await store.mail.threads({ accountId: account.id, limit: THREADS_PAGE, offset })
    chats.push(
      ...threads.map((thread) => ({
        id: thread.externalId,
        title: thread.subject,
        kind: "group" as const,
        unreadCount: null,
        lastMessageAt: thread.lastEmailAt === null ? null : new Date(thread.lastEmailAt).toISOString(),
        participantsCount: null,
      })),
    )
    if (threads.length < THREADS_PAGE) return chats
  }
}

/**
 * The store, with each mail account's email threads among its chats, so `--chat` and `chat:` name a thread
 * by id or subject as they name a chat. A thread that is also an older import's chat is listed once.
 */
export const withMailThreads = (store: MessageStore): MessageStore =>
  new Proxy(store, {
    get(target, key, receiver) {
      if (key !== "chats") return Reflect.get(target, key, receiver)
      return async (account: AccountKey, window: Parameters<MessageStore["chats"]>[1]): Promise<Page<Chat>> => {
        const held = await target.chats(account, window)
        if (window.limit !== undefined || window.offset !== undefined) return held
        const known = new Set(held.items.map(({ id }) => id))
        const threads = (await threadsOf(target, account)).filter(({ id }) => !known.has(id))
        return { ...held, items: [...held.items, ...threads] }
      }
    },
  })

const before = (newest: boolean) => (a: ScoredHit, b: ScoredHit) => {
  if (!newest) {
    if ((a.exact ?? false) !== (b.exact ?? false)) return a.exact ? -1 : 1
    if (a.score !== b.score) return a.score === null ? 1 : b.score === null ? -1 : b.score - a.score
  }
  return b.timestamp.localeCompare(a.timestamp)
}

/**
 * One page from mail stored as messages and mail in its own tables, in the order one search gives. An email
 * imported again into the mail tables keeps its locator, so its older message copy is dropped.
 */
export const mergeMail = (
  messages: Page<ScoredHit>,
  mail: Page<ScoredHit>,
  limit: number,
  newest = false,
): Page<ScoredHit> => {
  const moved = new Set(mail.items.map(({ locator }) => locator))
  const items = [...messages.items.filter(({ locator }) => !moved.has(locator)), ...mail.items].sort(before(newest))
  return {
    items: items.slice(0, limit),
    hasMore: messages.hasMore || mail.hasMore || items.length > limit,
  }
}

/**
 * The emails around a hit from the mail tables, oldest first, the hit marked as `anchor`; `undefined` when the
 * hit is mail an older import stored as messages, whose context the store's `around` reads.
 */
export const mailAround = async (
  store: MessageStore,
  hit: { locator: string; chatId: string; id: string },
  count: number,
): Promise<(Message & { anchor?: true })[] | undefined> => {
  const { provider, account } = parseLocator(hit.locator)
  const stored = await store.storedAccount({ provider, account }).catch(() => undefined)
  if (!stored) return undefined
  const emails = (await store.mail.emails({ accountId: stored.id, threadExternalId: hit.chatId })).reverse()
  const at = emails.findIndex(({ externalId }) => externalId === hit.id)
  if (at < 0) return undefined
  return emails
    .slice(Math.max(0, at - count), at + count + 1)
    .map((email) =>
      email.externalId === hit.id
        ? { ...messageOfEmail(email, hit.chatId), anchor: true as const }
        : messageOfEmail(email, hit.chatId),
    )
}

/**
 * One email by its `msg:email/…` locator, with up to `before` and `after` emails of its thread either side, each
 * whole: what an excerpt in a search answer leads to. The asked one is marked `anchor`.
 */
export const readMail = async (
  store: MessageStore,
  locator: string,
  { before = 0, after = 0 }: { before?: number; after?: number } = {},
): Promise<(StoredHit & { anchor?: true })[]> => {
  const { provider, account, chat, message } = parseLocator(locator)
  if (provider !== "email") throw new CliError("validation_error", `${locator} is not an email — it names ${provider}`)
  const stored = await store.storedAccount({ provider, account }).catch(() => undefined)
  if (!stored) throw new CliError("not_found", `no mail of ${account} is stored`)
  const thread = await store.mail.threadHits(stored.id, chat)
  const at = thread.findIndex(({ id }) => id === message)
  if (at < 0) throw new CliError("not_found", `no stored email ${message} in that thread`)
  return thread
    .slice(Math.max(0, at - before), at + after + 1)
    .map((hit) => (hit.id === message ? { ...hit, anchor: true as const } : hit))
}
