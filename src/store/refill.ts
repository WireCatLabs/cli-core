import type { CacheDatabase } from "./driver.js"

/**
 * How far before the last deep check that passed the coverage is forgotten: a message is written when a sync or a
 * serve gets it, which can be hours after it was sent, and the cut is by send time.
 */
export const REFILL_MARGIN_MS = 86_400_000

/** Stretch keys at or above this are send times in milliseconds (September 2001 on); below it, message ids. */
const TIME_KEYS = 1e12

export interface Refetch {
  /** What was held from this time on is marked not fetched; `null` when no deep check ever passed: all of it. */
  since: string | null
  /** Per messenger account, the chats whose held stretches were cut. */
  chats: { provider: string; account: string; chats: number }[]
  /** Per mail account, the folders whose listed mail is to be listed again. */
  mail: { account: string; folders: number }[]
}

type Done = [number, number][]

const integerId = `external_id GLOB '[0-9]*' AND NOT external_id GLOB '*[^0-9]*'`

/**
 * Marks as not fetched what the store held from `cutoff` on, so the next ordinary sync fetches it again: each chat's
 * held stretches end at its last message sent before `cutoff`, and each mail folder forgets the UIDs it listed past
 * the last email it holds from before then. With `cutoff` `null` every stretch and every listed UID is forgotten.
 * Nothing on any service is asked or changed; a service that only pushes (WhatsApp) refills only by pushing.
 */
export const forgetCoverageSince = (database: CacheDatabase, cutoff: number | null, now = Date.now()): Refetch => {
  database.exec("BEGIN")
  try {
    const refetch = forget(database, cutoff, now)
    database.exec("COMMIT")
    return refetch
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

const forget = (database: CacheDatabase, cutoff: number | null, now: number): Refetch => {
  const chats = new Map<string, { provider: string; account: string; chats: number }>()
  const held = database
    .prepare(
      `SELECT c.id, c.account_id, c.external_id AS chat, a.provider, a.external_id AS account,
         max(r.to_key) AS top FROM sync_ranges r JOIN chats c ON c.id = r.chat_id JOIN accounts a ON a.id = c.account_id
       GROUP BY c.id`,
    )
    .all()
  for (const row of held) {
    const chat = Number(row.id)
    const top = Number(row.top)
    const keepTo =
      cutoff === null
        ? null
        : top >= TIME_KEYS
          ? cutoff
          : (database
              .prepare(
                `SELECT max(CAST(external_id AS INTEGER)) AS k FROM messages WHERE chat_id = ? AND sent_at < ? AND ${integerId}`,
              )
              .get(chat, cutoff)?.k as number | null)
    if (keepTo !== null && top <= keepTo) continue
    if (keepTo === null) database.prepare("DELETE FROM sync_ranges WHERE chat_id = ?").run(chat)
    else {
      database.prepare("DELETE FROM sync_ranges WHERE chat_id = ? AND from_key > ?").run(chat, keepTo)
      database
        .prepare("UPDATE sync_ranges SET to_key = ?, updated_at = ? WHERE chat_id = ? AND to_key > ?")
        .run(keepTo, now, chat, keepTo)
    }
    const account = Number(row.account_id)
    const external = String(row.chat)
    database.prepare("DELETE FROM sync_cursors WHERE account_id = ? AND key = ?").run(account, `fetched:${external}`)
    // A start mark with no stretch left that begins at or before it would call the chat complete.
    database
      .prepare(
        `DELETE FROM sync_cursors WHERE account_id = ? AND key = ? AND NOT EXISTS
           (SELECT 1 FROM sync_ranges WHERE chat_id = ? AND from_key <= CAST(sync_cursors.value AS INTEGER))`,
      )
      .run(account, `history_start:${external}`, chat)
    const key = `${row.provider}\u0000${row.account}`
    const one = chats.get(key) ?? { provider: String(row.provider), account: String(row.account), chats: 0 }
    one.chats += 1
    chats.set(key, one)
  }
  return {
    since: cutoff === null ? null : new Date(cutoff).toISOString(),
    chats: [...chats.values()],
    mail: forgetMail(database, cutoff, now),
  }
}

const forgetMail = (database: CacheDatabase, cutoff: number | null, now: number): Refetch["mail"] => {
  const folders = new Map<string, number>()
  const points = database
    .prepare(
      `SELECT s.account_id, s.key, s.value, a.external_id AS account FROM sync_cursors s
         JOIN accounts a ON a.id = s.account_id WHERE a.provider = 'email' AND s.key LIKE 'mail_resume:%'`,
    )
    .all()
  for (const row of points) {
    let point: { validity?: string; done?: Done; size?: number; updatedAt?: string }
    try {
      point = JSON.parse(String(row.value))
    } catch {
      continue
    }
    const account = String(row.account)
    if (!Array.isArray(point.done)) {
      // An mbox file's point: read to its end since the cut, the file is read again; it adds what is not stored.
      if (cutoff !== null && Date.parse(point.updatedAt ?? "") < cutoff) continue
      database
        .prepare("DELETE FROM sync_cursors WHERE account_id = ? AND key = ?")
        .run(Number(row.account_id), String(row.key))
      folders.set(account, (folders.get(account) ?? 0) + 1)
      continue
    }
    const folder = String(row.key).slice("mail_resume:".length)
    const last =
      cutoff === null
        ? null
        : (database
            .prepare(
              `SELECT max(l.uid) AS uid FROM email_locations l JOIN emails e ON e.id = l.email_id
               WHERE l.mailbox_id = (SELECT id FROM mailboxes WHERE account_id = ? AND external_id = ?)
                 AND l.uidvalidity = ? AND coalesce(e.received_at, e.sent_at) < ?`,
            )
            .get(Number(row.account_id), folder, point.validity ?? "", cutoff)?.uid as number | null)
    // Without a located email from before the cut no UID tells the time, so the whole listing is forgotten.
    const done: Done =
      last === null
        ? []
        : point.done
            .filter(([from]) => from <= last)
            .map(([from, to]) => [from, Math.min(to, last)] as [number, number])
    if (JSON.stringify(done) === JSON.stringify(point.done)) continue
    database
      .prepare("UPDATE sync_cursors SET value = ?, updated_at = ? WHERE account_id = ? AND key = ?")
      .run(JSON.stringify({ ...point, done }), now, Number(row.account_id), String(row.key))
    folders.set(account, (folders.get(account) ?? 0) + 1)
  }
  return [...folders].map(([account, count]) => ({ account, folders: count }))
}
