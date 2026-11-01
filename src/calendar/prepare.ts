import { CliError } from "@wirecat/cli-base"
import type { Issue, Meta } from "@wirecat/cli-base/standards"
import type { EventDetails, EventStore } from "../meetings/index.js"
import { parseMeetingReference } from "../meetings/index.js"
import { type ContextEvent, type ContextMessage, readsOf, recordContext } from "../services/person-context.js"
import { type PersonMeetingContextItem, personMeetingContext } from "../services/person-meeting-context.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import {
  accountsMeta,
  CALENDAR_UNTRUSTED_FIELDS,
  eventAnswer,
  eventOf,
  type PersonOfEmail,
  type ReadAccount,
} from "./reads.js"

export const PREPARE_MESSAGES = 5
/** Attendees past this many are listed without their messages: a meeting of fifty would not fit any budget. */
export const PREPARE_PEOPLE = 10
export const PREPARE_BYTES = 128 * 1024
const PERSON_BYTES = 24 * 1024
const MEETINGS = 2
const CUES = 5
/** How many upcoming events the next-meeting rule looks at before it gives up. */
const NEXT_SCAN = 200
const NEXT_PAGE = 50

const nameOf = ({ provider, account }: AccountKey) => `${provider}:${account}`
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

/**
 * What makes an event the next meeting: timed, not cancelled, not declined by the owner, an ordinary event (no focus
 * time, out-of-office or working location), and someone other than the owner and the rooms invited.
 */
const isMeeting = (details: EventDetails) => {
  if (details.event.allDay || details.event.status === "cancelled") return false
  const live = details.entries.filter((entry) => entry.deletedAt === null && entry.status !== "cancelled")
  if (!live.length || live.every((entry) => entry.ownResponse === "declined")) return false
  if (live.every((entry) => entry.eventType !== null && entry.eventType !== "default")) return false
  return details.participants.some((one) => !one.self && !one.resource)
}

/** The account's next meeting that has not started yet, by the rule of `isMeeting`. */
export const nextMeeting = async (store: EventStore, accountId: number, now: number): Promise<EventDetails> => {
  for (let offset = 0; offset < NEXT_SCAN; offset += NEXT_PAGE) {
    const page = await store.events({ accountId, startsFrom: now, limit: NEXT_PAGE, offset })
    for (const one of page) {
      if (one.allDay || one.status === "cancelled") continue
      const details = await eventOf(store, accountId, one.id).catch(() => undefined)
      if (details && isMeeting(details)) return details
    }
    if (page.length < NEXT_PAGE) break
  }
  throw new CliError("not_found", "no upcoming meeting with other attendees in the store; run sync, or name an event", {
    reason: "calendar.no-upcoming",
  })
}

export interface PreparationOptions {
  store: EventStore
  messages: MessageStore
  account: ReadAccount
  personOf: PersonOfEmail
  now: number
  /** Messages per person, each list. */
  limit?: number
  /** ms: no message or meeting older. */
  since?: number
}

interface Attendee {
  email: string
  name: string | null
  response: string | null
  organizer: boolean
  optional: boolean
  person: string | null
}

const UNTRUSTED = [
  ...CALENDAR_UNTRUSTED_FIELDS.filter(
    (field) => !["candidates.title", "entry.title", "ended.title"].includes(field),
  ).map((field) => `event.${field}`),
  "people.name",
  ...["direct", "groups"].flatMap((list) =>
    ["chat_title", "sender_name", "text"].map((field) => `people.recent.${list}.${field}`),
  ),
  "people.past_events.title",
  "people.past_events.location",
  "people.meetings.cues.speaker_name",
  "people.meetings.cues.text",
]

/**
 * The stored evidence for one meeting: the event, and for each attendee other than the owner, their linked identities,
 * their latest messages and mail, the events and recorded meetings they shared with the owner. Reads the store only,
 * every account that saw each person (WC-ACCT-9), and writes nothing; the brief is the agent's.
 */
