import { CliError } from "@wirecat/cli-base"
import { capability, type MessengerAdapter, type ServerReads } from "../cli/messenger/port.js"
import type { Chat, ChatKind, Id, Inbox, InboxChat, Message, Review, ReviewChat } from "../domain/models.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { CHAT_KINDS } from "./chats.js"
import { type ServiceDeps, storeIfOpen } from "./deps.js"
import { readChatId } from "./messages.js"
import { unanswered } from "./questions.js"
import { applyTaskRules, type RuleResult } from "./task-rules.js"

/**
 * **At most this many history reads per `inbox`**, as in max-cli: a person opening twenty chats in
 * one burst is already more than a person does, and the rest are named in `skipped`, not lost.
 */
export { questions, unanswered } from "./questions.js"

export const INBOX_CHATS = 20

/** Owner's ruling in max-cli: without a boundary, a review looks at the last three days. */
export const REVIEW_DAYS = 3
export const UNANSWERED_HOURS = 24
export const reviewStart = (now = Date.now()): number => now - REVIEW_DAYS * 86_400_000

export const byRecency = (chats: Chat[]): Chat[] =>
  chats.toSorted((a, b) => Date.parse(b.lastMessageAt ?? "") - Date.parse(a.lastMessageAt ?? ""))

/** Muted or archived, and nothing in it mentions the owner or replies to them. */
const isQuiet = (chat: Chat): boolean =>
  (chat.muted === true || chat.archived === true) && (chat.unreadMentions ?? 0) === 0

export const heard = (chats: Chat[], all: boolean) =>
  all
    ? { heard: chats, quiet: 0 }
    : { heard: chats.filter((chat) => !isQuiet(chat)), quiet: chats.filter(isQuiet).length }

/**
 * **Every chat, in one call without a limit.** Telegram sorts by the last message, so an unread or
 * changed chat can sit anywhere below the newest hundred, and it has no server-side unread filter: a
 * folder is filtered on the client over the same pages. tg already walks every dialog to resolve a
 * typed title; MAX answers from the chats its login sent. `hasMore` is the messenger saying it could
 * not list them all.
 */
const everyChat = (adapter: InboxReader) => adapter.chats({ offset: 0 })

/** What `inbox` and `review` read: the messenger's own answers, or the local store's in store mode. */
export type InboxReader = Pick<ServerReads, "chats" | "history"> & Pick<MessengerAdapter, "resolve" | "admins">

/**
 * The stored chats and messages, read as the messenger would answer. Saving a message does not move
 * its chat's last message time, so the newest stored message does — a chat that only `watch` heard
 * from would otherwise never count as changed. The store knows no admins: questions count as
 * answered by the owner alone.
 */
export const storeReader = (deps: ServiceDeps, store: MessageStore, account: AccountKey): InboxReader => ({
  chats: async ({ limit, offset }) => {
    const newest = new Map((await store.chatStats(account)).map((one) => [one.chatId, one.newestAt]))
    const all = byRecency(
      (await store.chats(account, {})).items.map((chat) => {
        const at = newest.get(chat.id) ?? null
        const later = at !== null && (chat.lastMessageAt === null || Date.parse(at) > Date.parse(chat.lastMessageAt))
        return later ? { ...chat, lastMessageAt: at } : chat
      }),
    )
    const end = limit === undefined ? all.length : offset + limit
    return { items: all.slice(offset, end), hasMore: all.length > end }
  },
  history: (chat, window) => store.messages(account, chat, window),
  resolve: async (reference) => {
    const id = await readChatId(deps, reference, store, account)
    const found = (await store.chats(account, {})).items.find((one) => one.id === id)
    if (!found) throw new CliError("not_found", `no stored chat ${id}`)
    return found
  },
})

