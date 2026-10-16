import { CliError } from "@wirecat/cli-base"
import type { Page } from "../domain/models.js"
import type { Meeting, MeetingDetails, MeetingFilter, SearchHit } from "../meetings/index.js"
import type { AccountAccounts } from "./accounts.js"
import type { AccountAttachments } from "./attachments.js"
import type { ChatsStore } from "./chats.js"
import type { ConversationsStore } from "./conversations.js"
import type { AccountCounters } from "./counters.js"
import type { AccountMentions } from "./mentions.js"
import type { AccountMessages, MessagesStore } from "./messages.js"
import type { AccountPeople } from "./people.js"
import type { RosterStore } from "./roster.js"
import type { AttachmentTextEntry } from "./sqlite/attachment-texts.js"
import type { Email, EmailFilter, EmailThread, Mailbox, MailFilter, ThreadDetails } from "./sqlite/emails.js"
import type { MessageStore } from "./store.js"
import type { SyncStore } from "./sync.js"
import type { TagsStore } from "./tags.js"
import type { AccountKey, AccountMessageFilter, StoredHit } from "./types.js"
import type { AccountVectors } from "./vectors.js"

/** A part of an area whose every method takes the account first: what `forAccount` binds. */
export type Keyed<K> = { [N in keyof K]: (key: AccountKey, ...rest: never[]) => unknown }

/** An area as the store builds it: the part that takes the account, and the whole area callers see. */
export interface Area<K, A extends K = K> {
  keyed: K
  whole: A
}

type Bound<F> = F extends (key: AccountKey, ...rest: infer R) => infer T ? (...rest: R) => T : never
export type BoundArea<K> = { [N in keyof K]: Bound<K[N]> }

/** The areas whose account-taking part `forAccount` binds. */
export interface AccountAreas {
  accounts: () => Area<AccountAccounts>
  chats: () => Area<ChatsStore>
  sync: () => Area<SyncStore>
  messages: () => Area<AccountMessages, MessagesStore>
  attachments: () => Area<AccountAttachments>
  roster: () => Area<RosterStore>
  people: () => Area<AccountPeople>
  conversations: () => Area<ConversationsStore>
  vectors: () => Area<AccountVectors>
  counters: () => Area<AccountCounters>
  tags: () => Area<TagsStore>
  mentions: () => Area<AccountMentions>
}

// Looked up on each call, so a spy set on the store's area after `forAccount` still sees the call.
const bindArea = <K>({ keyed, whole }: Area<K>, account: AccountKey): BoundArea<K> => {
  const methods = whole as Record<string, (...args: unknown[]) => unknown>
  return Object.fromEntries(
    Object.keys(keyed as object).map((name) => [
      name,
      (...rest: unknown[]) => (methods[name] as (...args: unknown[]) => unknown)(account, ...rest),
    ]),
  ) as BoundArea<K>
}

/** One account's mail: the thread and email ids of another account read as nothing. */
export interface AccountMail {
  threads(filter?: Omit<MailFilter, "accountId">): Promise<EmailThread[]>
  thread(id: number): Promise<ThreadDetails | null>
  email(externalId: string): Promise<Email | null>
  emails(filter?: Omit<EmailFilter, "accountId">): Promise<Email[]>
  mailboxes(): Promise<Mailbox[]>
}

/** One account's meetings: a meeting id of another account reads as nothing. */
export interface AccountMeetings {
  meetings(filter?: Omit<MeetingFilter, "accountId">): Promise<Meeting[]>
  meeting(id: number): Promise<MeetingDetails | null>
  search(query: string, filter?: Omit<MeetingFilter, "accountId">): Promise<SearchHit[]>
}

/**
 * The store with one account bound: every read and write takes the account from here, and a row id
 * of another account is not found. A read across accounts goes to the whole store, by name.
 */
