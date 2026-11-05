import { CliError } from "@wirecat/cli-base"
import { mailOwnText } from "../conversations/mail-text.js"
import { isBusy } from "../store/sqlite/transaction.js"
import type { AccountKey, MarkedEmail, MessageStore, StoredHit } from "../store/store.js"
import { BULK_TRIAGE_DEFAULTS, type BulkSorted, type BulkTriage, newsletterSorter } from "./newsletter.js"

/** A holder's name: what `--holder` takes and the mark's key ends with. */
export const HOLDER = /^[a-z0-9][a-z0-9-]{0,39}$/
/** At most this many emails are read past the mark in one go; the rest come with the next read. */
export const MARK_BATCH = 200
/** A partial email waits this long to be stored whole, then is skipped. */
export const HOLD_PARTIAL_MS = 7 * 86_400_000
/** Held, or suspicious, emails kept on one mark at most; past it the oldest are dropped. */
const MOST_HELD = 500
/** A cursor read at most this far in the future is a clock apart, not a forgery. */
const CLOCK_SLACK_MS = 60_000
const PREFIX = "consumer:"

export type SkipReason = "bulk" | "newsletter" | "envelope" | "partial" | "draft" | "suspicious"

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
  /** Emails skipped while their sender looked suspicious; offered again once the sender's score is cleared. */
  suspicious: number[]
  read: number
  skipped: Record<SkipReason, number>
  /** How often the owner moved the mark back: a findings key names it, so a run after a reset never reuses one. */
  resets: number
  /** ms. */
  updatedAt: number
}

const noneSkipped = (): Record<SkipReason, number> => ({
  bulk: 0,
  newsletter: 0,
  envelope: 0,
  partial: 0,
  draft: 0,
  suspicious: 0,
})

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
      suspicious: Array.isArray(saved.suspicious) ? saved.suspicious.filter((id) => typeof id === "number") : [],
      read: saved.read ?? 0,
      skipped: { ...noneSkipped(), ...saved.skipped },
      resets: typeof saved.resets === "number" ? saved.resets : 0,
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
  if (email.demoted) return "suspicious"
  if (email.partial) return now - email.storedAt < HOLD_PARTIAL_MS ? "held" : "partial"
  return "read"
}

/** The mark's state, as a cursor `acknowledge` takes back: the last id read, and when it was read. */
export const cursorOf = (throughId: number, readAt: number) => `${throughId}.${readAt}`

/**
 * The findings key of one run: `<holder>:<through_id>`, and `-r<resets>` once the owner moved the mark back, so the
 * runs after a reset never reach a key a batch staged before it holds. The same review gives the same key: a retry
 * of one run stages nothing twice.
 */
export const findingsKeyOf = (holder: string, throughId: number, resets: number) =>
  `${holder}:${throughId}${resets > 0 ? `-r${resets}` : ""}`

const parseCursor = (cursor: string) => {
  const match = /^(\d+)\.(\d+)$/.exec(cursor.trim())
  if (!match)
    throw new CliError("validation_error", `--cursor takes the cursor review gave, such as 9123.1762090000000`)
  return { throughId: Number(match[1]), readAt: Number(match[2]) }
}

/** A bulk email that is not surely a newsletter: the holder gets its subject and first lines only. */
export interface BulkExcerpt {
  email: StoredHit
  /** The first lines of its own text, without the subject. */
  excerpt: string
  /** What kept it, or the newsletter signs too few to leave it out. */
  cues: string[]
}

export interface MarkRead {
  /** The emails for the holder, oldest first; bulk, envelopes, drafts, suspicious senders and partial mail left out. */
  emails: StoredHit[]
  /** Bulk mail past the mark that is not surely a newsletter, oldest first; none when the triage gives no excerpts. */
  excerpts: BulkExcerpt[]
  /** What `acknowledge --cursor` takes once the holder is done with these. */
  cursor: string
  /** The key a findings batch over these emails takes; `undefined` while nothing is stored to read. */
  findingsKey: string | undefined
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
  options: { now?: number; limit?: number; triage?: BulkTriage } = {},
): Promise<MarkRead> => {
  const { wanted, sorted, oldestStoredAt: _, ...read } = await examine(store, mailbox, holder, options)
  const excerpts = wanted.flatMap((id) => {
    const one = sorted.get(id)
    return one ? [{ email: one.email, excerpt: one.excerpt, cues: one.cues }] : []
  })
  const emails = await store.mail.emailHits(wanted.filter((id) => !sorted.has(id)))
  return { emails, excerpts, ...read }
}

type Sorted = Map<number, BulkSorted & { email: StoredHit }>