/** `dialog,group` as typed; refuses a word that is not a kind, before anything is asked. */
export const kindsOf = (typed: string, flag = "--kind"): ChatKind[] => {
  const kinds = typed
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one.length > 0)
  const wrong = kinds.find((one) => !CHAT_KINDS.includes(one as ChatKind))
  if (wrong !== undefined || kinds.length === 0) {
    throw new CliError("validation_error", `${flag} takes ${CHAT_KINDS.join(", ")}, comma-separated — not "${typed}"`)
  }
  return kinds as ChatKind[]
}

const ofKinds = (chats: Chat[], kinds: readonly ChatKind[] | undefined): Chat[] =>
  kinds === undefined ? chats : chats.filter((chat) => kinds.includes(chat.kind))

export const capped = (chats: Chat[], most: number) => ({
  read: chats.slice(0, most),
  skipped: chats.slice(most).map(({ id, title, lastMessageAt }) => ({ id, title, lastMessageAt })),
})

/**
 * Other people's unread messages, as the messenger counts them: for each chat with a count, its
 * newest that many. Reading marks nothing read, so the same messages come back until they are read
 * somewhere else — right for a person, wrong for a scheduled run, which is what `since` is for.
 *
 * Muted and archived chats are left out unless `all`, or they mention the owner: on a busy account
 * they are most of what is unread, and they would take the history reads a person's chat needs.
 */
export const unreadIn = async (
  adapter: InboxReader,
  { limit, all = false, kinds }: { limit: number; all?: boolean; kinds?: readonly ChatKind[] },
): Promise<Inbox> => {
  const page = await everyChat(adapter)
  const { heard: waiting, quiet } = heard(
    byRecency(ofKinds(page.items, kinds).filter((chat) => (chat.unreadCount ?? 0) > 0)),
    all,
  )
  const { read, skipped } = capped(waiting, INBOX_CHATS)

  const chats: InboxChat[] = []
  for (const { id, title, kind, unreadCount } of read) {
    const count = unreadCount ?? 0
    const wanted = Math.min(count, limit)
    const { items } = await adapter.history(id, { limit: wanted })
    const theirs = items.slice(-wanted).filter((message) => !message.outgoing)
    if (theirs.length > 0) chats.push({ id, title, kind, unreadCount, messages: theirs, more: count > limit })
  }
  return { mode: "unread", chats, skipped, partial: page.hasMore, quiet }
}

/**
 * Other people's messages in every chat that changed after its own point — `points` — or after
 * `since` for a chat with none.
 *
 * **A point per chat** is what lets a channels-only run leave the groups where they were, and a
 * chat past the per-run cap keep its point instead of falling behind one that moved past it.
 *
 * **Everything is cut at the chat list's newest message**, the snapshot taken first. The reads run
 * one after another, so a chat read early can gain a message while a later one is read; anything
 * newer than the snapshot waits for the next run and shows once there. Each chat read is `checked`
 * up to that cut.
 */
export const newIn = async (
  adapter: InboxReader,
  {
    since,
    points,
    limit,
    all = false,
    kinds,
  }: { since: number; points?: ReadonlyMap<Id, number>; limit: number; all?: boolean; kinds?: readonly ChatKind[] },
): Promise<Inbox> => {
  const page = await everyChat(adapter)
  const startOf = (chat: Id) => points?.get(chat) ?? since
  const changedAll = page.items.filter(
    (chat) => chat.lastMessageAt !== null && Date.parse(chat.lastMessageAt) > startOf(chat.id),
  )
  const changed = byRecency(ofKinds(changedAll, kinds))
  const cut = changed.reduce((latest, chat) => Math.max(latest, Date.parse(chat.lastMessageAt ?? "")), since)
  const { heard: wanted, quiet } = heard(changed, all)
  const { read, skipped } = capped(wanted, INBOX_CHATS)

  const chats: InboxChat[] = []
  const checked: Record<Id, string> = {}
  for (const { id, title, kind, unreadCount } of read) {
    const { items } = await adapter.history(id, { limit })
    const fresh = items.filter((message) => {
      const time = Date.parse(message.timestamp)
      return time > startOf(id) && time <= cut
    })
    checked[id] = new Date(cut).toISOString()
    const theirs = fresh.filter((message) => !message.outgoing)
    if (theirs.length > 0) chats.push({ id, title, kind, unreadCount, messages: theirs, more: fresh.length >= limit })
  }

  return {
    mode: "new",
    // The earliest start among the chats that changed; with none, how far the checks already reach.
    since: new Date(
      changed.length > 0
        ? changed.reduce((earliest, chat) => Math.min(earliest, startOf(chat.id)), Number.POSITIVE_INFINITY)
        : ofKinds(page.items, kinds).reduce((latest, chat) => Math.max(latest, startOf(chat.id)), since),
    ).toISOString(),
    until: new Date(cut).toISOString(),
    chats,
    skipped,
    partial: page.hasMore,
    quiet,
    checked,
  }
}

