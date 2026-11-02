import { CliError } from "@wirecat/cli-base"
import type { AccountKey, MarkedEmail, MessageStore, StoredHit } from "../store/store.js"

/** A holder's name: what `--holder` takes and the mark's key ends with. */
export const HOLDER = /^[a-z0-9][a-z0-9-]{0,39}$/
/** At most this many emails are read past the mark in one go; the rest come with the next read. */
export const MARK_BATCH = 200
/** A partial email waits this long to be stored whole, then is skipped. */
export const HOLD_PARTIAL_MS = 7 * 86_400_000
/** Held emails kept on one mark at most; past it the oldest are skipped as partial. */
const MOST_HELD = 500
const PREFIX = "consumer:"

export type SkipReason = "bulk" | "envelope" | "partial" | "draft"

/**
 * How far one holder — an agent, a pipeline — has processed an account's mail, in the shared store (`sync_cursors`,
 * key `consumer:<holder>`). It counts by the store's insert order (`emails.id`), so mail stored late, older than what
 * was read, is still after the mark. Partial emails are held until they are whole.
 */
export interface MailMark {
  holder: string
  throughId: number
  /** ms: when the email at `throughId` was received; for display. */
  throughAt: number | null
  held: number[]
  read: number
  skipped: Record<SkipReason, number>
  /** ms. */
  updatedAt: number
}

const noneSkipped = (): Record<SkipReason, number> => ({ bulk: 0, envelope: 0, partial: 0, draft: 0 })

const keyOf = (holder: string) => {
  if (!HOLDER.test(holder))
    throw new CliError("validation_error", `a holder is lower-case letters, digits and dashes, not "${holder}"`)
  return `${PREFIX}${holder}`
}

const parsed = (holder: string, value: string, at: number): MailMark | undefined => {
  try {
    const saved = JSON.parse(value) as Partial<Omit<MailMark, "holder" | "updatedAt">>
    if (typeof saved.throughId !== "number") return undefined
    return {
      holder,
      throughId: saved.throughId,
      throughAt: saved.throughAt ?? null,
      held: Array.isArray(saved.held) ? saved.held.filter((id) => typeof id === "number") : [],
      read: saved.read ?? 0,
      skipped: { ...noneSkipped(), ...saved.skipped },
      updatedAt: at,
    }
  } catch {
    return undefined
  }
}

const accountOf = async (store: MessageStore, mailbox: AccountKey) =>
  store.accounts.storedAccount(mailbox).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "not_found") return undefined
    throw error
  })

export const markOf = async (store: MessageStore, mailbox: AccountKey, holder: string) => {
  const saved = await store.sync.syncState(mailbox, keyOf(holder))
  return saved ? parsed(holder, saved.value, Date.parse(saved.at)) : undefined
}

/** Every holder's mark on the mailbox, by name. */
export const marksOf = async (store: MessageStore, mailbox: AccountKey): Promise<MailMark[]> => {
  const account = await accountOf(store, mailbox)
  if (!account) return []
  return (await store.mail.statesLike(account.id, PREFIX))
    .flatMap(({ key, value, at }) => parsed(key.slice(PREFIX.length), value, at) ?? [])
    .sort((a, b) => a.holder.localeCompare(b.holder))
}

/** Why an email is not for the holder, or `held` while it is partial and young, or `read`. */
const verdict = (email: MarkedEmail, now: number): SkipReason | "held" | "read" => {
  if (email.draft) return "draft"
  if (email.envelope) return "envelope"
  if (email.bulk) return "bulk"
  if (email.partial) return now - email.storedAt < HOLD_PARTIAL_MS ? "held" : "partial"
  return "read"
}

/** The mark's state, as a cursor `acknowledge` takes back: the last id read, and when it was read. */
export const cursorOf = (throughId: number, readAt: number) => `${throughId}.${readAt}`

const parseCursor = (cursor: string) => {
  const match = /^(\d+)\.(\d+)$/.exec(cursor.trim())
  if (!match)
    throw new CliError("validation_error", `--cursor takes the cursor review gave, such as 9123.1762090000000`)
  return { throughId: Number(match[1]), readAt: Number(match[2]) }
}

export interface MarkRead {
  /** The emails for the holder, oldest first; bulk, envelopes, drafts and partial mail left out. */
  emails: StoredHit[]
  /** What `acknowledge --cursor` takes once the holder is done with these. */
  cursor: string
  /** More is stored after this batch: read again after acknowledging. */
  more: boolean
  held: number
  skipped: Record<SkipReason, number>
  /** `undefined` before the holder's first acknowledge: it starts from the mail stored now. */
  mark: MailMark | undefined
}

