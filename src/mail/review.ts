import { CliError } from "@wirecat/cli-base"
import { type Review, type ReviewChat, senderIsMe } from "../domain/models.js"
import type { AccountKey, MessageStore, StoredAccount, StoredHit, ThreadActivity } from "../store/store.js"
import { isPersonal, mailTurn } from "./owed.js"

/** Every thread is a local read; this many keep one answer readable, and the rest wait in `skipped`. */
export const REVIEW_THREADS = 50
const REVIEW_PER_THREAD = 50
/** Without a date, `--unanswered` and `--waiting` look as far back as `tasks agenda` does. */
export const OWED_DAYS = 30
// A thread is picked by its own time, which is the Date header where sync stored one; mail delivered up to a day
// after its date is still found.
const DATED_SLACK = 86_400_000
const HOUR = 3_600_000

export interface MailReviewOptions {
  /** ms: where a thread with no point of its own starts. */
  since: number
  /** A thread's own start, by its external id. */
  points?: ReadonlyMap<string, number>
  /** Mail sent to many, lists, envelopes and suspect senders too. */
  all?: boolean
  /** Only threads the owner owes an answer for at least this many hours (`mailTurn`). */
  unansweredAfterHours?: number
  /** Only threads where the owner wrote last and nobody answered for at least this many hours. */
  waitingAfterHours?: number
  now?: number
}

/** A review of mail: each thread a chat, each email a stored hit with its locator. */
export interface MailReview extends Review {
  chats: (ReviewChat & { messages: StoredHit[] })[]
}

const absent = (error: unknown): undefined => {
  if (error instanceof CliError && error.code === "not_found") return undefined
  throw error
}

/**
 * How far sync proved the mailbox: everything that arrived before `until` is stored. Review cuts there, so mail a
 * running sync has not stored yet cannot slip behind a saved point.
 */
const syncedThrough = async (store: MessageStore, mailbox: AccountKey) => {
  const saved = await store.sync.syncState(mailbox, "mail_coverage")
  if (!saved) return { until: undefined, complete: false }
  try {
    const { until, state } = JSON.parse(saved.value) as { until?: unknown; state?: unknown }
    const at = typeof until === "string" ? Date.parse(until) : Number.NaN
    return { until: Number.isNaN(at) ? undefined : at, complete: state === "window" && !Number.isNaN(at) }
  } catch {
    return { until: undefined, complete: false }
  }
}

const wanted = (
  thread: ThreadActivity,
  { all, unansweredAfterHours, waitingAfterHours }: MailReviewOptions,
  now: number,
): "read" | "quiet" | "no" => {
  const newest = thread.newest
  if (unansweredAfterHours !== undefined || waitingAfterHours !== undefined) {
    const turn = mailTurn(newest)
    const age = newest === null ? 0 : now - newest.at
    const owed = turn === "owed" && unansweredAfterHours !== undefined && age >= unansweredAfterHours * HOUR
    const waiting = turn === "waiting" && waitingAfterHours !== undefined && age >= waitingAfterHours * HOUR
    return owed || waiting ? "read" : "no"
  }
  if (all || newest === null || newest.outgoing || isPersonal(newest)) return "read"
  return "quiet"
}

/** The emails after the other side last wrote: what is owed, or what waits for an answer. */
const turnTail = (messages: StoredHit[], owner: string, ownerWrote: boolean) => {
  const start = messages.findLastIndex((one) => senderIsMe(one, owner) !== ownerWrote)
  return messages.slice(start + 1)
}

/**
 * **Every email, both sides, in each thread that changed since a point** — `review` over the store's mail, in
 * messenger review's shape: a thread is a chat, an email a message. Reads the store alone, so it costs the mail
 * server nothing; it opens no task (the owner reviews mail tasks first). Cut where sync proved the mailbox
 * (`syncedThrough`), so the next review starting at `until` misses nothing sync had stored by then.
 */
export const reviewMail = async (
  store: MessageStore,
  mailbox: AccountKey,
  options: MailReviewOptions,
): Promise<MailReview> => {
  const { since, points } = options
  const now = options.now ?? Date.now()
  const account: StoredAccount | undefined = await store.accounts.storedAccount(mailbox).catch(absent)
  const synced = account ? await syncedThrough(store, mailbox) : { until: undefined, complete: false }
  const cut = Math.min(now, synced.until ?? now)
  const startOf = (thread: string) => points?.get(thread) ?? since
  const activity = account ? await store.mail.threadActivity(account.id, since - DATED_SLACK) : []
  const changed = activity.filter(
    (thread) => Math.max(thread.lastEmailAt, thread.newest?.at ?? 0) > startOf(thread.threadId),
  )
  const picked = changed.map((thread) => ({ thread, as: wanted(thread, options, now) }))
  const shown = picked.filter(({ as }) => as === "read").map(({ thread }) => thread)
  const read = shown.slice(0, REVIEW_THREADS)
  const skipped = shown.slice(REVIEW_THREADS).map(({ threadId, subject, lastEmailAt }) => ({
    id: threadId,
    title: subject,
    lastMessageAt: new Date(lastEmailAt).toISOString(),
  }))
  const turns = options.unansweredAfterHours !== undefined || options.waitingAfterHours !== undefined

  const chats: MailReview["chats"] = []
  const checked: Record<string, string> = {}
  for (const thread of read) {
    const hits = await store.mail.threadHits(account?.id ?? 0, thread.threadId, {
      after: startOf(thread.threadId),
      until: cut,
    })
    const messages = turns ? turnTail(hits, mailbox.account, thread.newest?.outgoing === true) : hits
    const more = messages.length > REVIEW_PER_THREAD
    if (messages.length > 0)
      chats.push({
        id: thread.threadId,
        title: thread.subject,
        kind: "dialog",
        messages: more ? messages.slice(-REVIEW_PER_THREAD) : messages,
        more,
      })
    if (!more) checked[thread.threadId] = new Date(cut).toISOString()
  }
  const earliest = changed.reduce((low, thread) => Math.min(low, startOf(thread.threadId)), Number.POSITIVE_INFINITY)
  return {
    since: new Date(points === undefined || changed.length === 0 ? since : earliest).toISOString(),
    until: new Date(cut).toISOString(),
    complete: synced.complete && skipped.length === 0 && chats.every((one) => !one.more),
    chats,
    skipped,
    partial: false,
    quiet: picked.filter(({ as }) => as === "quiet").length,
    ...(options.unansweredAfterHours === undefined
      ? {}
      : { unanswered: { olderThanHours: options.unansweredAfterHours } }),
    ...(options.waitingAfterHours === undefined ? {} : { waiting: { olderThanHours: options.waitingAfterHours } }),
    ...(points === undefined ? {} : { checked }),
  }
}