/** Every page is a history request; 20 chats of 3 pages stays well inside what one account may ask. */
export const REVIEW_CHATS = 20
const REVIEW_PAGE = 100
const REVIEW_PER_CHAT = 300

export interface ReviewOptions {
  since: number
  /** A chat's own start, where it has one; `since` for the rest. */
  points?: ReadonlyMap<Id, number>
  /** A chat as typed; only that one is read, muted or not. */
  chat?: string
  /** Only chats of these kinds; ignored with `chat`. */
  kinds?: readonly ChatKind[]
  all?: boolean
  /** Keep only questions nobody answered in this many hours. */
  unansweredAfterHours?: number
  now?: number
  /** Apply retained or newly heard transcripts before unanswered filtering. */
  enrich?: (review: Review) => Promise<Review>
  /** Sees every message read, transcripts applied, before `--unanswered` narrows them. */
  onReviewed?: (review: Review) => Promise<void>
}

/**
 * The chat's messages after `since` and up to `cut`, oldest first. The history pages backwards —
 * Telegram's cannot start from a time — so a chat cut short keeps its newest, and the review is
 * incomplete rather than silently missing the start.
 */
const window = async (adapter: InboxReader, chat: Id, since: number, cut: number) => {
  const messages: Message[] = []
  let before: string | undefined
  while (true) {
    const page = await adapter.history(chat, { limit: REVIEW_PAGE, ...(before === undefined ? {} : { before }) })
    const time = (message: Message) => Date.parse(message.timestamp)
    messages.unshift(...page.items.filter((message) => time(message) > since && time(message) <= cut))
    const oldest = page.items[0]
    if (!page.hasMore || !oldest || time(oldest) <= since) return { messages, more: false }
    if (messages.length >= REVIEW_PER_CHAT) return { messages: messages.slice(-REVIEW_PER_CHAT), more: true }
    before = oldest.id
  }
}

/**
 * **Every message, both sides, in each chat that changed after `since`** — what a review of who
 * owes what reads, where `inbox` reads only other people's newest few. Cut at the chat list's newest
 * message, as `inbox --new` is, so the next review starting at `until` misses nothing.
 */