export interface AccountStore {
  readonly account: AccountKey
  readonly accounts: BoundArea<AccountAccounts>
  readonly chats: BoundArea<ChatsStore>
  readonly sync: BoundArea<SyncStore>
  readonly messages: BoundArea<AccountMessages> & {
    find(filter: AccountMessageFilter): Promise<Page<StoredHit>>
    search(query: string, options: { limit: number }): Promise<Page<StoredHit>>
  }
  readonly attachments: BoundArea<AccountAttachments> & {
    localPathOf(attachmentPk: number): Promise<string | null>
    keepAttachmentText(attachmentPk: number, entry: AttachmentTextEntry): Promise<boolean>
  }
  readonly roster: BoundArea<RosterStore>
  readonly people: BoundArea<AccountPeople>
  readonly conversations: BoundArea<ConversationsStore>
  readonly vectors: BoundArea<AccountVectors>
  readonly counters: BoundArea<AccountCounters>
  readonly tags: BoundArea<TagsStore>
  readonly mentions: BoundArea<AccountMentions>
  readonly mail: AccountMail
  readonly meetings: AccountMeetings
}

/** What only the store's own tables can answer: whose an attachment row is. */
export interface AccountOwners {
  /** The account's row id; `undefined` until the account is stored. */
  accountPk(): number | undefined
  /** The account row that holds an attachment's message, email or meeting. */
  attachmentAccount(attachmentPk: number): number | undefined
}

const once = <T>(build: () => T): (() => T) => {
  let built: T | undefined
  return () => {
    built ??= build()
    return built
  }
}

export const bindAccount = (
  store: MessageStore,
  account: AccountKey,
  areas: AccountAreas,
  owners: AccountOwners,
): AccountStore => {
  const bound = <K>(area: () => Area<K>) => once(() => bindArea(area(), account))
  const ownAttachment = (attachmentPk: number) => {
    const pk = owners.accountPk()
    if (pk === undefined || owners.attachmentAccount(attachmentPk) !== pk)
      throw new CliError("not_found", `no attachment ${attachmentPk} in this account`)
  }
  const accountId = () => owners.accountPk()
  const mail: AccountMail = {
    threads: async (filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.mail.threads({ ...filter, accountId: id })
    },
    thread: async (id) => {
      const found = await store.mail.thread(id)
      return found && found.thread.accountId === accountId() ? found : null
    },
    email: async (externalId) => {
      const id = accountId()
      return id === undefined ? null : store.mail.email(id, externalId)
    },
    emails: async (filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.mail.emails({ ...filter, accountId: id })
    },
    mailboxes: async () => {
      const id = accountId()
      return id === undefined ? [] : store.mail.mailboxes(id)
    },
  }
  const meetings: AccountMeetings = {
    meetings: async (filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.meetings.meetings({ ...filter, accountId: id })
    },
    meeting: async (id) => {
      const found = await store.meetings.meeting(id)
      return found && found.meeting.accountId === accountId() ? found : null
    },
    search: async (query, filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.meetings.search(query, { ...filter, accountId: id })
    },
  }
  const accounts = bound(areas.accounts)
  const chats = bound(areas.chats)
  const sync = bound(areas.sync)
  const messages = once(() => ({
    ...bindArea(areas.messages(), account),
    find: (filter: AccountMessageFilter) => store.messages.find({ ...filter, account }),
    search: (query: string, options: { limit: number }) => store.messages.search(query, { ...options, account }),
  }))
  const attachments = once(() => ({
    ...bindArea(areas.attachments(), account),
    localPathOf: async (attachmentPk: number) => {
      ownAttachment(attachmentPk)
      return store.attachments.localPathOf(attachmentPk)
    },
    keepAttachmentText: async (attachmentPk: number, entry: AttachmentTextEntry) => {
      ownAttachment(attachmentPk)
      return store.attachments.keepAttachmentText(attachmentPk, entry)
    },
  }))
  const roster = bound(areas.roster)
  const people = bound(areas.people)
  const conversations = bound(areas.conversations)
  const vectors = bound(areas.vectors)
  const counters = bound(areas.counters)
  const tags = bound(areas.tags)
  const mentions = bound(areas.mentions)
  return {
    account,
    get accounts() {
      return accounts()
    },
    get chats() {
      return chats()
    },
    get sync() {
      return sync()
    },
    get messages() {
      return messages()
    },
    get attachments() {
      return attachments()
    },
    get roster() {
      return roster()
    },
    get people() {
      return people()
    },
    get conversations() {
      return conversations()
    },
    get vectors() {
      return vectors()
    },
    get counters() {
      return counters()
    },
    get tags() {
      return tags()
    },
    get mentions() {
      return mentions()
    },
    mail,
    meetings,
  }
}
