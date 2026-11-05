import { contextEvidenceFingerprint } from "../../context/evidence.js"
import { formatLocator } from "../../domain/locator.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { int, str } from "./events.js"
import type { ColumnMap, Where } from "./query-filter.js"

/** What decides whose turn a thread is, read from its newest email that is not a draft; never its text. */
export interface NewestEmail {
  externalId: string
  /** ms: when it was received, or sent when that is unknown. */
  at: number
  outgoing: boolean
  /** The mailbox's own address is in To or Cc. */
  addressed: boolean
  /** Filed in the mailbox of mail sent to many. */
  bulk: boolean
  /** Carries a List-Id. */
  list: boolean
  /** Recorded by an envelope rule, without its text. */
  envelope: boolean
  /** Its sender's mail looks like spam, a scam or a robot (the sender score). */
  demoted: boolean
}

/** One thread with mail after a time: `tasks agenda` and `review` read this, never the emails' text. */
export interface ThreadActivity {
  /** The thread's external id: what a `chat:email/…` reference names. */
  threadId: string
  subject: string | null
  /** ms. */
  lastEmailAt: number
  emails: number
  /** `null` when every email of the thread is a draft. */
  newest: NewestEmail | null
}

/** What a reader sorts mail by, per email: never its text. */
export interface EmailMarks {
  /** Filed in the mailbox of mail sent to many. */
  bulk: boolean
  listId: string | null
  /** The mail rule that decided how it is stored, by its id in `rules list`. */
  ruleId: number | null
  /** What a finding citing this email gives as its evidence fingerprint: a hash of its stored subject and text. */
  fingerprint: string
  /** No earlier stored email, in any account, came from this address. */
  newSender: boolean
  /** How many identities the sender's person has; 1 is this address alone. 0 when the sender is unknown. */
  senderIdentities: number
}

/** One email as a processing mark sees it, by its store id; never its text. */
export interface MarkedEmail {
  id: number
  externalId: string
  thread: string
  /** ms: received, or sent when that is unknown. */
  at: number | null
  /** ms: when the store saved it first, and last changed it. */
  storedAt: number
  changedAt: number
  /** Sent to many: the bulk mailbox or a List-Id. */
  bulk: boolean
  envelope: boolean
  /** Stored from its first bytes, not whole yet. */
  partial: boolean
  draft: boolean
  /** Its sender's mail looks like spam, a scam or a robot (the sender score). */
  demoted: boolean
}

export interface MailActivityStore {
  /**
   * The account's live emails stored after `afterId`, oldest first, at most `limit`, and those of `ids`: what a
   * processing mark reads next. The id is the store's insert order, so mail stored late is never behind the mark.
   */
  emailsAfter(accountId: number, afterId: number, limit: number, ids?: readonly number[]): Promise<MarkedEmail[]>
  /** The account's live emails stored before `beforeId`, newest first, at most `limit`: what a mark moved back reads. */
  emailsBefore(accountId: number, beforeId: number, limit: number): Promise<MarkedEmail[]>
  /** The account's newest store id; 0 with no mail. */
  newestEmailId(accountId: number): Promise<number>
  /** Every `sync_cursors` value of the account whose key starts with `prefix`. */
  statesLike(accountId: number, prefix: string): Promise<{ key: string; value: string; at: number }[]>
  /** Each live email's marks, by its Message-ID; one the store does not hold is left out. */
  emailMarks(accountId: number, externalIds: readonly string[]): Promise<Map<string, EmailMarks>>
  /**
   * Each live thread of the account whose newest email is after `since` (ms), newest first, with the facts of that
   * email. `where` is a `tasks agenda` query compiled over `MAIL_AGENDA_COLUMNS`.
   */
  threadActivity(accountId: number, since: number, where?: Where): Promise<ThreadActivity[]>
}

/** `tasks agenda` fields over `threadActivity`'s threads: an email thread counts as a dialog. */
export const MAIL_AGENDA_COLUMNS = { chat_kind: { type: "enum", sql: "'dialog'" } } as const satisfies ColumnMap

