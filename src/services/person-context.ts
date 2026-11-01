import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../domain/locator.js"
import type { ChatKind, Id, Message, Provider } from "../domain/models.js"
import type { Event, EventFilter } from "../meetings/index.js"
import { pickPerson } from "../resolve.js"
import type { AccountKey, IdentityRef, LinkedIdentity, MessageStore, PersonRecord } from "../store/store.js"
import { messageOfEmail } from "../store/store.js"

export const CONTEXT_MESSAGES = 10
export const CONTEXT_BYTES = 64 * 1024

export interface ContextMessage {
  locator: string
  provider: Provider
  account: Id
  chatId: Id
  chatTitle: string | null
  id: Id
  timestamp: string
  senderId: Id | null
  senderName: string | null
  outgoing: boolean | null
  text: string
}

export interface SharedChat {
  provider: Provider
  account: Id
  chatId: Id
  title: string | null
  kind: ChatKind
  lastMessageAt: string | null
}

/** A calendar event the person is invited to, through any contact linked to them. */
export interface ContextEvent {
  /** `event:<id>`: of a series, the one occurrence listed. */
  ref: string
  title: string | null
  startsAt: string | null
  endsAt: string | null
  allDay: boolean
  location: string | null
  /** confirmed or tentative; a cancelled event is not listed. */
  status: string | null
}

/** `not_fetched`: nothing of its history was ever read into the store; `partial`: only some of it was. */
export type NotReadReason = "not_fetched" | "partial"

export interface PersonContext {
  person: PersonRecord & { provider: Provider; id: Id }
  shared: SharedChat[]
  /** Each way, the newest in a messenger dialog whatever `limits` says; mail only within them. */
  last: { fromThem: ContextMessage | null; fromMe: ContextMessage | null; fromThemAnywhere: ContextMessage | null }
  recent: { direct: ContextMessage[]; groups: ContextMessage[] }
  mentions: ContextMessage[]
  /** Calendar events they are invited to, one occurrence per series: the next ones, then the latest past ones. */
  events: { upcoming: ContextEvent[]; recent: ContextEvent[] }
  limits: { messages: number; bytes: number }
  /** A list was cut by `limits`. */
  hasMore: boolean
  /** Every shared chat is held whole in the store; otherwise `notRead` says which is not, and why. */
  complete: boolean
  notRead: (Omit<SharedChat, "kind" | "lastMessageAt"> & { reason: NotReadReason })[]
}

export interface ContextOptions {
  messages?: number
  bytes?: number
  /** ms: nothing older. */
  since?: number
  /** ms: what splits upcoming events from past ones; the clock when absent. */
  now?: number
}

export const toContext = (key: AccountKey, message: Message, chatTitle: string | null): ContextMessage => ({
  locator: formatLocator({ ...key, chat: message.chatId, message: message.id }),
  provider: key.provider,
  account: key.account,
  chatId: message.chatId,
  chatTitle,
  id: message.id,
  timestamp: message.timestamp,
  senderId: message.senderId,
  senderName: message.senderName,
  outgoing: message.outgoing,
  text: message.text,
})

/** Their mail in the mail tables, newest first: what they sent, and what was sent to them. */
const mailWith = async (
  store: MessageStore,
  key: AccountKey,
  address: Id,
  limit: number,
  since: number | undefined,
): Promise<{ items: ContextMessage[]; hasMore: boolean }> => {
  const account = await store.accounts.storedAccount(key).catch(() => undefined)
  if (!account) return { items: [], hasMore: false }
  const emails = await store.mail.emails({
    accountId: account.id,
    participant: address,
    limit: limit + 1,
    ...(since === undefined ? {} : { since }),
  })
  const threads = new Map<number, { externalId: string; subject: string | null }>()
  const items: ContextMessage[] = []
  for (const email of emails.slice(0, limit)) {
    let thread = threads.get(email.emailThreadId)
    if (!thread) {
      const details = await store.mail.thread(email.emailThreadId)
      if (!details) continue
      thread = details.thread
      threads.set(email.emailThreadId, thread)
    }
    items.push(toContext(key, messageOfEmail(email, thread.externalId), thread.subject))
  }
  return { items, hasMore: emails.length > limit }
}

const newestFirst = (a: ContextMessage, b: ContextMessage) => Date.parse(b.timestamp) - Date.parse(a.timestamp)

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())