/**
 * What the holder has not processed: the emails stored after its mark, and the held ones that are whole now. Reads
 * only; the mark moves when the holder acknowledges. A holder with no mark starts from now: its first read is
 * empty and gives the cursor of the newest stored email.
 */
export const readPastMark = async (
  store: MessageStore,
  mailbox: AccountKey,
  holder: string,
  { now = Date.now(), limit = MARK_BATCH }: { now?: number; limit?: number } = {},
): Promise<MarkRead> => {
  const mark = await markOf(store, mailbox, holder)
  const account = await accountOf(store, mailbox)
  const empty = { emails: [], more: false, held: 0, skipped: noneSkipped(), mark }
  if (!account) return { ...empty, cursor: cursorOf(0, now) }
  if (!mark) return { ...empty, cursor: cursorOf(await store.mail.newestEmailId(account.id), now) }
  const found = await store.mail.emailsAfter(account.id, mark.throughId, limit + 1, mark.held)
  // Mail a running sync stored is read once that sync ended: it files bulk mail only at its end.
  const settled = await store.sync.syncState(mailbox, "mail_coverage")
  const settledAt = settled ? Date.parse(settled.at) : Number.POSITIVE_INFINITY
  const after = found.filter((email) => email.id > mark.throughId)
  const unsettled = after.findIndex((email) => email.storedAt > settledAt)
  const fresh = unsettled === -1 ? after : after.slice(0, unsettled)
  const batch = fresh.slice(0, limit)
  const examined = [...found.filter((email) => email.id <= mark.throughId), ...batch]
  const skipped = noneSkipped()
  const wanted: number[] = []
  let held = 0
  for (const email of examined) {
    const said = verdict(email, now)
    if (said === "read") wanted.push(email.id)
    else if (said === "held") held += 1
    else if (email.id > mark.throughId) skipped[said] += 1
  }
  const emails = await store.mail.emailHits(wanted.sort((a, b) => a - b))
  return {
    emails,
    cursor: cursorOf(batch.at(-1)?.id ?? mark.throughId, now),
    more: after.length > batch.length,
    held,
    skipped,
    mark,
  }
}

/**
 * Moves the holder's mark to the cursor its read gave, never back. An email whole when it was read counts read; one
 * still partial, or changed after the read (it may have become whole since), is held and comes with the next read.
 * The same cursor twice changes nothing more.
 */
export const acknowledgeMark = async (
  store: MessageStore,
  mailbox: AccountKey,
  holder: string,
  cursor: string,
  now = Date.now(),
): Promise<MailMark> => {
  const key = keyOf(holder)
  const { throughId, readAt } = parseCursor(cursor)
  const account = await accountOf(store, mailbox)
  if (!account) throw new CliError("not_found", `no mail of ${mailbox.account} is stored`)
  const mark = await markOf(store, mailbox, holder)
  const from = mark?.throughId ?? throughId
  if (throughId < from)
    throw new CliError("validation_error", `${holder} is already past ${throughId}: its mark is at ${from}`)
  const examined: MarkedEmail[] = []
  let after = from
  const held = new Set(mark?.held ?? [])
  const again = await store.mail.emailsAfter(account.id, Number.MAX_SAFE_INTEGER, 0, [...held])
  examined.push(...again)
  while (after < throughId) {
    const page = (await store.mail.emailsAfter(account.id, after, MARK_BATCH)).filter((one) => one.id <= throughId)
    if (page.length === 0) break
    examined.push(...page)
    after = page.at(-1)?.id ?? throughId
  }
  const skipped = { ...(mark?.skipped ?? noneSkipped()) }
  let read = mark?.read ?? 0
  const keep: number[] = []
  const live = new Set(again.map((one) => one.id))
  for (const id of held) if (!live.has(id)) held.delete(id)
  for (const email of examined) {
    const said = verdict(email, readAt)
    const wasHeld = held.has(email.id)
    if (said === "held" || (said === "read" && email.changedAt > readAt) || (wasHeld && email.changedAt > readAt)) {
      if (email.partial && now - email.storedAt >= HOLD_PARTIAL_MS) skipped.partial += 1
      else keep.push(email.id)
    } else if (said === "read") read += wasHeld || email.id > from ? 1 : 0
    else if (!wasHeld || said === "partial") skipped[said] += 1
  }
  const kept = [...new Set(keep)].sort((a, b) => a - b)
  skipped.partial += Math.max(0, kept.length - MOST_HELD)
  const through = examined.filter((one) => one.id <= throughId).at(-1)
  const next = {
    throughId,
    throughAt: through?.id === throughId ? through.at : (mark?.throughAt ?? null),
    held: kept.slice(-MOST_HELD),
    read,
    skipped,
  }
  await store.sync.setSyncState(mailbox, key, JSON.stringify(next))
  return { holder, ...next, updatedAt: now }
}
