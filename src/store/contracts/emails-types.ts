import type { Attachment, Metadata } from "../../meetings/index.js"
import type { AttachmentInput } from "../sqlite/meetings.js"
import type { StoredHit } from "../store.js"

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
  /** Added to the mailboxes the email is already in; one scan sees one folder, so none is taken away. */
  mailboxes?: MailboxInput[]
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
  /** Exclusive. */
  until?: number
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
  /** Marks emails gone at the source and drops their text; saving one again brings it back. Answers how many changed. */
  markDeleted(accountId: number, externalIds: string[], now: number): Promise<number>
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
}
