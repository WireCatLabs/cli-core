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
}

export interface MailActivityStore {
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

const MARKS = `
  SELECT e.mail_rule_id, coalesce(json_extract(e.headers, '$."list-id"'), json_extract(e.metadata, '$.listId')) AS list_id,
    EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.email_id = e.id AND b.kind = 'bulk') AS bulk
  FROM emails e WHERE e.account_id = ? AND e.external_id = ? AND e.deleted_at IS NULL`

export const emailMarks = (database: CacheDatabase, accountId: number, externalIds: readonly string[]) => {
  const one = database.prepare(MARKS)
  const marks = new Map<string, EmailMarks>()
  for (const id of externalIds) {
    const row = one.get(accountId, id)
    if (row) marks.set(id, { bulk: Boolean(row.bulk), listId: str(row.list_id), ruleId: int(row.mail_rule_id) })
  }
  return marks
}

export const mailActivity = (database: CacheDatabase): MailActivityStore => ({
  emailMarks: async (accountId, externalIds) => emailMarks(database, accountId, externalIds),
  threadActivity: async (accountId, since, where) => threadActivity(database, accountId, since, where),
})