const contextEvent = (event: Event): ContextEvent => ({
  ref: `event:${event.id}`,
  title: event.title,
  startsAt: iso(event.startsAt),
  endsAt: iso(event.endsAt),
  allDay: event.allDay === true,
  location: event.location,
  status: event.status ?? null,
})

const EVENT_PAGE = 100
/** A weekly meeting held for years is hundreds of occurrences; past this many rows the list stops, cut. */
const EVENT_ROWS = 1000

/** Up to `limit` events of `filter`, in its order, the first occurrence of each series only and none cancelled. */
const eventsOnce = async (
  store: MessageStore,
  filter: EventFilter,
  limit: number,
): Promise<{ items: Event[]; cut: boolean }> => {
  const items: Event[] = []
  const series = new Set<number>()
  for (let offset = 0; offset < EVENT_ROWS; offset += EVENT_PAGE) {
    const page = await store.calendar.events({ ...filter, limit: EVENT_PAGE, offset })
    for (const event of page) {
      if (event.status === "cancelled") continue
      if (event.eventSeriesId !== null) {
        if (series.has(event.eventSeriesId)) continue
        series.add(event.eventSeriesId)
      }
      if (items.length === limit) return { items, cut: true }
      items.push(event)
    }
    if (page.length < EVENT_PAGE) return { items, cut: false }
  }
  return { items, cut: true }
}

/**
 * The accounts each identity is read in: for the messenger asked, only the account asked about — a
 * second account of the same messenger is somebody else's view; for a linked messenger, every account
 * of this store that saw that identity.
 */
export const readsOf = (record: PersonRecord, asked: AccountKey): { key: AccountKey; identity: LinkedIdentity }[] =>
  record.identities.flatMap((identity) =>
    (identity.provider === asked.provider ? [asked.account] : identity.accounts)
      .filter((account) => identity.accounts.includes(account))
      .map((account) => ({ key: { provider: identity.provider, account }, identity })),
  )

/**
 * What the store knows about one person, across every identity linked to them. Reads the store
 * only: nothing is fetched, nothing marked read. Identity is by id, never by name.
 */
export const personContext = async (
  store: MessageStore,
  asked: AccountKey,
  reference: string,
  options: ContextOptions = {},
): Promise<PersonContext> => {
  const found = pickPerson(reference, await store.people.people(asked.provider, { account: asked.account }))
  const record = await store.people.personOf({ provider: asked.provider, id: found.id })
  if (!record) throw new CliError("not_found", `no person ${found.id} in the store`)
  return {
    person: { ...record, provider: asked.provider, id: found.id },
    ...(await recordContext(store, record, readsOf(record, asked), options)),
  }
}