/**
 * The batch's bulk emails a holder might read, sorted by `newsletterSorter`, and where the batch ends so it holds at
 * most `perRead` excerpts. Drafts, envelopes, suspicious senders and partial mail keep their own verdicts.
 */
const sortBulk = async (
  store: MessageStore,
  batch: MarkedEmail[],
  triage: BulkTriage,
): Promise<{ sorted: Sorted; end: number }> => {
  const sorted: Sorted = new Map()
  if (!triage.excerpts) return { sorted, end: batch.length }
  const sort = newsletterSorter(triage.cues)
  let excerpts = 0
  for (const [index, marked] of batch.entries()) {
    if (!marked.bulk || marked.draft || marked.envelope || marked.demoted || marked.partial) continue
    const [email] = await store.mail.emailHits([marked.id])
    if (!email) continue
    const subject = email.email?.subject ?? null
    const body = subject && email.text.startsWith(`${subject}\n\n`) ? email.text.slice(subject.length + 2) : email.text
    const one = sort({ subject, text: mailOwnText(body), from: email.email?.from?.address ?? null })
    if (one.verdict === "excerpt" && excerpts === triage.perRead) return { sorted, end: index }
    if (one.verdict === "excerpt") excerpts += 1
    sorted.set(marked.id, { ...one, email })
  }
  return { sorted, end: batch.length }
}

/** `readPastMark` before it reads the emails: the store ids it would read by their verdicts, and the bulk sorted. */
const examine = async (
  store: MessageStore,
  mailbox: AccountKey,
  holder: string,
  {
    now = Date.now(),
    limit = MARK_BATCH,
    after,
    triage = BULK_TRIAGE_DEFAULTS,
  }: { now?: number; limit?: number; after?: number; triage?: BulkTriage },
): Promise<
  Omit<MarkRead, "emails" | "excerpts"> & { wanted: number[]; sorted: Sorted; oldestStoredAt: number | null }
> => {
  const saved = await markOf(store, mailbox, holder)
  const account = await accountOf(store, mailbox)
  const empty = {
    wanted: [],
    sorted: new Map(),
    oldestStoredAt: null,
    more: false,
    held: 0,
    skipped: noneSkipped(),
    mark: saved,
  }
  const keyed = (throughId: number) => ({
    cursor: cursorOf(throughId, now),
    findingsKey: throughId > 0 ? findingsKeyOf(holder, throughId, saved?.resets ?? 0) : undefined,
  })
  if (!account) return { ...empty, ...keyed(0) }
  if (!saved) return { ...empty, ...keyed(await store.mail.newestEmailId(account.id)) }
  const mark = after === undefined ? saved : { ...saved, throughId: after, held: [], suspicious: [] }
  const found = await store.mail.emailsAfter(account.id, mark.throughId, limit + 1, [...mark.held, ...mark.suspicious])
  // Mail a running sync stored is read once that sync ended: it files bulk mail only at its end.
  const settled = await store.sync.syncState(mailbox, "mail_coverage")
  const settledAt = settled ? Date.parse(settled.at) : Number.POSITIVE_INFINITY
  const newer = found.filter((email) => email.id > mark.throughId)
  const unsettled = newer.findIndex((email) => email.storedAt > settledAt)
  const fresh = unsettled === -1 ? newer : newer.slice(0, unsettled)
  const { sorted, end } = await sortBulk(store, fresh.slice(0, limit), triage)
  const batch = fresh.slice(0, end)
  const examined = [...found.filter((email) => email.id <= mark.throughId), ...batch]
  const skipped = noneSkipped()
  const wanted: number[] = []
  let oldestStoredAt: number | null = null
  let held = 0
  for (const email of examined) {
    const said = verdict(email, now)
    const bulk = sorted.get(email.id)
    if (bulk?.verdict === "newsletter") {
      if (email.id > mark.throughId) skipped.newsletter += 1
    } else if (said === "read" || bulk) {
      wanted.push(email.id)
      oldestStoredAt = Math.min(oldestStoredAt ?? email.storedAt, email.storedAt)
    } else if (said === "held") held += 1
    else if (email.id > mark.throughId) skipped[said] += 1
  }
  return {
    wanted: wanted.sort((a, b) => a - b),
    sorted: new Map([...sorted].filter(([, one]) => one.verdict === "excerpt")),
    oldestStoredAt,
    ...keyed(batch.at(-1)?.id ?? mark.throughId),
    more: newer.length > batch.length,
    held,
    skipped,
    mark: saved,
  }
}

/** Mail past a holder's marks that would reach it: how many emails, and when the oldest of them was stored. */
export interface MailWaiting {
  /** No mark yet in some mailbox: the holder's first run sets it. */
  unmarked: boolean
  emails: number
  /** ms. */
  oldestStoredAt: number | null
}

