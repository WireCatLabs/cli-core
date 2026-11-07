import { formatLocator } from "../domain/locator.js"
import { kindIn } from "../domain/providers.js"
import type { AccountKey, LinkedIdentity, MessageStore, PersonRecord, StoredAccount } from "../store/store.js"
import type { Coverage } from "./business-context.js"
import { eventsOnce } from "./person-context.js"

/** Mail read per address when counting: past it the count says `hasMore`. */
const MAIL_ROWS = 500
const EVENT_ROWS = 1000

/** A one-to-one chat, a mail or a calendar event with some of the people asked about. */
export interface Touch {
  kind: "message" | "mail" | "meeting"
  /** A message's or mail's locator, an `event:<id>`. */
  ref: string
  /** The chat's title, the mail's subject, the event's title. */
  title: string | null
  at: string | null
  /** `person:<uid>` of each one asked about it involves. */
  people: string[]
}

export interface Communications {
  /** Each message, mail and event once, however many of the people it involves. */
  counts: { messages: number; mail: number; meetings: number }
  /** Newest first, the first `limit`; empty when only counts were asked for. */
  items: Touch[]
  hasMore: boolean
  coverage: Coverage
}

export interface CommunicationsOptions {
  /** The accounts read; left out, every account in the store. */
  accounts?: AccountKey[]
  /** ms, inclusive. */
  since?: number
  /** ms, inclusive. */
  until?: number
  /** How many touches to list; 0 counts only. */
  limit?: number
}

const keyOf = ({ provider, account }: AccountKey) => `${provider}:${account}`

/**
 * What the owner's accounts in scope hold with these people: their one-to-one chats, mail with their address and
 * calendar events they are invited to. A group chat is left out: what another member wrote there is not theirs.
 */
export const communicationsOf = async (
  store: MessageStore,
  people: PersonRecord[],
  { accounts, since, until, limit = 0 }: CommunicationsOptions = {},
): Promise<Communications> => {
  const stored = await store.accounts.storedAccounts()
  const inScope = (key: AccountKey) => accounts === undefined || accounts.some((one) => keyOf(one) === keyOf(key))
  const read = new Set<string>()
  const left = new Set<string>()
  const dialogs = new Set<string>()
  const threads = new Map<number, string | null>()
  const messages = new Map<string, Touch>()
  const mail = new Map<number, Touch>()
  const meetings = new Map<number, Touch>()
  let messageCount = 0
  let cut = false
  const sinceIso = since === undefined ? undefined : new Date(since).toISOString()
  const untilIso = until === undefined ? undefined : new Date(until).toISOString()
  const touch = <K>(into: Map<K, Touch>, id: K, made: Omit<Touch, "people">, uid: string) => {
    const held = into.get(id) ?? { ...made, people: [] }
    if (!held.people.includes(`person:${uid}`)) held.people.push(`person:${uid}`)
    into.set(id, held)
  }

  const ids = new Map(stored.map((one) => [keyOf(one), one.id]))
  for (const person of people) {
    const found = readsIn(stored, person, accounts)
    for (const key of found.left) left.add(key)
    for (const { key, identity } of found.reads) {
      read.add(keyOf(key))
      if (key.provider === "email") {
        const emails = await store.mail.emails({
          accountId: ids.get(keyOf(key)) as number,
          participant: identity.id,
          limit: MAIL_ROWS + 1,
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until: until + 1 }),
        })
        cut ||= emails.length > MAIL_ROWS
        for (const email of emails.slice(0, MAIL_ROWS)) {
          if (mail.has(email.id)) {
            touch(mail, email.id, mail.get(email.id) as Touch, person.uid)
            continue
          }
          if (!threads.has(email.emailThreadId))
            threads.set(email.emailThreadId, (await store.mail.thread(email.emailThreadId))?.thread.externalId ?? null)
          const thread = threads.get(email.emailThreadId)
          const at = email.receivedAt ?? email.sentAt
          touch(
            mail,
            email.id,
            {
              kind: "mail",
              ref: formatLocator({ ...key, chat: thread ?? String(email.emailThreadId), message: email.externalId }),
              title: email.subject,
              at: at === null ? null : new Date(at).toISOString(),
            },
            person.uid,
          )
        }
        continue
      }
      for (const chat of await store.chats.chatsWith(key, identity.id)) {
        if (chat.kind !== "dialog") continue
        const id = `${keyOf(key)}/${chat.id}`
        if (dialogs.has(id)) continue
        dialogs.add(id)
        messageCount += await store.messages.countMessages(key, chat.id, {
          ...(sinceIso === undefined ? {} : { since: sinceIso }),
          ...(untilIso === undefined ? {} : { until: untilIso }),
        })
        if (limit > 0) {
          const page = await store.messages.messages(key, chat.id, {
            limit,
            ...(sinceIso === undefined ? {} : { since: sinceIso }),
            ...(until === undefined ? {} : { until }),
          })
          for (const message of page.items)
            touch(
              messages,
              `${id}/${message.id}`,
              {
                kind: "message",
                ref: formatLocator({ ...key, chat: chat.id, message: message.id }),
                title: chat.title,
                at: message.timestamp,
              },
              person.uid,
            )
        }
      }
    }
  }

  const calendars = (await calendarsOf(store, stored)).filter(inScope)
  const calendarIds = calendars.map(({ id }) => id)
  for (const person of people) {
    if (calendars.length === 0) break
    const found = await eventsOnce(
      store,
      {
        personId: Number(person.uid),
        ...(accounts === undefined ? {} : { accountIds: calendarIds }),
        ...(since === undefined ? {} : { from: since }),
        ...(until === undefined ? {} : { to: until }),
        newest: true,
      },
      EVENT_ROWS,
    )
    cut ||= found.cut
    for (const event of found.items)
      touch(
        meetings,
        event.id,
        {
          kind: "meeting",
          ref: `event:${event.id}`,
          title: event.title,
          at: event.startsAt === null ? null : new Date(event.startsAt).toISOString(),
        },
        person.uid,
      )
  }
  for (const key of calendars) read.add(keyOf(key))

  const items = [...messages.values(), ...mail.values(), ...meetings.values()].sort(
    (a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""),
  )
  return {
    counts: { messages: messageCount, mail: mail.size, meetings: meetings.size },
    items: limit > 0 ? items.slice(0, limit) : [],
    hasMore: cut || (limit > 0 && items.length > limit),
    coverage: coverageOf(people, read, left, calendars.length > 0),
  }
}