/** `personContext` of a person already found, read in the identities and accounts `reads` names. */
export const recordContext = async (
  store: MessageStore,
  record: PersonRecord,
  reads: { key: AccountKey; identity: LinkedIdentity }[],
  { messages = CONTEXT_MESSAGES, bytes = CONTEXT_BYTES, since, now = Date.now() }: ContextOptions = {},
): Promise<Omit<PersonContext, "person">> => {
  const recent = (message: ContextMessage) => since === undefined || Date.parse(message.timestamp) >= since

  const shared: SharedChat[] = []
  const notRead: PersonContext["notRead"] = []
  const direct: ContextMessage[] = []
  /** The newest message each way in a dialog longer than the page, for `last`. */
  const beyond: ContextMessage[] = []
  const theirs: ContextMessage[] = []
  const mentions: ContextMessage[] = []
  let cut = false
  for (const { key, identity } of reads) {
    const chats = await store.chats.chatsWith(key, identity.id)
    for (const chat of chats) {
      shared.push({ ...key, chatId: chat.id, title: chat.title, kind: chat.kind, lastMessageAt: chat.lastMessageAt })
    }
    for (const held of await store.chats.chatCompleteness(
      key,
      chats.map((chat) => chat.id),
    )) {
      if (held.state === "complete") continue
      const chat = chats.find((one) => one.id === held.chatId)
      notRead.push({
        ...key,
        chatId: held.chatId,
        title: chat?.title ?? null,
        reason: held.state === "unknown" ? "not_fetched" : "partial",
      })
    }
    const dialog = chats.find((chat) => chat.kind === "dialog")
    if (dialog) {
      const page = await store.messages.messages(key, dialog.id, {
        limit: messages,
        ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
      })
      direct.push(...page.items.map((message) => toContext(key, message, dialog.title)))
      cut ||= page.hasMore
      if (page.hasMore)
        for (const outgoing of [true, false]) {
          const [newest] = (
            await store.messages.messages(key, dialog.id, {
              limit: 1,
              outgoing,
              ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
            })
          ).items
          if (newest) beyond.push(toContext(key, newest, dialog.title))
        }
    }
    if (key.provider === "email") {
      const mail = await mailWith(store, key, identity.id, messages, since)
      direct.push(...mail.items)
      theirs.push(...mail.items.filter((message) => message.senderId === identity.id))
      cut ||= mail.hasMore
    }
    const written = await store.messages.find({ account: key, senders: [identity.id], limit: messages })
    theirs.push(...written.items.map((hit) => toContext(key, hit, hit.chatTitle ?? null)).filter(recent))
    cut ||= written.hasMore
    const named = await store.messages.mentioning(key, { id: identity.id, username: identity.username }, messages)
    mentions.push(
      ...named.items
        .filter((hit) => hit.senderId !== identity.id)
        .map((hit) => toContext(key, hit, hit.chatTitle ?? null))
        .filter(recent),
    )
    cut ||= named.hasMore
  }

  const personId = Number(record.uid)
  const upcoming = await eventsOnce(store, { personId, from: now }, messages)
  const upcomingIds = new Set(upcoming.items.map(({ id }) => id))
  const past = await eventsOnce(
    store,
    { personId, to: now, newest: true, ...(since === undefined ? {} : { from: since }) },
    messages,
  )
  cut ||= upcoming.cut || past.cut

  direct.sort(newestFirst)
  const each = [...direct, ...beyond].sort(newestFirst)
  theirs.sort(newestFirst)
  mentions.sort(newestFirst)
  const inDialog = new Set(
    shared.filter((chat) => chat.kind === "dialog").map((chat) => `${chat.account}/${chat.chatId}`),
  )
  const inDirect = new Set(direct.map(({ locator }) => locator))
  const groups = theirs.filter(
    (message) => !inDialog.has(`${message.account}/${message.chatId}`) && !inDirect.has(message.locator),
  )
  const lists = {
    direct: direct.slice(0, messages),
    groups: groups.slice(0, messages),
    mentions: mentions.slice(0, messages),
  }
  cut ||= direct.length > messages || groups.length > messages || mentions.length > messages
  const kept = withinBytes(lists, bytes)

  return {
    shared: shared.sort((a, b) => Date.parse(b.lastMessageAt ?? "") - Date.parse(a.lastMessageAt ?? "")),
    last: {
      fromThem: each.find((message) => !message.outgoing) ?? null,
      fromMe: each.find((message) => message.outgoing === true) ?? null,
      fromThemAnywhere: theirs[0] ?? null,
    },
    recent: { direct: kept.direct, groups: kept.groups },
    mentions: kept.mentions,
    events: {
      upcoming: upcoming.items.map(contextEvent),
      recent: past.items.filter(({ id }) => !upcomingIds.has(id)).map(contextEvent),
    },
    limits: { messages, bytes },
    hasMore: cut || kept.cut,
    complete: notRead.length === 0,
    notRead,
  }
}

/** Keeps the lists under `bytes` of JSON in all, the direct chat first, then groups, then mentions. */
const withinBytes = (lists: Record<"direct" | "groups" | "mentions", ContextMessage[]>, bytes: number) => {
  let used = 0
  let cut = false
  const keep = (items: ContextMessage[]) =>
    items.filter((item) => {
      const size = Buffer.byteLength(JSON.stringify(item), "utf8")
      if (cut || used + size > bytes) {
        cut = true
        return false
      }
      used += size
      return true
    })
  return { direct: keep(lists.direct), groups: keep(lists.groups), mentions: keep(lists.mentions), cut }
}

/** `max:Ana` names a person in another messenger of this store; a reference with no prefix, this one. */
export const identityIn = async (store: MessageStore, asked: AccountKey, reference: string): Promise<IdentityRef> => {
  const prefixed = /^([a-z][a-z0-9-]*):(.+)$/.exec(reference.trim())
  if (prefixed?.[1] === "person") return identityOfPerson(store, asked, prefixed[2] as string)
  const provider = prefixed?.[1] ?? asked.provider
  const typed = prefixed?.[2] ?? reference
  const people = await store.people.people(provider, provider === asked.provider ? { account: asked.account } : {})
  return { provider, id: pickPerson(typed, people).id }
}

/**
 * A `person:` reference, as search results give it, read as that person's identity in the asked messenger: the one
 * the asked account has seen when they have several there. None, or several the account has seen, is said, not guessed.
 */