/**
 * What waits for the holder in every stored mailbox, read only: what a schedule asks before it starts the holder's
 * agent, so a run with nothing new costs no model call. Newsletters, envelopes, drafts, suspicious senders and partial
 * mail do not count; other bulk mail counts as the excerpt the holder gets, unless the triage gives none.
 */
export const mailWaiting = async (
  store: MessageStore,
  holder: string,
  now = Date.now(),
  triage: BulkTriage = BULK_TRIAGE_DEFAULTS,
): Promise<MailWaiting> => {
  const waiting: MailWaiting = { unmarked: false, emails: 0, oldestStoredAt: null }
  for (const mailbox of await store.accounts.accounts()) {
    if (mailbox.provider !== "email") continue
    let after: number | undefined
    for (;;) {
      const read = await examine(store, mailbox, holder, { now, triage, ...(after === undefined ? {} : { after }) })
      if (!read.mark) {
        waiting.unmarked = true
        break
      }
      waiting.emails += read.wanted.length
      if (read.oldestStoredAt !== null)
        waiting.oldestStoredAt = Math.min(waiting.oldestStoredAt ?? read.oldestStoredAt, read.oldestStoredAt)
      const through = Number(read.cursor.split(".")[0])
      if (!read.more || through === (after ?? read.mark.throughId)) break
      after = through
    }
  }
  return waiting
}

/**
 * Moves the holder's mark, in every stored mailbox, over the mail at its head that it would only skip — newsletters,
 * bulk mail the triage gives no excerpt of, envelopes, drafts, suspicious senders — as the agent would have acknowledged it, so a quiet holder's next check
 * does not read it all again. Suspicious senders' emails stay on the mark to be offered again. It stops at the first
 * email the holder reads. A store busy with a sync is left alone: the next check moves it.
 */