// The thread's own time is the Date header where sync stored one, so a thread is picked by it; the newest email is
// picked by when it arrived, which is what an answer follows.
const ACTIVITY = `
  SELECT t.external_id AS thread, t.subject, t.last_email_at, t.emails_count,
    e.external_id, coalesce(e.received_at, e.sent_at) AS at,
    coalesce(e.outgoing, lower(e.from_address) = lower(a.external_id)) AS outgoing,
    EXISTS (SELECT 1 FROM email_recipients r WHERE r.email_id = e.id AND r.role IN ('to', 'cc')
      AND lower(r.address) = lower(a.external_id)) AS addressed,
    EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.email_id = e.id AND b.kind = 'bulk') AS bulk,
    coalesce(json_extract(e.headers, '$."list-id"'), json_extract(e.metadata, '$.listId')) IS NOT NULL AS list,
    EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.email_id = e.id AND b.kind = 'envelope') AS envelope,
    EXISTS (SELECT 1 FROM account_identities ai WHERE ai.account_id = t.account_id
      AND ai.identity_id = e.from_identity_id AND ai.mail_demoted = 1) AS demoted
  FROM email_threads t JOIN accounts a ON a.id = t.account_id
  LEFT JOIN emails e ON e.id = (SELECT f.id FROM emails f WHERE f.email_thread_id = t.id AND f.deleted_at IS NULL
    AND coalesce(f.draft, 0) = 0 ORDER BY coalesce(f.received_at, f.sent_at) DESC, f.id DESC LIMIT 1)
  WHERE t.account_id = ? AND t.deleted_at IS NULL AND t.last_email_at > ?`

export const threadActivity = (
  database: CacheDatabase,
  accountId: number,
  since: number,
  where?: Where,
): ThreadActivity[] =>
  database
    .prepare(`${ACTIVITY}${where ? ` AND (${where.sql})` : ""} ORDER BY t.last_email_at DESC, t.id DESC`)
    .all(accountId, since, ...((where?.params ?? []) as SqlValue[]))
    .map((row) => ({
      threadId: String(row.thread),
      subject: str(row.subject),
      lastEmailAt: Number(row.last_email_at),
      emails: Number(row.emails_count),
      newest:
        row.external_id == null
          ? null
          : {
              externalId: String(row.external_id),
              at: int(row.at) ?? Number(row.last_email_at),
              outgoing: Boolean(row.outgoing),
              addressed: Boolean(row.addressed),
              bulk: Boolean(row.bulk),
              list: Boolean(row.list),
              envelope: Boolean(row.envelope),
              demoted: Boolean(row.demoted),
            },
    }))

/** A thread's live emails, oldest first; `window` keeps those received in (after, until], in ms. */
export const threadEmailIds = (
  database: CacheDatabase,
  accountId: number,
  thread: string,
  { after, until }: { after?: number; until?: number } = {},
): number[] =>
  database
    .prepare(
      `SELECT e.id FROM emails e JOIN email_threads t ON t.id = e.email_thread_id
        WHERE t.account_id = ? AND t.external_id = ? AND e.deleted_at IS NULL
          AND coalesce(e.received_at, e.sent_at, 0) > coalesce(?, -1)
          AND coalesce(e.received_at, e.sent_at, 0) <= coalesce(?, 9e15)
        ORDER BY coalesce(e.sent_at, e.received_at), e.id`,
    )
    .all(accountId, thread, after ?? null, until ?? null)
    .map(({ id }) => Number(id))

// The subject and text are read only to hash them as `contextRecordOf` does, so a cited fingerprint matches.
const MARKS = `
  SELECT e.mail_rule_id, coalesce(json_extract(e.headers, '$."list-id"'), json_extract(e.metadata, '$.listId')) AS list_id,
    EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.email_id = e.id AND b.kind = 'bulk') AS bulk,
    a.provider, a.external_id AS account, t.external_id AS thread, e.subject, coalesce(e.body_text, '') AS body,
    e.from_identity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM emails f
      WHERE f.from_identity_id = e.from_identity_id AND f.id < e.id AND f.deleted_at IS NULL) AS new_sender,
    (SELECT count(*) FROM identity_links o WHERE o.person_id =
      (SELECT l.person_id FROM identity_links l WHERE l.identity_id = e.from_identity_id)) AS identities
  FROM emails e JOIN accounts a ON a.id = e.account_id JOIN email_threads t ON t.id = e.email_thread_id
  WHERE e.account_id = ? AND e.external_id = ? AND e.deleted_at IS NULL`