const identityOfPerson = async (store: MessageStore, asked: AccountKey, uid: string): Promise<IdentityRef> => {
  const person = await store.people.personByUid(uid)
  if (!person) throw new CliError("not_found", `no person:${uid} in the store`)
  const here = person.identities.filter(({ provider }) => provider === asked.provider)
  const seen = here.length > 1 ? here.filter(({ accounts }) => accounts.includes(asked.account)) : here
  const [only] = seen
  if (seen.length === 1 && only) return { provider: only.provider, id: only.id }
  const all = person.identities.map(({ provider, id }) => `${provider}:${id}`).join(", ")
  throw new CliError(
    seen.length === 0 ? "not_found" : "validation_error",
    seen.length === 0
      ? `person:${uid} has no ${asked.provider} identity — they are ${all || "nobody linked"}`
      : `person:${uid} has ${seen.length} ${asked.provider} identities — name one: ${seen.map(({ id }) => `${asked.provider}:${id}`).join(", ")}`,
  )
}

export const CHAT_MESSAGES = 20

/** `0` what an agent summarises — when and what; `1` adds ids, the locator and who and what it answers; `2` all of it. */
export type Detail = 0 | 1 | 2

export type LeanMessage = { at: string; text: string; transcript?: string } & Record<string, unknown>

export interface PersonChatMessages {
  chat: { id: Id; title: string | null; kind: ChatKind }
  /** Their newest `limit` in this chat, oldest first. */
  messages: LeanMessage[]
  /** The store holds the whole chat, so no older message of theirs is missing. */
  complete: boolean
  /** They wrote more here than `limit`. */
  more: boolean
}

export interface PersonMessages {
  person: { uid: string; provider: Provider; id: Id; name: string | null }
  chats: PersonChatMessages[]
  limits: { messages: number }
}

const heardText = (message: Message): string | undefined =>
  "transcript" in message && typeof message.transcript === "string" ? message.transcript : undefined

const lean = (key: AccountKey, message: Message, detail: Detail): LeanMessage => {
  const transcript = heardText(message)
  const short = { at: message.timestamp, text: message.text, ...(transcript ? { transcript } : {}) }
  const locator = formatLocator({ ...key, chat: message.chatId, message: message.id })
  if (detail === 0) return short
  if (detail === 2) return { ...message, ...short, locator }
  return {
    ...short,
    id: message.id,
    locator,
    senderId: message.senderId,
    replyTo: message.replyTo?.id ?? message.replyToId ?? null,
  }
}

/** On Telegram a one-to-one chat has the person's own id, and the store may not know that chat yet. */
const kindOf = (chat: { kind: ChatKind } | undefined, chatId: Id, person: Id): ChatKind =>
  chat && chat.kind !== "unknown" ? chat.kind : chatId === person ? "dialog" : (chat?.kind ?? "unknown")

/**
 * One person's newest messages in each chat named, from the store, oldest first in each — what an
 * agent reads to summarise them. Short by default: metadata only at a higher `detail`.
 */
export const personMessages = async (
  store: MessageStore,
  asked: AccountKey,
  reference: string,
  { chats, limit = CHAT_MESSAGES, detail = 0 }: { chats: Id[]; limit?: number; detail?: Detail },
): Promise<PersonMessages> => {
  const found = pickPerson(reference, await store.people.people(asked.provider, { account: asked.account }))
  const record = await store.people.personOf({ provider: asked.provider, id: found.id })
  if (!record) throw new CliError("not_found", `no person ${found.id} in the store`)
  const stored = (await store.chats.chats(asked, {})).items
  const held = new Map((await store.chats.chatCompleteness(asked, chats)).map((one) => [one.chatId, one.state]))
  const answer: PersonChatMessages[] = []
  for (const chatId of chats) {
    const chat = stored.find((one) => one.id === chatId)
    const page = await store.messages.find({ account: asked, senders: [found.id], chatId, limit })
    answer.push({
      chat: { id: chatId, title: chat?.title ?? null, kind: kindOf(chat, chatId, found.id) },
      messages: page.items
        .toSorted((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        .map((message) => lean(asked, message, detail)),
      complete: held.get(chatId) === "complete",
      more: page.hasMore,
    })
  }
  return {
    person: { uid: record.uid, provider: asked.provider, id: found.id, name: found.name ?? record.name },
    chats: answer,
    limits: { messages: limit },
  }
}