export const advancePastSkipped = async (
  store: MessageStore,
  holder: string,
  now = Date.now(),
  triage: BulkTriage = BULK_TRIAGE_DEFAULTS,
): Promise<void> => {
  for (const mailbox of await store.accounts.accounts()) {
    if (mailbox.provider !== "email") continue
    for (;;) {
      const read = await examine(store, mailbox, holder, { now, triage })
      if (!read.mark || read.wanted.length > 0 || read.cursor === cursorOf(read.mark.throughId, now)) break
      try {
        await acknowledgeMark(store, mailbox, holder, read.cursor, now)
      } catch (error) {
        if (isBusy(error)) return
        throw error
      }
      if (!read.more) break
    }
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
  const newest = await store.mail.newestEmailId(account.id)
  if (throughId > newest || readAt > now + CLOCK_SLACK_MS)
    throw new CliError(
      "validation_error",
      `--cursor ${cursor} is past the newest stored email; acknowledge a cursor review gave`,
      {
        reason: "mail.cursor-ahead",
      },
    )
  const mark = await markOf(store, mailbox, holder)
  const from = mark?.throughId ?? throughId
  if (throughId < from)
    throw new CliError("validation_error", `${holder} is already past ${throughId}: its mark is at ${from}`)
  const examined: MarkedEmail[] = []
  let after = from
  const held = new Set(mark?.held ?? [])
  const doubted = new Set(mark?.suspicious ?? [])
  const again = await store.mail.emailsAfter(account.id, Number.MAX_SAFE_INTEGER, 0, [...held, ...doubted])
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
  const suspicious: number[] = []
  const live = new Set(again.map((one) => one.id))
  for (const id of held) if (!live.has(id)) held.delete(id)
  for (const email of examined) {
    const said = verdict(email, readAt)
    const wasHeld = held.has(email.id)
    const wasDoubted = doubted.has(email.id) && !wasHeld
    if (said === "held" || (said === "read" && email.changedAt > readAt) || (wasHeld && email.changedAt > readAt)) {
      if (email.partial && now - email.storedAt >= HOLD_PARTIAL_MS) skipped.partial += 1
      else keep.push(email.id)
    } else if (said === "read") read += wasHeld || wasDoubted || email.id > from ? 1 : 0
    else if (said === "suspicious") {
      suspicious.push(email.id)
      if (!wasDoubted && !wasHeld) skipped.suspicious += 1
    } else if (!wasDoubted && (!wasHeld || said === "partial")) skipped[said] += 1
  }
  const kept = [...new Set(keep)].sort((a, b) => a - b)
  skipped.partial += Math.max(0, kept.length - MOST_HELD)
  const through = examined.filter((one) => one.id <= throughId).at(-1)
  const next = {
    throughId,
    throughAt: through?.id === throughId ? through.at : (mark?.throughAt ?? null),
    held: kept.slice(-MOST_HELD),
    suspicious: [...new Set(suspicious)].sort((a, b) => a - b).slice(-MOST_HELD),
    read,
    skipped,
    resets: mark?.resets ?? 0,
  }
  await store.sync.setSyncState(mailbox, key, JSON.stringify(next))
  return { holder, ...next, updatedAt: now }
}

/** Where the owner moves a holder's mark back to: the emails received since a time, or the last n it was given. */
export type MarkRewind = { since: number } | { last: number }

export interface RewoundMark {
  mark: MailMark
  /** Where the mark was before. */
  fromId: number
  /** The emails between the new mark and the old one the holder reads whole again. */
  again: number
  /** Bulk emails between them: excerpts again, unless they are surely newsletters. */
  bulk: number
  /** Emails between them the holder skips again: drafts, envelopes, suspicious senders, partial mail. */
  skipped: number
  /** The mark is moved only when not dry. */
  dry: boolean
}

/**
 * Moves the holder's mark back, so its next reviews give it that mail again: past every email received since
 * `since`, or past the last `last` emails it was given. The owner's alone: a holder only ever moves its own mark
 * forward. The id is the store's insert order, so an older email stored after the earliest one picked is read again too;
 * the answer counts them all.
 */
export const rewindMark = async (
  store: MessageStore,
  mailbox: AccountKey,
  holder: string,
  to: MarkRewind,
  { now = Date.now(), dry = false }: { now?: number; dry?: boolean } = {},
): Promise<RewoundMark> => {
  const key = keyOf(holder)
  const account = await accountOf(store, mailbox)
  if (!account) throw new CliError("not_found", `no mail of ${mailbox.account} is stored`)
  const mark = await markOf(store, mailbox, holder)
  if (!mark)
    throw new CliError("not_found", `${holder} has no mark in ${mailbox.account}: its first review starts it`, {
      reason: "mail.no-mark",
    })
  if ("last" in to && (!Number.isSafeInteger(to.last) || to.last < 1))
    throw new CliError("validation_error", "--last takes a whole number of emails, 1 or more")
  if ("since" in to && !Number.isFinite(to.since)) throw new CliError("validation_error", "--since-time takes a time")
  const given = (email: MarkedEmail) => {
    const said = verdict(email, now)
    return said === "read" || said === "held" || said === "bulk"
  }
  const between: MarkedEmail[] = []
  let through = mark.throughId
  let before = mark.throughId + 1
  for (let counted = 0; ; ) {
    const page = await store.mail.emailsBefore(account.id, before, MARK_BATCH)
    if (page.length === 0) {
      if ("last" in to && between.length > 0) through = 0
      break
    }
    let done = false
    for (const email of page) {
      if ("last" in to) {
        between.push(email)
        if (given(email)) counted += 1
        if (counted === to.last) {
          through = email.id - 1
          done = true
          break
        }
      } else {
        // An email is stored after it arrives, so once stored before the time, none further back arrived after it.
        if (email.storedAt < to.since - CLOCK_SLACK_MS) {
          done = true
          break
        }
        between.push(email)
        if ((email.at ?? email.storedAt) >= to.since) through = email.id - 1
      }
    }
    if (done) break
    before = page.at(-1)?.id ?? 0
  }
  const moved = between.filter((email) => email.id > through)
  const count = (pick: (said: ReturnType<typeof verdict>) => boolean) =>
    moved.filter((email) => pick(verdict(email, now))).length
  const answer = {
    fromId: mark.throughId,
    again: count((said) => said === "read" || said === "held"),
    bulk: count((said) => said === "bulk"),
    skipped: count((said) => said !== "read" && said !== "held" && said !== "bulk"),
    dry,
  }
  // A reset that lands where the mark already is still counts: the owner asked for a fresh findings key.
  const stays = through >= mark.throughId
  const [last] = !stays && through > 0 ? await store.mail.emailsBefore(account.id, through + 1, 1) : []
  const next = {
    throughId: stays ? mark.throughId : through,
    throughAt: stays ? mark.throughAt : last?.id === through ? last.at : null,
    held: mark.held.filter((id) => id <= through),
    suspicious: mark.suspicious.filter((id) => id <= through),
    read: mark.read,
    skipped: mark.skipped,
    resets: mark.resets + 1,
  }
  if (!dry) await store.sync.setSyncState(mailbox, key, JSON.stringify(next))
  return { mark: { holder, ...next, updatedAt: dry ? mark.updatedAt : now }, ...answer }
}
