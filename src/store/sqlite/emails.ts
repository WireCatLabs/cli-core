import type { Chunk } from "../../conversations/chunks.js"
import { formatLocator } from "../../domain/locator.js"
import type { MailFields, MailPerson, Message } from "../../domain/models.js"
import { formatReference } from "../../domain/references.js"
import type { Attachment, Metadata } from "../../meetings/index.js"
import type { Stemmer, Stemmers } from "../../search/stem.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { fold, normalize } from "../normalize.js"
import type { ConversationSummary, StoredHit } from "../types.js"
import {
  chunkAttachments,
  drainEmailIndex,
  dropAttachmentChunks,
  MAIL_PIECES,
  queueThreads,
  threadPieces,
  titleOf,
} from "./email-index.js"
import {
  type EmailLocationInput,
  type FolderEmail,
  folderEmails,
  forgetLocations,
  locate,
  setLocations,
} from "./email-locations.js"
import { markEmailsDeleted, markEmailsRestored, recountEmailThread as recount, setEmailFlags } from "./email-state.js"

import { bool, flag, fromJson, int, page, str, toJson } from "./events.js"
import { folded } from "./folded.js"
import { ensurePerson } from "./identities.js"
import { type MailRulesStore, mailRulesOver } from "./mail-rules.js"
import { type AttachmentInput, attachmentOf, saveAttachment, wordsQuery } from "./meetings.js"
import type { Orm, StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { write } from "./transaction.js"
import { dropUnusedVectors } from "./vector-index.js"

export type { EmailLocationInput, FolderEmail }

import { dot } from "./vectors.js"

type Row = Record<string, unknown>

export interface EmailAddress {
  address: string
  name: string | null
}

export interface MailboxInput {
  externalId: string
  name: string
  kind: string | null
}

/** One email to save. A field left out keeps what was stored; the recipients are replaced when any role is given. */
export interface EmailInput {
  /** The Message-ID header. */
  externalId: string
  subject: string | null
  from: EmailAddress | null
  to?: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  replyTo?: EmailAddress[]
  sentAt: number | null
  receivedAt?: number | null
  inReplyTo?: string | null
  references?: string[] | null
  bodyText: string | null
  bodyHtml?: string | null
  snippet?: string | null
  outgoing?: boolean | null
  read?: boolean | null
  flagged?: boolean | null
  draft?: boolean | null
  size?: number | null
  headers?: Metadata
  metadata?: Metadata
  /** The `mail_rules` row that decided how this email is stored; `null` clears it. */
  mailRuleId?: number | null
  /** Added to the mailboxes the email is already in; one scan sees one folder, so none is taken away. */
  mailboxes?: MailboxInput[]
  /** Added to the locations the email has; a UID already known in that folder now points here. */
  locations?: EmailLocationInput[]
  /** Replaced when given; the text is word-indexed. */
  attachments?: AttachmentInput[]
}

export interface ThreadSave {
  accountId: number
  externalId: string
  /** Without it, a new thread takes its first email's subject, without Re: and Fwd:. */
  subject?: string | null
  metadata?: Metadata
  emails: EmailInput[]
  now: number
}

export interface EmailThread {
  id: number
  accountId: number
  externalId: string
  subject: string | null
  lastEmailAt: number | null
  emailsCount: number
  metadata: Metadata
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface EmailRecipient {
  identityId: number | null
  address: string
  name: string | null
  role: "to" | "cc" | "bcc" | "reply_to"
  position: number
}

export interface Mailbox {
  id: number
  accountId: number
  externalId: string
  name: string
  kind: string | null
}

export type EmailAttachment = Omit<Attachment, "attachableType"> & { attachableType: "email" }

export interface Email {
  id: number
  accountId: number
  emailThreadId: number
  externalId: string
  subject: string | null
  fromIdentityId: number | null
  fromAddress: string | null
  fromName: string | null
  sentAt: number | null
  receivedAt: number | null
  inReplyTo: string | null
  references: string[] | null
  bodyText: string | null
  bodyHtml: string | null
  snippet: string | null
  outgoing: boolean | null
  read: boolean | null
  flagged: boolean | null
  draft: boolean | null
  size: number | null
  headers: Metadata
  metadata: Metadata
  mailRuleId: number | null
  recipients: EmailRecipient[]
  mailboxes: Mailbox[]
  attachments: EmailAttachment[]
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface ThreadDetails {
  thread: EmailThread
  /** Oldest first. */
  emails: Email[]
}

/** An email and the thread it is in, as a conversation hit shows them. */
export interface EmailInThread {
  emailId: number
  externalId: string
  threadExternalId: string
  /** The thread's first email, and its first and last time. */
  threadFirstExternalId: string
  threadFirstAt: number | null
  threadLastAt: number | null
  threadEmails: number
  threadSenders: number
}

export interface EmailVectorHit extends EmailInThread {
  score: number
}

/** A thread as a conversation: the summary `search conversations` and `related` answer for an email. */
export const threadConversation = (place: EmailInThread, builtAt: number): ConversationSummary => ({
  id: `email:${place.emailId}`,
  chatId: place.threadExternalId,
  firstMessageId: place.threadFirstExternalId,
  firstAt: new Date(place.threadFirstAt ?? 0).toISOString(),
  lastAt: new Date(place.threadLastAt ?? place.threadFirstAt ?? 0).toISOString(),
  messageCount: place.threadEmails,
  senders: place.threadSenders,
  builtAt: new Date(builtAt).toISOString(),
  algorithmVersion: 0,
})

const inThread = (database: CacheDatabase, emailId: number): EmailInThread | undefined => {
  const row = database
    .prepare(
      `SELECT e.external_id, t.external_id AS thread, t.last_email_at, t.emails_count,
         (SELECT f.external_id FROM emails f WHERE f.email_thread_id = t.id AND f.deleted_at IS NULL
           ORDER BY coalesce(f.sent_at, f.received_at), f.id LIMIT 1) AS first_email,
         (SELECT min(coalesce(f.sent_at, f.received_at)) FROM emails f WHERE f.email_thread_id = t.id AND f.deleted_at IS NULL) AS first_at,
         (SELECT count(DISTINCT f.from_address) FROM emails f WHERE f.email_thread_id = t.id AND f.deleted_at IS NULL) AS senders
         FROM emails e JOIN email_threads t ON t.id = e.email_thread_id WHERE e.id = ?`,
    )
    .get(emailId)
  return row
    ? {
        emailId,
        externalId: String(row.external_id),
        threadExternalId: String(row.thread),
        threadFirstExternalId: String(row.first_email ?? row.external_id),
        threadFirstAt: int(row.first_at),
        threadLastAt: int(row.last_email_at),
        threadEmails: Number(row.emails_count),
        threadSenders: Number(row.senders),
      }
    : undefined
}

export interface MailFilter {
  accountId?: number
  includeDeleted?: boolean
  limit?: number
  offset?: number
}

export interface EmailFilter extends MailFilter {
  threadExternalId?: string
  /** An address in From, To, Cc, Bcc or Reply-To. */
  participant?: string
  /** A mailbox's external id. */
  mailbox?: string
  /** On the received time, or the sent time when that is unknown: IMAP's SINCE counts by the received day. */
  since?: number
  /** Exclusive. `momentOf` and `dateWindow` with `end` give the last millisecond of a day, an inclusive end: add 1. */
  until?: number
  /** Only emails with an attachment whose text extraction failed with one of these errors. */
  attachmentErrors?: string[]
}

export interface EmailRef {
  externalId: string
  deleted: boolean
  mailboxes: { externalId: string; kind: string | null }[]
}

/** What a mail rule can know of a stored email, without its text: enough to decide a whole mailbox locally. */
export interface EmailFacts {
  externalId: string
  fromAddress: string | null
  fromName: string | null
  subject: string | null
  receivedAt: number | null
  size: number | null
  read: boolean
  flagged: boolean
  outgoing: boolean
  listId: string | null
  /** To and Cc addresses. */
  recipients: string[]
  mailboxes: { externalId: string; name: string; kind: string | null }[]
  /** Reply-To and the DKIM and DMARC verdicts Gmail stamped, as the import kept them; null when absent. */
  replyTo: string | null
  dkim: string | null
  dmarc: string | null
}

/** A sender's score as one mail account sees it: how much its mail looks like spam, a scam or a robot. */
export interface SenderScore {
  address: string
  score: number
  signals: string[]
  /** Search ranks this sender's mail lower. */
  demoted?: boolean
}

/** Mail in tables of its own: threads, emails, recipients and mailboxes, keyed by account and Message-ID. */
export interface MailStore {
  saveThread(input: ThreadSave): Promise<ThreadDetails>
  /** Newest activity first. */
  threads(filter?: MailFilter): Promise<EmailThread[]>
  thread(id: number): Promise<ThreadDetails | null>
  email(accountId: number, externalId: string): Promise<Email | null>
  /** Newest first. */
  emails(filter?: EmailFilter): Promise<Email[]>
  /** Each matching email's Message-ID and mailboxes, without text or people: cheap over a whole mailbox. */
  emailRefs(filter?: Omit<EmailFilter, "limit" | "offset">): Promise<EmailRef[]>
  /** Each matching email's sender, recipients, list, size, flag and mailboxes, oldest first; no text. */
  emailFacts(filter?: Omit<EmailFilter, "limit" | "offset">): Promise<EmailFacts[]>
  /**
   * Keeps each sender's score for the account, shown on its email hits. Senders left out keep the score they had.
   * Answers how many were written.
   */
  setSenderScores(accountId: number, scores: readonly SenderScore[], now: number): Promise<number>
  mailboxes(accountId: number): Promise<Mailbox[]>
  /**
   * Sets each email's membership among the `scanned` mailboxes to the ones it was found in; membership outside
   * `scanned` stays, since a scan proves nothing about a folder it did not read. Answers how many emails it found.
   */
  setMailboxes(
    accountId: number,
    scanned: MailboxInput[],
    found: ReadonlyMap<string, string[]>,
    now: number,
  ): Promise<number>
  /**
   * Read and flagged as the source shows them now, for emails already stored; a flag left out stays. Answers how
   * many emails changed.
   */
  setFlags(
    accountId: number,
    flags: ReadonlyMap<string, { read?: boolean; flagged?: boolean }>,
    now: number,
  ): Promise<number>
  /** The live emails whose location in `folder` has this UIDVALIDITY, oldest UID first. */
  folderEmails(accountId: number, folder: string, uidvalidity: string): Promise<FolderEmail[]>
  /**
   * Records where emails the store holds are in `folder`, by Message-ID; one it does not hold is left out. Locations
   * of the folder under another UIDVALIDITY are dropped: its UIDs mean nothing now.
   */
  setLocations(
    accountId: number,
    folder: string,
    uidvalidity: string,
    found: ReadonlyMap<string, number[]>,
  ): Promise<number>
  /** Forgets that these UIDs of `folder` hold anything; an email left with no location there leaves the folder too. */
  forgetLocations(accountId: number, folder: string, uidvalidity: string, uids: number[]): Promise<void>
  /** Marks emails gone at the source and drops their text; saving one again brings it back. Answers how many changed. */
  markDeleted(accountId: number, externalIds: string[], now: number): Promise<number>
  /**
   * Clears the deleted mark of emails brought back at the source. Their text is not restored, so pass only emails
   * that held none (envelopes); a whole email comes back when the next listing that sees it saves it again.
   */
  markRestored(accountId: number, externalIds: string[], now: number): Promise<number>
  /** Every word of the query, as a prefix, in the subject or body; newest first. */
  search(query: string, filter?: Omit<EmailFilter, "includeDeleted">): Promise<Email[]>
  /** Text pieces of live emails with no vector of `model`, by content hash, for an embedder to fill. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<{ hash: string; text: string }[]>
  /** Live emails of one account by Message-ID, each placed in its thread; an unknown one is left out. */
  inThreads(accountId: number, externalIds: string[]): Promise<EmailInThread[]>
  /** A thread's live emails, oldest first, as search hits: whole text, people, labels and locator. */
  threadHits(accountId: number, threadExternalId: string): Promise<StoredHit[]>
  /** The emails of one account nearest in meaning to `query`, each by its best chunk, best first. */
  nearest(
    model: string,
    query: Float32Array,
    options: { accountId: number; limit: number; threadExternalId?: string; since?: number },
  ): Promise<EmailVectorHit[]>
  /** The account's mail rules, and which rule decided each email. */
  readonly rules: MailRulesStore
}

const ROLES = [
  ["to", "to"],
  ["cc", "cc"],
  ["bcc", "bcc"],
  ["replyTo", "reply_to"],
] as const

const threadOf = (row: Row): EmailThread => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  externalId: String(row.external_id),
  subject: str(row.subject),
  lastEmailAt: int(row.last_email_at),
  emailsCount: Number(row.emails_count),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  deletedAt: int(row.deleted_at),
})

const emailOf = (database: CacheDatabase, row: Row): Email => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  emailThreadId: Number(row.email_thread_id),
  externalId: String(row.external_id),
  subject: str(row.subject),
  fromIdentityId: int(row.from_identity_id),
  fromAddress: str(row.from_address),
  fromName: str(row.from_name),
  sentAt: int(row.sent_at),
  receivedAt: int(row.received_at),
  inReplyTo: str(row.in_reply_to),
  references: fromJson(row.references),
  bodyText: str(row.body_text),
  bodyHtml: str(row.body_html),
  snippet: str(row.snippet),
  outgoing: bool(row.outgoing),
  read: bool(row.read),
  flagged: bool(row.flagged),
  draft: bool(row.draft),
  size: int(row.size),
  headers: fromJson(row.headers),
  metadata: fromJson(row.metadata),
  mailRuleId: int(row.mail_rule_id),
  recipients: database
    .prepare("SELECT * FROM email_recipients WHERE email_id = ? ORDER BY position")
    .all(Number(row.id))
    .map((r) => ({
      identityId: int(r.identity_id),
      address: String(r.address),
      name: str(r.name),
      role: String(r.role) as EmailRecipient["role"],
      position: Number(r.position),
    })),
  mailboxes: database
    .prepare(
      "SELECT b.* FROM email_mailboxes e JOIN mailboxes b ON b.id = e.mailbox_id WHERE e.email_id = ? ORDER BY b.id",
    )
    .all(Number(row.id))
    .map((b) => ({
      id: Number(b.id),
      accountId: Number(b.account_id),
      externalId: String(b.external_id),
      name: String(b.name),
      kind: str(b.kind),
    })),
  attachments: database
    .prepare("SELECT * FROM attachments WHERE attachable_type = 'email' AND attachable_id = ? ORDER BY position")
    .all(Number(row.id))
    .map((a) => ({ ...attachmentOf(a), attachableType: "email" as const })),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  deletedAt: int(row.deleted_at),
})

