import { formatLocator } from "../domain/locator.js"
import { kindIn } from "../domain/providers.js"
import type { AccountKey, LinkedIdentity, MessageStore, PersonRecord, StoredAccount } from "../store/store.js"
import { type Coverage, keyOf, newestFirst, type Scope } from "./business-context.js"
import { eventsOnce } from "./person-context.js"
import { personMeetings } from "./person-meetings.js"

/** Mail read per address when counting: past it the count says `hasMore`. */
const MAIL_ROWS = 500
const EVENT_ROWS = 1000
/** Recorded meetings and calls listed: past it the count still counts each, and the read says `hasMore`. */
const RECORDED_ROWS = 100

/** A one-to-one chat, a mail, a calendar event or a recorded meeting or call with some of the people asked about. */
export interface Touch {
  kind: "message" | "mail" | "meeting"
  /** A message's or mail's locator, an `event:<id>`, or a recorded meeting's `meeting:<account>/<id>`. */
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
  /** Newest first: every mail and meeting counted, and each chat's newest `limit` messages. */
  items: Touch[]
  /** A read stopped at its cap: there may be more than `counts` says. */
  hasMore: boolean
  /** The accounts read, and the sources the people have nothing to read by; the scope's own gaps come after. */
  coverage: Coverage
}

export interface CommunicationsOptions {
  /** ms, inclusive. */
  since?: number
  /** ms, inclusive. */
  until?: number
  /** Messages listed per chat; 0 counts only. */
  limit?: number
}

/** The stored accounts that hold a calendar: what a person's events are read from. */
export const calendarsOf = async (store: MessageStore, stored: StoredAccount[]): Promise<StoredAccount[]> => {
  const held: StoredAccount[] = []
  for (const account of stored) if ((await store.calendar.calendars(account.id)).length > 0) held.push(account)
  return held
}

/** The accounts read, and each source the people have nothing to read by. */
export const coverageOf = (people: PersonRecord[], read: Iterable<string>, calendars: boolean): Coverage => {
  const notRead: Coverage["notRead"] = []
  if (!people.some((person) => person.identities.some((one) => kindIn(one.provider) === "messages")))
    notRead.push({ source: "messages", reason: "no messenger identity is linked to them" })
  if (!people.some((person) => person.identities.some((one) => one.provider === "email")))
    notRead.push({ source: "mail", reason: "no mail address is linked to them" })
  if (!calendars) notRead.push({ source: "events", reason: "no calendar account in the accounts read" })
  return { accounts: [...new Set(read)].sort(), notRead }
}

/** Each identity in each stored account of its provider that saw it, inside the scope. */
export const readsIn = (
  stored: AccountKey[],
  record: PersonRecord,
  scope: Scope,
): { key: AccountKey; identity: LinkedIdentity }[] =>
  record.identities.flatMap((identity) =>
    stored
      .filter((one) => one.provider === identity.provider && identity.accounts.includes(one.account))
      .map((one) => ({ key: { provider: one.provider, account: one.account }, identity }))
      .filter(({ key }) => scope.has(key)),
  )

/**
 * What the owner's accounts in scope hold with these people: their one-to-one chats, mail with their address and
 * calendar events they are invited to. A group chat is left out: what another member wrote there is not theirs. The
 * owner is never one of the people read: through him every chat and mail of his would count.
 */
export const communicationsOf = async (
  store: MessageStore,
  asked: PersonRecord[],
  scope: Scope,
  { since, until, limit = 0 }: CommunicationsOptions = {},
): Promise<Communications> => {
  const owner = (await store.people.owner())?.uid
  const people = asked.filter((person) => person.uid !== owner)
  const stored = await store.accounts.storedAccounts()
  const ids = new Map(stored.map((one) => [keyOf(one), one.id]))
  const read = new Set<string>()
  const dialogs = new Set<string>()
  const threads = new Map<number, string | null>()
  const messages = new Map<string, Touch>()
  const mail = new Map<number, Touch>()
  const meetings = new Map<number, Touch>()
  const recordedTouches: Touch[] = []
  let messageCount = 0
  let cut = false
  const sinceIso = since === undefined ? undefined : new Date(since).toISOString()
  const untilIso = until === undefined ? undefined : new Date(until).toISOString()
  const touch = <K>(into: Map<K, Touch>, id: K, made: Omit<Touch, "people">, uid: string) => {
    const held = into.get(id) ?? { ...made, people: [] }
    if (!held.people.includes(`person:${uid}`)) held.people.push(`person:${uid}`)
    into.set(id, held)
  }

  for (const person of people)
    for (const { key, identity } of readsIn(stored, person, scope)) {
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
          const held = mail.get(email.id)
          if (held) {
            touch(mail, email.id, held, person.uid)
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
        const id = `${keyOf(key)}/${chat.id}`
        if (chat.kind !== "dialog" || dialogs.has(id)) continue
        dialogs.add(id)
        messageCount += await store.messages.countMessages(key, chat.id, {
          ...(sinceIso === undefined ? {} : { since: sinceIso }),
          ...(untilIso === undefined ? {} : { until: untilIso }),
        })
        if (limit === 0) continue
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

  const calendars = (await calendarsOf(store, stored)).filter((one) => scope.has(one))
  for (const person of calendars.length === 0 ? [] : people) {
    const found = await eventsOnce(
      store,
      {
        personId: Number(person.uid),
        ...(scope.accounts === undefined ? {} : { accountIds: calendars.map(({ id }) => id) }),
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
  const recorded = await personMeetings(
    store,
    people.map(({ uid }) => uid),
    stored.filter((one) => scope.has(one)),
    { limit: RECORDED_ROWS, ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) },
  )
  cut ||= recorded.hasMore
  let held = 0
  for (const meeting of recorded.items) {
    read.add(keyOf(meeting.account))
    const event = meeting.event === null ? undefined : Number(meeting.event.slice("event:".length))
    if (event !== undefined && meetings.has(event)) {
      held++
      continue
    }
    recordedTouches.push({
      kind: "meeting",
      ref: meeting.ref,
      title: meeting.title,
      at: meeting.startedAt,
      people: meeting.people,
    })
  }

  return {
    counts: { messages: messageCount, mail: mail.size, meetings: meetings.size + recorded.total - held },
    items: [...messages.values(), ...mail.values(), ...meetings.values(), ...recordedTouches].sort(newestFirst),
    hasMore: cut,
    coverage: coverageOf(people, read, calendars.length > 0),
  }
}