export const eventPreparation = async (details: EventDetails, options: PreparationOptions) => {
  const { messages: store, account, personOf, now, since } = options
  const limit = options.limit ?? PREPARE_MESSAGES
  const shown = await eventAnswer(details, personOf)
  const others: Attendee[] = shown.attendees
    .filter((one) => !one.self && !one.resource)
    .sort((a, b) => Number(b.organizer) - Number(a.organizer))
  const read = new Map<string, AccountKey>([[nameOf(account.key), account.key]])
  const issues: Issue[] = []
  const stored = await store.accounts.storedAccounts()
  let left = PREPARE_BYTES - size(shown)
  let truncated = others.length > PREPARE_PEOPLE
  let pending = 0

  const people = []
  for (const [index, attendee] of others.entries()) {
    const base = {
      email: attendee.email,
      name: attendee.name,
      response: attendee.response,
      organizer: attendee.organizer,
      optional: attendee.optional,
      person: attendee.person,
    }
    const record = attendee.person ? await store.people.personOf({ provider: "email", id: attendee.email }) : undefined
    const nothing = {
      ...base,
      read: false,
      identities: record ? record.identities.map(({ provider, id }) => `${provider}:${id}`) : [],
      recent: { direct: [] as ContextMessage[], groups: [] as ContextMessage[] },
      pastEvents: [] as ContextEvent[],
      meetings: [] as PersonMeetingContextItem[],
      hasMore: false,
    }
    if (!record || index >= PREPARE_PEOPLE || left < 2048) {
      if (record && index < PREPARE_PEOPLE) truncated = true
      people.push(nothing)
      continue
    }
    const reads = readsOf(record, account.key)
    for (const { key } of reads) read.set(nameOf(key), key)
    const context = await recordContext(store, record, reads, {
      messages: limit,
      bytes: Math.min(left, PERSON_BYTES),
      now,
      ...(since === undefined ? {} : { since }),
    })
    for (const chat of context.notRead)
      issues.push({
        code: "not_found",
        reason: "chat.not-read",
        source: `${chat.provider}:${chat.account}/${chat.chatId}`,
      })
    const meetings = await meetingsWith(store, record.uid, stored, since)
    pending = Math.max(pending, meetings.pending)
    for (const id of meetings.accounts) {
      const one = stored.find((held) => held.id === id)
      if (one) read.set(nameOf(one), { provider: one.provider, account: one.account })
    }
    const entry = {
      ...nothing,
      read: true,
      recent: context.recent,
      pastEvents: context.events.recent.filter((one) => one.ref !== shown.ref).slice(0, limit),
      meetings: meetings.items,
      hasMore: context.hasMore || meetings.hasMore,
    }
    left -= size(entry)
    people.push(entry)
  }
  if (pending > 0) issues.push({ code: "not_found", reason: "meetings.index-pending", source: "meetings" })

  const calendar = await accountsMeta(options.store, [account], [], now)
  const all = [...(calendar.issues ?? []), ...issues]
  const meta: Pick<Meta, "accounts" | "complete" | "issues" | "truncated"> = {
    accounts: [...read.keys()],
    complete: all.length === 0,
    ...(all.length ? { issues: all } : {}),
    ...(truncated || left < 0 ? { truncated: true } : {}),
  }
  return {
    event: shown,
    people,
    limits: { people: PREPARE_PEOPLE, messages: limit, bytes: PREPARE_BYTES },
    untrusted: UNTRUSTED,
    meta,
  }
}

/** Their latest recorded meetings in every stored account that saw them; none is not an error. */
const meetingsWith = async (
  store: MessageStore,
  uid: string,
  stored: { id: number }[],
  since: number | undefined,
): Promise<{ items: PersonMeetingContextItem[]; hasMore: boolean; accounts: number[]; pending: number }> => {
  const none = { items: [], hasMore: false, accounts: [], pending: 0 }
  if (!stored.length) return none
  try {
    const found = await personMeetingContext(store, `person:${uid}`, {
      accountIds: stored.slice(0, 1000).map(({ id }) => id),
      meetings: MEETINGS,
      cues: CUES,
      bytes: PERSON_BYTES,
      ...(since === undefined ? {} : { since }),
    })
    return {
      items: found.items,
      hasMore: found.coverage.truncatedBy !== null || found.coverage.scanLimitReached,
      accounts: [...new Set(found.items.map((item) => parseMeetingReference(item.reference).accountId))],
      pending: found.coverage.pending,
    }
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return none
    throw error
  }
}