const threadDetails = (database: CacheDatabase, id: number): ThreadDetails | null => {
  const row = database.prepare("SELECT * FROM email_threads WHERE id = ?").get(id)
  if (!row) return null
  return {
    thread: threadOf(row),
    emails: database
      .prepare("SELECT * FROM emails WHERE email_thread_id = ? ORDER BY coalesce(sent_at, received_at), id")
      .all(id)
      .map((e) => emailOf(database, e)),
  }
}

/** An address is an identity of provider `email`; a display name fills only a nameless one. */
const addressIdentity = (
  database: CacheDatabase,
  orm: Orm,
  accountId: number,
  { address, name }: EmailAddress,
  now: number,
): number => {
  const id = identityOf(database, { address, name }, now)
  ensurePerson(orm, id, name, now)
  // The account has seen them, so `from:` and the people of the account find mail correspondents.
  database
    .prepare(
      "INSERT INTO account_identities (account_id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .run(accountId, id, now, now)
  return id
}

const identityOf = (database: CacheDatabase, { address, name }: EmailAddress, now: number): number => {
  const key = address.trim().toLowerCase()
  const found = database
    .prepare("SELECT id, name FROM identities WHERE provider = 'email' AND external_id = ?")
    .get(key)
  if (found) {
    if (found.name === null && name)
      database
        .prepare("UPDATE identities SET name = ?, name_folded = ?, updated_at = ? WHERE id = ?")
        .run(name, fold(name), now, Number(found.id))
    return Number(found.id)
  }
  return Number(
    database
      .prepare(
        "INSERT INTO identities (provider, external_id, name, name_folded, created_at, updated_at) VALUES ('email', ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(key, name, folded(name), now, now)?.id,
  )
}

const mailboxPk = (database: CacheDatabase, accountId: number, box: MailboxInput, now: number): number => {
  if (!box.externalId) throw new Error("Invalid mailbox key")
  return Number(
    database
      .prepare(
        `INSERT INTO mailboxes (account_id, external_id, name, name_folded, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, external_id) DO UPDATE SET name = excluded.name, name_folded = excluded.name_folded,
             kind = coalesce(excluded.kind, kind), updated_at = excluded.updated_at
           RETURNING id`,
      )
      .get(accountId, box.externalId, box.name, fold(box.name), box.kind, now, now)?.id,
  )
}

const join = (database: CacheDatabase, emailId: number, mailboxId: number, now: number) =>
  database
    .prepare("INSERT OR IGNORE INTO email_mailboxes (email_id, mailbox_id, created_at) VALUES (?, ?, ?)")
    .run(emailId, mailboxId, now)

const saveEmail = (
  database: CacheDatabase,
  orm: Orm,
  accountId: number,
  threadId: number,
  mail: EmailInput,
  now: number,
) => {
  if (!mail.externalId) throw new Error("Invalid email key")
  const from = mail.from ? { ...mail.from, address: mail.from.address.trim().toLowerCase() } : null
  const values: [string, SqlValue][] = [
    ["email_thread_id", threadId],
    ["subject", mail.subject],
    ["from_identity_id", from ? addressIdentity(database, orm, accountId, from, now) : null],
    ["from_address", from?.address ?? null],
    ["from_name", from?.name ?? null],
    ["sent_at", mail.sentAt],
    ["body_text", mail.bodyText],
  ]
  const optional: [keyof EmailInput, string, (value: never) => SqlValue][] = [
    ["receivedAt", "received_at", (v: number | null) => v],
    ["inReplyTo", "in_reply_to", (v: string | null) => v],
    ["references", '"references"', toJson],
    ["bodyHtml", "body_html", (v: string | null) => v],
    ["snippet", "snippet", (v: string | null) => v],
    ["outgoing", "outgoing", flag],
    ["read", "read", flag],
    ["flagged", "flagged", flag],
    ["draft", "draft", flag],
    ["size", "size", (v: number | null) => v],
    ["headers", "headers", toJson],
    ["metadata", "metadata", toJson],
    ["mailRuleId", "mail_rule_id", (v: number | null) => v],
  ]
  for (const [field, column, encode] of optional)
    if (mail[field] !== undefined) values.push([column, encode(mail[field] as never)])

  const found = database
    .prepare("SELECT id, email_thread_id FROM emails WHERE account_id = ? AND external_id = ?")
    .get(accountId, mail.externalId)
  let emailId: number
  if (found) {
    emailId = Number(found.id)
    database
      .prepare(
        `UPDATE emails SET ${values.map(([c]) => `${c} = ?`).join(", ")}, deleted_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(...values.map(([, v]) => v), now, emailId)
  } else {
    const columns = ["account_id", "external_id", ...values.map(([c]) => c), "created_at", "updated_at"]
    emailId = Number(
      database
        .prepare(
          `INSERT INTO emails (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
        )
        .get(accountId, mail.externalId, ...values.map(([, v]) => v), now, now)?.id,
    )
  }

  if (ROLES.some(([field]) => mail[field] !== undefined)) {
    database.prepare("DELETE FROM email_recipients WHERE email_id = ?").run(emailId)
    const insert = database.prepare(
      `INSERT INTO email_recipients (email_id, identity_id, address, name, role, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let position = 0
    for (const [field, role] of ROLES)
      for (const recipient of mail[field] ?? []) {
        const address = recipient.address.trim().toLowerCase()
        const identity = addressIdentity(database, orm, accountId, recipient, now)
        insert.run(emailId, identity, address, recipient.name, role, position++, now, now)
      }
  }

  for (const box of mail.mailboxes ?? []) join(database, emailId, mailboxPk(database, accountId, box, now), now)
  for (const where of mail.locations ?? []) locate(database, accountId, emailId, where)

  if (mail.attachments !== undefined) {
    const before = dropAttachmentChunks(database, emailId)
    const positions = mail.attachments.map(({ position }) => position)
    database
      .prepare(
        `DELETE FROM attachments WHERE attachable_type = 'email' AND attachable_id = ?
           AND position NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(emailId, JSON.stringify(positions))
    for (const a of mail.attachments)
      saveAttachment(
        database,
        "email",
        emailId,
        { ...a, normalizedText: a.text === null ? null : normalize(a.text) },
        now,
      )
    chunkAttachments(database, accountId, emailId, now)
    dropUnusedVectors(database, before)
  }
  return found ? Number(found.email_thread_id) : null
}

const saveThread = (database: CacheDatabase, orm: Orm, input: ThreadSave): number => {
  const { accountId, externalId, now } = input
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !externalId) throw new Error("Invalid thread key")
  const found = database
    .prepare("SELECT id FROM email_threads WHERE account_id = ? AND external_id = ?")
    .get(accountId, externalId)
  const threadId = found
    ? Number(found.id)
    : Number(
        database
          .prepare(
            `INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)
               RETURNING id`,
          )
          .get(accountId, externalId, now, now)?.id,
      )
  if (input.subject !== undefined)
    database
      .prepare("UPDATE email_threads SET subject = ?, subject_folded = ? WHERE id = ?")
      .run(input.subject, folded(input.subject), threadId)
  if (input.metadata !== undefined)
    database.prepare("UPDATE email_threads SET metadata = ? WHERE id = ?").run(toJson(input.metadata), threadId)
  const moved = new Set<number>()
  for (const mail of input.emails) {
    const before = saveEmail(database, orm, accountId, threadId, mail, now)
    if (before !== null && before !== threadId) moved.add(before)
  }
  const first = database
    .prepare("SELECT subject FROM emails WHERE email_thread_id = ? ORDER BY coalesce(sent_at, received_at), id LIMIT 1")
    .get(threadId)
  const subject = titleOf(str(first?.subject))
  database
    .prepare("UPDATE email_threads SET subject = ?, subject_folded = ? WHERE id = ? AND subject IS NULL")
    .run(subject, folded(subject), threadId)
  for (const id of [threadId, ...moved]) recount(database, id, now)
  queueThreads(database, moved)
  return threadId
}

const emailWhere = (filter: EmailFilter): [string, SqlValue[]] => {
  const where = ["(? OR e.deleted_at IS NULL)"]
  const params: SqlValue[] = [filter.includeDeleted ? 1 : 0]
  const add = (sql: string, ...values: SqlValue[]) => {
    where.push(sql)
    for (const value of values) params.push(value)
  }
  if (filter.accountId !== undefined) add("e.account_id = ?", filter.accountId)
  if (filter.threadExternalId !== undefined)
    add(
      "e.email_thread_id IN (SELECT id FROM email_threads WHERE external_id = ? AND account_id = e.account_id)",
      filter.threadExternalId,
    )
  if (filter.participant !== undefined) {
    const address = filter.participant.trim().toLowerCase()
    add("(e.from_address = ? OR e.id IN (SELECT email_id FROM email_recipients WHERE address = ?))", address, address)
  }
  if (filter.mailbox !== undefined)
    add(
      // Per email through the (email_id, mailbox_id) key: an IN over the account's membership rows is correlated by
      // the account, so SQLite ran it again for every email, minutes on a mailbox of 250k.
      `EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
         WHERE m.email_id = e.id AND b.external_id = ? AND b.account_id = e.account_id)`,
      filter.mailbox,
    )
  if (filter.since !== undefined) add("coalesce(e.received_at, e.sent_at) >= ?", filter.since)
  if (filter.until !== undefined) add("coalesce(e.received_at, e.sent_at) < ?", filter.until)
  if (filter.attachmentErrors !== undefined)
    add(
      `e.id IN (SELECT attachable_id FROM attachments WHERE attachable_type = 'email'
         AND extraction_error IN (${filter.attachmentErrors.map(() => "?").join(",") || "NULL"}))`,
      ...filter.attachmentErrors,
    )
  return [where.join(" AND "), params]
}

/** An email as a message of its thread, the shape mail had when it was stored as messages. */
export const messageOfEmail = (email: Email, thread: string): Message => {
  const role = (wanted: EmailRecipient["role"]) =>
    email.recipients.filter(({ role }) => role === wanted).map(({ address }) => address)
  return {
    id: email.externalId,
    chatId: thread,
    senderId: email.fromAddress,
    senderName: email.fromName,
    timestamp: new Date(email.sentAt ?? email.receivedAt ?? email.createdAt).toISOString(),
    editedAt: null,
    text: [email.subject, email.bodyText].filter(Boolean).join("\n\n"),
    outgoing: email.outgoing,
    attachments: email.attachments.map((a) => ({
      kind: a.kind,
      ...(a.name === null ? {} : { name: a.name }),
      ...(a.mime === null ? {} : { mime: a.mime }),
      ...(a.size === null ? {} : { size: a.size }),
      ...(a.providerRef !== null && typeof a.providerRef === "object" && !Array.isArray(a.providerRef)
        ? { providerRef: a.providerRef }
        : {}),
    })),
    providerMetadata: { emailHeaders: { cc: role("cc"), bcc: role("bcc") } },
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }
}

/**
 * An email's people, labels and thread for a reader. memo's import once filed every Cc address under To as well,
 * so an address in Cc is shown in Cc only.
 */
const mailFieldsOf = (database: CacheDatabase, email: Email, thread: string, key: AccountRow): MailFields => {
  const personOf = database.prepare("SELECT person_id AS person FROM identity_links WHERE identity_id = ?")
  const person = (identityId: number | null, address: string, name: string | null): MailPerson => {
    const found = identityId === null ? undefined : personOf.get(identityId)
    return { name, address, ref: found ? `person:${found.person}` : null }
  }
  const of = (role: EmailRecipient["role"]) =>
    email.recipients
      .filter((recipient) => recipient.role === role)
      .map(({ identityId, address, name }) => person(identityId, address, name))
  const cc = of("cc")
  const copied = new Set(cc.map(({ address }) => address.toLowerCase()))
  const scored =
    email.fromIdentityId === null
      ? undefined
      : database
          .prepare(
            `SELECT mail_score, mail_signals, mail_demoted FROM account_identities
               WHERE account_id = ? AND identity_id = ? AND mail_score IS NOT NULL`,
          )
          .get(email.accountId, email.fromIdentityId)
  return {
    subject: email.subject,
    from: email.fromAddress === null ? null : person(email.fromIdentityId, email.fromAddress, email.fromName),
    to: of("to").filter(({ address }) => !copied.has(address.toLowerCase())),
    cc,
    bcc: of("bcc"),
    replyTo: of("reply_to"),
    labels: email.mailboxes.map(({ name }) => name),
    thread: formatReference({ type: "chat", provider: key.provider, account: key.account, chat: thread }),
    read: email.read,
    flagged: email.flagged,
    ...(scored === undefined
      ? {}
      : {
          senderScore: {
            score: Number(scored.mail_score),
            signals: JSON.parse(String(scored.mail_signals ?? "[]")) as string[],
            ...(scored.mail_demoted ? { demoted: true } : {}),
          },
        }),
  }
}

interface AccountRow {
  provider: string
  account: string
}

/** Emails as search hits, in the order of `pks`: the thread is the chat, so a hit's locator is the one mail had as messages. */
export const emailHitsByPk = (database: CacheDatabase, pks: number[]): StoredHit[] => {
  const read = database.prepare(
    `SELECT e.*, t.external_id AS thread, t.subject AS thread_subject, a.provider, a.external_id AS account
       FROM emails e JOIN email_threads t ON t.id = e.email_thread_id JOIN accounts a ON a.id = e.account_id
       WHERE e.id = ?`,
  )
  return pks.flatMap((pk) => {
    const row = read.get(pk)
    if (!row) return []
    const thread = String(row.thread)
    const email = emailOf(database, row)
    const message = messageOfEmail(email, thread)
    const key = { provider: String(row.provider), account: String(row.account) }
    return [
      {
        ...message,
        chatTitle: str(row.thread_subject),
        email: mailFieldsOf(database, email, thread, key),
        locator: formatLocator({
          provider: String(row.provider),
          account: String(row.account),
          chat: thread,
          message: message.id,
        }),
      },
    ]
  })
}

/**
 * Indexes the queued emails as the notes are indexed, words and stems of the subject, then the body; then cuts
 * the threads they belong to into pieces for search by meaning.
 */
export const mailStoreOver = (
  { database, orm }: Pick<StoreContext, "database" | "orm">,
  stemmerFor: (stemmers: Stemmers) => Stemmer = stemmerCache(),
): MailStore => ({
  rules: mailRulesOver(database),
  async saveThread(input) {
    const id = write(database, () => saveThread(database, orm, input))
    return threadDetails(database, id) as ThreadDetails
  },
  async threads(filter = {}) {
    const [limit, offset] = page(filter)
    return database
      .prepare(
        `SELECT * FROM email_threads WHERE (? IS NULL OR account_id = ?) AND (? OR deleted_at IS NULL)
          ORDER BY coalesce(last_email_at, 0) DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(filter.accountId ?? null, filter.accountId ?? null, filter.includeDeleted ? 1 : 0, limit, offset)
      .map(threadOf)
  },
  async thread(id) {
    return threadDetails(database, id)
  },
  async email(accountId, externalId) {
    const row = database
      .prepare("SELECT * FROM emails WHERE account_id = ? AND external_id = ?")
      .get(accountId, externalId)
    return row ? emailOf(database, row) : null
  },
  async emails(filter = {}) {
    const [limit, offset] = page(filter)
    const [where, params] = emailWhere(filter)
    return database
      .prepare(
        `SELECT e.* FROM emails e WHERE ${where}
          ORDER BY coalesce(e.sent_at, e.received_at) DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map((row) => emailOf(database, row))
  },
  async emailRefs(filter = {}) {
    const [where, params] = emailWhere(filter)
    return database
      .prepare(
        `SELECT e.external_id, e.deleted_at IS NOT NULL AS deleted,
           (SELECT json_group_array(json_object('externalId', b.external_id, 'kind', b.kind))
              FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.email_id = e.id) AS boxes
         FROM emails e WHERE ${where}`,
      )
      .all(...params)
      .map((row) => ({
        externalId: String(row.external_id),
        deleted: Boolean(row.deleted),
        mailboxes: JSON.parse(String(row.boxes)) as EmailRef["mailboxes"],
      }))
  },
  async emailFacts(filter = {}) {
    const [where, params] = emailWhere(filter)
    return database
      .prepare(
        `SELECT e.external_id, e.from_address, e.from_name, e.subject, coalesce(e.received_at, e.sent_at) AS at, e.size,
           e.read, e.flagged,
           e.outgoing, json_extract(e.metadata, '$.listId') AS list_id,
           json_extract(e.headers, '$."reply-to"') AS reply_to, json_extract(e.headers, '$.dkim') AS dkim,
           json_extract(e.headers, '$.dmarc') AS dmarc,
           (SELECT json_group_array(r.address) FROM email_recipients r
              WHERE r.email_id = e.id AND r.role IN ('to', 'cc')) AS recipients,
           (SELECT json_group_array(json_object('externalId', b.external_id, 'name', b.name, 'kind', b.kind))
              FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.email_id = e.id) AS boxes
         FROM emails e WHERE ${where} ORDER BY at, e.id`,
      )
      .all(...params)
      .map((row) => ({
        externalId: String(row.external_id),
        fromAddress: str(row.from_address),
        fromName: str(row.from_name),
        subject: str(row.subject),
        receivedAt: row.at === null ? null : Number(row.at),
        size: row.size === null ? null : Number(row.size),
        read: Boolean(row.read),
        flagged: Boolean(row.flagged),
        outgoing: Boolean(row.outgoing),
        listId: str(row.list_id),
        recipients: JSON.parse(String(row.recipients)) as string[],
        mailboxes: JSON.parse(String(row.boxes)) as EmailFacts["mailboxes"],
        replyTo: str(row.reply_to),
        dkim: str(row.dkim),
        dmarc: str(row.dmarc),
      }))
  },
  async setSenderScores(accountId, scores, now) {
    return write(database, () => {
      const link = database.prepare(
        `INSERT INTO account_identities
           (account_id, identity_id, created_at, updated_at, mail_score, mail_signals, mail_scored_at, mail_demoted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, identity_id) DO UPDATE SET mail_score = excluded.mail_score,
             mail_signals = excluded.mail_signals, mail_scored_at = excluded.mail_scored_at,
             mail_demoted = excluded.mail_demoted`,
      )
      for (const { address, score, signals, demoted } of scores)
        link.run(
          accountId,
          identityOf(database, { address, name: null }, now),
          now,
          now,
          score,
          JSON.stringify(signals),
          now,
          demoted ? 1 : null,
        )
      return scores.length
    })
  },
  async mailboxes(accountId) {
    return database
      .prepare("SELECT * FROM mailboxes WHERE account_id = ? ORDER BY name, id")
      .all(accountId)
      .map((b) => ({
        id: Number(b.id),
        accountId: Number(b.account_id),
        externalId: String(b.external_id),
        name: String(b.name),
        kind: str(b.kind),
      }))
  },
  async setMailboxes(accountId, scanned, found, now) {
    return write(database, () => {
      const boxes = new Map(scanned.map((box) => [box.externalId, mailboxPk(database, accountId, box, now)]))
      const lookup = database.prepare("SELECT id FROM emails WHERE account_id = ? AND external_id = ?")
      const leave = database.prepare(
        `DELETE FROM email_mailboxes WHERE email_id = ? AND mailbox_id IN (SELECT value FROM json_each(?))
           AND mailbox_id NOT IN (SELECT value FROM json_each(?))`,
      )
      let count = 0
      for (const [externalId, inside] of found) {
        const row = lookup.get(accountId, externalId)
        if (!row) continue
        const kept = inside.map((id) => {
          const pk = boxes.get(id)
          if (pk === undefined) throw new Error(`Mailbox ${id} was not scanned`)
          return pk
        })
        leave.run(Number(row.id), JSON.stringify([...boxes.values()]), JSON.stringify(kept))
        for (const pk of kept) join(database, Number(row.id), pk, now)
        count++
      }
      return count
    })
  },
  async setFlags(accountId, flags, now) {
    return write(database, () => {
      return setEmailFlags(database, accountId, flags, now)
    })
  },
  folderEmails: async (accountId, folder, uidvalidity) => folderEmails(database, accountId, folder, uidvalidity),
  setLocations: async (accountId, folder, uidvalidity, found) =>
    write(database, () => setLocations(database, accountId, folder, uidvalidity, found)),
  forgetLocations: async (accountId, folder, uidvalidity, uids) =>
    write(database, () => forgetLocations(database, accountId, folder, uidvalidity, uids)),
  markDeleted: async (accountId, externalIds, now) =>
    write(database, () => markEmailsDeleted(database, accountId, externalIds, now)),
  markRestored: async (accountId, externalIds, now) =>
    write(database, () => markEmailsRestored(database, accountId, externalIds, now)),
  async chunksToEmbed(model, { after, limit }) {
    drainEmailIndex(database, stemmerFor)
    const file = database.prepare("SELECT text FROM attachments WHERE id = ?")
    const threads = new Map<number, Chunk[]>()
    return database
      .prepare(
        `SELECT p.content_hash AS hash, min(p.type || ':' || p.owner) AS owner, p.position, p.start_offset AS start,
           p.end_offset AS end
           FROM ${MAIL_PIECES}
          WHERE p.content_hash > ?
            AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = p.content_hash)
          GROUP BY p.content_hash ORDER BY p.content_hash LIMIT ?`,
      )
      .all(after ?? "", model, limit)
      .flatMap((row) => {
        const [type, id] = String(row.owner).split(":")
        const owner = Number(id)
        if (type === "email_thread") {
          if (!threads.has(owner)) threads.set(owner, threadPieces(database, owner))
          const piece = threads.get(owner)?.[Number(row.position)]
          return piece && piece.hash === row.hash ? [{ hash: piece.hash, text: piece.text }] : []
        }
        const text = str(file.get(owner)?.text)
        return text == null ? [] : [{ hash: String(row.hash), text: text.slice(Number(row.start), Number(row.end)) }]
      })
  },
  async nearest(model, query, { accountId, limit, threadExternalId, since }) {
    drainEmailIndex(database, stemmerFor)
    const page = database.prepare(
      `SELECT p.id, p.type, p.owner, p.position, p.email_id AS email, v.vector FROM ${MAIL_PIECES}
         JOIN embeddings v ON v.model = ? AND v.content_hash = p.content_hash
        WHERE p.id > ? AND p.account_id = ?
          AND (? IS NULL OR p.thread_id IN (SELECT id FROM email_threads WHERE account_id = p.account_id AND external_id = ?))
          AND (? IS NULL OR p.occurred_at >= ?)
        ORDER BY p.id LIMIT 500`,
    )
    const best = new Map<string, number>()
    for (let after = 0; ; ) {
      const rows = page.all(
        model,
        after,
        accountId,
        threadExternalId ?? null,
        threadExternalId ?? null,
        since ?? null,
        since ?? null,
      )
      for (const row of rows) {
        const score = dot(query, row.vector as Uint8Array)
        const key = row.type === "email_thread" ? `${row.owner}:${row.position}` : `email:${row.email}`
        if (score > (best.get(key) ?? Number.NEGATIVE_INFINITY)) best.set(key, score)
      }
      if (rows.length < 500) break
      after = Number(rows.at(-1)?.id)
    }
    const threads = new Map<number, Chunk[]>()
    const emails = new Map<number, number>()
    for (const [key, score] of [...best.entries()].sort(([, a], [, b]) => b - a)) {
      if (emails.size >= limit) break
      const [owner, position] = key.split(":")
      let email = Number(position)
      if (owner !== "email") {
        const thread = Number(owner)
        if (!threads.has(thread)) threads.set(thread, threadPieces(database, thread))
        const piece = threads.get(thread)?.[email]
        if (!piece) continue
        email = Number(piece.lastId)
      }
      if (!emails.has(email)) emails.set(email, score)
    }
    return [...emails.entries()].flatMap(([emailId, score]) => {
      const place = inThread(database, emailId)
      return place ? [{ ...place, score }] : []
    })
  },
  async threadHits(accountId, threadExternalId) {
    const ids = database
      .prepare(
        `SELECT e.id FROM emails e JOIN email_threads t ON t.id = e.email_thread_id
          WHERE t.account_id = ? AND t.external_id = ? AND e.deleted_at IS NULL
          ORDER BY coalesce(e.sent_at, e.received_at), e.id`,
      )
      .all(accountId, threadExternalId)
      .map(({ id }) => Number(id))
    return emailHitsByPk(database, ids)
  },
  async inThreads(accountId, externalIds) {
    const id = database.prepare("SELECT id FROM emails WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL")
    return externalIds.flatMap((externalId) => {
      const row = id.get(accountId, externalId)
      const place = row ? inThread(database, Number(row.id)) : undefined
      return place ? [place] : []
    })
  },
  async search(query, filter = {}) {
    const match = wordsQuery(query)
    if (match === null) return []
    const [limit, offset] = page(filter)
    drainEmailIndex(database, stemmerFor)
    const [where, params] = emailWhere({ ...filter, includeDeleted: false })
    return database
      .prepare(
        `SELECT e.* FROM email_words w JOIN emails e ON e.id = w.rowid
          WHERE email_words MATCH ? AND ${where}
          ORDER BY coalesce(e.sent_at, e.received_at) DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(`normalized_text : (${match})`, ...params, limit, offset)
      .map((row) => emailOf(database, row))
  },
})