export const reviewIn = async (
  adapter: InboxReader,
  {
    since,
    points,
    chat,
    kinds,
    all = false,
    unansweredAfterHours,
    now = Date.now(),
    enrich,
    onReviewed,
  }: ReviewOptions,
): Promise<Review> => {
  const page = await everyChat(adapter)
  const startOf = (id: Id) => points?.get(id) ?? since
  const changed = byRecency(
    page.items.filter((one) => one.lastMessageAt !== null && Date.parse(one.lastMessageAt) > startOf(one.id)),
  )
  const cut = changed.reduce((latest, one) => Math.max(latest, Date.parse(one.lastMessageAt ?? "")), since)
  const only = chat === undefined ? undefined : (await adapter.resolve(chat)).id
  const { heard: wanted, quiet } =
    only === undefined
      ? heard(ofKinds(changed, kinds), all)
      : { heard: changed.filter((one) => one.id === only), quiet: 0 }
  const { read, skipped } = capped(wanted, REVIEW_CHATS)

  const chats: ReviewChat[] = []
  // A chat cut short keeps its point: what was left out shows next time instead of never.
  const checked: Record<Id, string> = {}
  for (const { id, title, kind } of read) {
    const { messages, more } = await window(adapter, id, startOf(id), cut)
    if (messages.length > 0) chats.push({ id, title, kind, messages, more })
    if (!more) checked[id] = new Date(cut).toISOString()
  }
  const partial = page.hasMore
  const earliest =
    changed.length > 0 ? changed.reduce((low, one) => Math.min(low, startOf(one.id)), Number.POSITIVE_INFINITY) : since
  const found: Review = {
    since: new Date(points === undefined ? since : earliest).toISOString(),
    until: new Date(cut).toISOString(),
    complete: skipped.length === 0 && !partial && chats.every((one) => !one.more),
    chats,
    skipped,
    partial,
    quiet,
    ...(points === undefined ? {} : { checked }),
  }
  const answerers = new Map<Id, Id[] | undefined>()
  if (unansweredAfterHours !== undefined) {
    for (const one of chats) {
      answerers.set(one.id, one.kind === "dialog" ? [] : ((await adapter.admins?.(one.id)) ?? undefined))
    }
  }
  const reviewed = enrich ? await enrich(found) : found
  await onReviewed?.(reviewed)
  if (unansweredAfterHours === undefined) return reviewed

  const open: ReviewChat[] = []
  for (const one of reviewed.chats) {
    const admins = answerers.get(one.id)
    const questions = unanswered(one.messages, {
      answerers: new Set(admins ?? []),
      before: now - unansweredAfterHours * 3_600_000,
    })
    if (questions.length > 0) {
      open.push({ ...one, messages: questions, answeredBy: admins === undefined ? "owner" : "owner-and-admins" })
    }
  }
  return { ...reviewed, chats: open, unanswered: { olderThanHours: unansweredAfterHours } }
}

export interface InboxService {
  /**
   * Other people's unread messages; with `since` (ms, parsed by the caller), what arrived after it
   * instead — after a chat's own point where `points` has one.
   */
  read(options: {
    since?: number
    points?: ReadonlyMap<Id, number>
    limit: number
    all?: boolean
    kinds?: readonly ChatKind[]
  }): Promise<Inbox>
  /** Every message, both sides, in each chat that changed since a point. */
  review(options: ReviewOptions): Promise<Review>
}

export const inboxService = (deps: ServiceDeps): InboxService => {
  const reader = async (): Promise<InboxReader> => {
    if (deps.reads === "store") return storeReader(deps, await deps.store(), await deps.account())
    const connection = await deps.connection()
    return {
      chats: capability(connection, "chats", "list chats"),
      history: capability(connection, "history", "read a chat's history"),
      resolve: (reference) => connection.resolve(reference),
      ...(connection.admins ? { admins: capability(connection, "admins", "list a chat's admins") } : {}),
    }
  }

  return {
    read: async ({ since, points, limit, all = false, kinds }) => {
      if (deps.offline && deps.reads !== "store") {
        throw new CliError(
          "validation_error",
          "`inbox` asks the messenger what is new; with `--offline` there is nothing new",
        )
      }
      const from = await reader()
      const only = kinds === undefined ? {} : { kinds }
      return since === undefined
        ? unreadIn(from, { limit, all, ...only })
        : newIn(from, { since, limit, all, ...only, ...(points === undefined ? {} : { points }) })
    },

    review: async (options) => {
      if (deps.offline && deps.reads !== "store") {
        throw new CliError("validation_error", "`review` asks the messenger what changed; with `--offline` nothing did")
      }
      let tasks: RuleResult | undefined
      const found = await reviewIn(await reader(), {
        ...options,
        onReviewed: async (full) => {
          const held = await storeIfOpen(deps)
          if (held) tasks = await applyTaskRules(full, { store: held.store.tasks, account: held.account })
        },
      })
      return tasks ? { ...found, tasks } : found
    },
  }
}