export const emailMarks = (database: CacheDatabase, accountId: number, externalIds: readonly string[]) => {
  const one = database.prepare(MARKS)
  const marks = new Map<string, EmailMarks>()
  for (const id of externalIds) {
    const row = one.get(accountId, id)
    if (!row) continue
    const ref = formatLocator({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.thread),
      message: id,
    })
    marks.set(id, {
      bulk: Boolean(row.bulk),
      listId: str(row.list_id),
      ruleId: int(row.mail_rule_id),
      fingerprint: contextEvidenceFingerprint({ ref, title: str(row.subject), text: String(row.body), revision: null }),
      newSender: Boolean(row.new_sender),
      senderIdentities: Number(row.identities ?? 0),
    })
  }
  return marks
}

const MARKED = `
  SELECT e.id, e.external_id, t.external_id AS thread, coalesce(e.received_at, e.sent_at) AS at, e.created_at,
    e.updated_at, coalesce(e.draft, 0) AS draft, json_extract(e.metadata, '$.partial') IS NOT NULL AS partial,
    coalesce(json_extract(e.headers, '$."list-id"'), json_extract(e.metadata, '$.listId')) IS NOT NULL
      OR EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE m.email_id = e.id AND b.kind = 'bulk') AS bulk,
    EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.email_id = e.id AND b.kind = 'envelope') AS envelope,
    EXISTS (SELECT 1 FROM account_identities ai WHERE ai.account_id = e.account_id
      AND ai.identity_id = e.from_identity_id AND ai.mail_demoted = 1) AS demoted
  FROM emails e JOIN email_threads t ON t.id = e.email_thread_id`

const markedOf = (row: Record<string, unknown>): MarkedEmail => ({
  id: Number(row.id),
  externalId: String(row.external_id),
  thread: String(row.thread),
  at: int(row.at),
  storedAt: Number(row.created_at),
  changedAt: Number(row.updated_at),
  bulk: Boolean(row.bulk),
  envelope: Boolean(row.envelope),
  partial: Boolean(row.partial),
  draft: Boolean(row.draft),
  demoted: Boolean(row.demoted),
})

export const emailsAfter = (
  database: CacheDatabase,
  accountId: number,
  afterId: number,
  limit: number,
  ids: readonly number[] = [],
): MarkedEmail[] => {
  const next = database
    .prepare(`${MARKED} WHERE e.id > ? AND e.account_id = ? AND e.deleted_at IS NULL ORDER BY e.id LIMIT ?`)
    .all(afterId, accountId, limit)
  const one = database.prepare(`${MARKED} WHERE e.id = ? AND e.account_id = ? AND e.deleted_at IS NULL`)
  const named = ids.flatMap((id) => {
    const row = one.get(id, accountId)
    return row ? [row] : []
  })
  return [...named, ...next].map(markedOf)
}

export const mailActivity = (database: CacheDatabase): MailActivityStore => ({
  emailsAfter: async (accountId, afterId, limit, ids) => emailsAfter(database, accountId, afterId, limit, ids),
  emailsBefore: async (accountId, beforeId, limit) =>
    database
      .prepare(`${MARKED} WHERE e.id < ? AND e.account_id = ? AND e.deleted_at IS NULL ORDER BY e.id DESC LIMIT ?`)
      .all(beforeId, accountId, limit)
      .map(markedOf),
  newestEmailId: async (accountId) =>
    Number(database.prepare("SELECT max(id) AS id FROM emails WHERE account_id = ?").get(accountId)?.id ?? 0),
  statesLike: async (accountId, prefix) =>
    database
      .prepare("SELECT key, value, updated_at FROM sync_cursors WHERE account_id = ? AND substr(key, 1, ?) = ?")
      .all(accountId, prefix.length, prefix)
      .map((row) => ({ key: String(row.key), value: String(row.value), at: Number(row.updated_at) })),
  emailMarks: async (accountId, externalIds) => emailMarks(database, accountId, externalIds),
  threadActivity: async (accountId, since, where) => threadActivity(database, accountId, since, where),
})