/** The stored accounts that hold a calendar: what a person's events are read from. */
export const calendarsOf = async (store: MessageStore, stored: StoredAccount[]): Promise<StoredAccount[]> => {
  const held: StoredAccount[] = []
  for (const account of stored) if ((await store.calendar.calendars(account.id)).length > 0) held.push(account)
  return held
}

/** The accounts read, and each source that could not be: left out of the scope, or with nothing to read it by. */
export const coverageOf = (
  people: PersonRecord[],
  read: Iterable<string>,
  left: Iterable<string>,
  calendars: boolean,
): Coverage => {
  const outside = new Set(left)
  for (const key of read) outside.delete(key)
  const notRead: Coverage["notRead"] = [...outside].sort().map((source) => ({
    source,
    reason: "outside the accounts asked for",
  }))
  if (!people.some((person) => person.identities.some((one) => kindIn(one.provider) === "messages")))
    notRead.push({ source: "messages", reason: "no messenger identity is linked to them" })
  if (!people.some((person) => person.identities.some((one) => one.provider === "email")))
    notRead.push({ source: "mail", reason: "no mail address is linked to them" })
  if (!calendars) notRead.push({ source: "events", reason: "no calendar account in the accounts read" })
  return { accounts: [...new Set(read)].sort(), notRead }
}

/** Each identity in each stored account of its provider that saw it, inside `accounts` when given. */
export const readsIn = (
  stored: AccountKey[],
  record: PersonRecord,
  accounts: AccountKey[] | undefined,
): { reads: { key: AccountKey; identity: LinkedIdentity }[]; left: string[] } => {
  const reads: { key: AccountKey; identity: LinkedIdentity }[] = []
  const left: string[] = []
  for (const identity of record.identities)
    for (const one of stored)
      if (one.provider === identity.provider && identity.accounts.includes(one.account)) {
        const key = { provider: one.provider, account: one.account }
        if (accounts === undefined || accounts.some((asked) => keyOf(asked) === keyOf(key)))
          reads.push({ key, identity })
        else left.push(keyOf(key))
      }
  return { reads, left }
}
