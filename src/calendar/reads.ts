import { CliError } from "@wirecat/cli-base"
import { dayBoundary, zonedMoment } from "@wirecat/cli-base/query"
import {
  type EventDetails,
  type EventFilter,
  type EventStore,
  eventItem,
  type LinkReview,
  listed,
  type StoredCalendar,
  type StoredEntry,
  type StoredParticipant,
} from "../meetings/index.js"

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())

/** Who looks a person up: the shared store's `people.personOf`, for an attendee's `email` contact. */
export type PersonOfEmail = (email: string) => Promise<string | null>

export const calendarItem = (one: StoredCalendar) => ({
  id: String(one.id),
  external_id: one.externalId,
  title: one.title,
  timezone: one.timezone,
  access_role: one.accessRole,
  primary: one.primary,
  synced: one.synced,
  seen_at: iso(one.seenAt),
})

/** A stored calendar by its id or the provider's id, among the account's calendars. */
export const calendarIn = async (store: EventStore, accountId: number, reference: string): Promise<StoredCalendar> => {
  const calendars = await store.calendars(accountId)
  const found =
    calendars.find((one) => String(one.id) === reference) ?? calendars.find((one) => one.externalId === reference)
  if (!found) throw new CliError("not_found", `no calendar ${reference} in this account; calendars list shows them`)
  return found
}

export const eventIdOf = (reference: string | number): number => {
  const text = String(reference).replace(/^event:/u, "")
  if (!/^[1-9]\d*$/u.test(text) || !Number.isSafeInteger(Number(text)))
    throw new CliError("validation_error", "an event is its id or event:<id>")
  return Number(text)
}

const localDate = (at: number, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)

export const plusDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export const EVENTS_QUERY_HELP = `
Words, any order:
  today | week            today, or today and the next six days, in your time zone
  from:<date> to:<date>   from the start of one day through the end of another (or a time with a zone)
  person:<email|id>       events one person attends: an address, or a person id from search
  calendar:<id>           one calendar, by its id or the provider's id
Without a time word: events from the start of today on.`

/**
 * `events list` words into a store filter, for one account. A person named by address is found through the shared
 * store; one nobody knows matches no event.
 */
export const eventsFilter = async (
  words: readonly string[],
  context: {
    store: EventStore
    accountId: number
    zone: string
    now: number
    personOf?: (reference: string) => Promise<number | null>
  },
): Promise<EventFilter | null> => {
  const filter: EventFilter = { accountId: context.accountId }
  const today = localDate(context.now, context.zone)
  const span = (text: string) => ({ start: 0, end: text.length })
  const day = (date: string) => dayBoundary(date, context.zone, false, span(date))
  let timed = false
  for (const word of words) {
    const [, field, value = ""] = /^([a-z]+):(.+)$/u.exec(word) ?? []
    if (word === "today" || word === "week") {
      filter.from = day(today)
      filter.to = day(plusDays(today, word === "today" ? 1 : 7))
      timed = true
    } else if (field === "from") {
      filter.from = zonedMoment(value, context.zone, span(value))
      timed = true
    } else if (field === "to") {
      filter.to = zonedMoment(value, context.zone, span(value), { end: true }) + 1
      timed = true
    } else if (field === "calendar") filter.calendarId = (await calendarIn(context.store, context.accountId, value)).id
    else if (field === "person") {
      if (!context.personOf) throw new CliError("configuration_error", "this tool cannot look people up")
      const person = await context.personOf(value)
      if (person === null) return null
      filter.personId = person
    } else
      throw new CliError("validation_error", `${word} is not an events list word${EVENTS_QUERY_HELP}`, {
        reason: "query.unknown_word",
      })
  }
  if (!timed) filter.from = day(today)
  return filter
}

/**
 * Only the account's own copies of an event, with their attendees, files and history. Rule 3 joins copies of one
 * meeting across accounts into one event; the event's own fields (title, time) are shared, its copies are not.
 */
const ownCopies = (details: EventDetails, calendars: ReadonlySet<number>): EventDetails => {
  const entries = details.entries.filter(({ calendarId }) => calendars.has(calendarId))
  const ids = new Set(entries.map(({ id }) => id))
  return {
    event: details.event,
    entries,
    participants: details.participants.filter(({ entryId }) => ids.has(entryId)),
    revisions: details.revisions.filter(({ entryId }) => ids.has(entryId)),
    attachments: details.attachments.filter(({ entryId }) => ids.has(entryId)),
  }
}

const calendarIds = async (store: EventStore, accountId: number) =>
  new Set((await store.calendars(accountId)).map(({ id }) => id))

/** An event the account holds, with only its copies, or `not_found`: another account's event is not shown. */
export const eventOf = async (store: EventStore, accountId: number, id: number): Promise<EventDetails> => {
  const details = await store.event(id)
  const own = details && ownCopies(details, await calendarIds(store, accountId))
  if (!own?.entries.length) throw new CliError("not_found", `no event ${id} in this account`)
  return own
}

const attendees = async (participants: StoredParticipant[], personOf?: PersonOfEmail) => {
  const byEmail = new Map<string, StoredParticipant>()
  for (const one of participants) if (!byEmail.has(one.email)) byEmail.set(one.email, one)
  return Promise.all(
    [...byEmail.values()].map(async (one) => ({
      email: one.email,
      name: one.name,
      response: one.response,
      organizer: one.organizer,
      optional: one.optional,
      resource: one.resource,
      self: one.self,
      person: one.resource || !personOf ? null : await personOf(one.email),
    })),
  )
}

export const entryItem = (entry: StoredEntry) => ({
  id: String(entry.id),
  calendar_id: String(entry.calendarId),
  external_id: entry.externalId,
  kind: entry.kind,
  title: entry.title,
  status: entry.status,
  event_type: entry.eventType,
  own_response: entry.ownResponse,
  starts_at: iso(entry.startsAt),
  ends_at: iso(entry.endsAt),
  join_url: entry.joinUrl,
  url: entry.url,
  deleted_at: iso(entry.deletedAt),
})

export const eventAnswer = async (details: EventDetails, personOf?: PersonOfEmail) => ({
  ...eventItem(details.event),
  ref: `event:${details.event.id}`,
  entries: details.entries.map(entryItem),
  attendees: await attendees(details.participants, personOf),
  attachments: details.attachments.map(({ fileId, title, documentId }) => ({
    file_id: fileId,
    title,
    document: documentId === null ? null : `doc:${documentId}`,
  })),
  history: details.revisions.map((one) => ({
    title: one.title,
    starts_at: iso(one.startsAt),
    ends_at: iso(one.endsAt),
    location: one.location,
    status: one.status,
    changed_at: new Date(one.createdAt).toISOString(),
  })),
})

/** One event's attendees, or everyone attending the events of the filter, with how many of them each attends. */
export const peopleAnswer = async (
  store: EventStore,
  accountId: number,
  options: { event?: number; filter?: EventFilter; personOf?: PersonOfEmail },
) => {
  if (options.event !== undefined)
    return listed(await attendees((await eventOf(store, accountId, options.event)).participants, options.personOf))
  const counted = new Map<string, { participant: StoredParticipant; events: number }>()
  const mine = await calendarIds(store, accountId)
  for (const event of await store.events({ ...options.filter, accountId, limit: 1000 })) {
    const details = await store.event(event.id)
    const seen = new Set<string>()
    for (const one of details ? ownCopies(details, mine).participants : []) {
      if (one.resource || one.self || seen.has(one.email)) continue
      seen.add(one.email)
      const held = counted.get(one.email)
      if (held) held.events++
      else counted.set(one.email, { participant: one, events: 1 })
    }
  }
  const people = await attendees(
    [...counted.values()].map(({ participant }) => participant),
    options.personOf,
  )
  return listed(
    people
      .map((one) => ({ ...one, events: counted.get(one.email)?.events ?? 0 }))
      .sort((a, b) => b.events - a.events || a.email.localeCompare(b.email)),
  )
}

/** Open link choices, with each candidate event's title and time so the owner can pick. */
export const reviewsAnswer = async (store: EventStore) => {
  const open = (await store.reviews({ status: "open" })).filter(({ linkableType }) => linkableType === "calendar_entry")
  return {
    ...listed(
      await Promise.all(
        open.map(async (review: LinkReview) => ({
          id: String(review.id),
          entry_id: String(review.linkableId),
          reason: review.reason,
          candidates: await Promise.all(
            review.candidates.map(async (id) => {
              const event = review.entityType === "event" ? (await store.event(id))?.event : undefined
              return {
                ref: `event:${id}`,
                title: event?.title ?? null,
                starts_at: iso(event?.startsAt ?? null),
              }
            }),
          ),
        })),
      ),
    ),
    // Link choices are kept per store, not per account, so every calendar account's are listed.
    accounts: "all",
  }
}

export const resolveAnswer = async (store: EventStore, review: string, choice: string, now: number) => {
  if (!/^[1-9]\d*$/u.test(review)) throw new CliError("validation_error", "a review is its id from links review")
  const decision = choice === "apart" ? { apart: true as const } : { choose: eventIdOf(choice) }
  const resolved = await store.resolveReview(Number(review), decision, now)
  return {
    id: String(resolved.id),
    status: resolved.status,
    chosen: resolved.chosenId === null ? null : `event:${resolved.chosenId}`,
  }
}

export const eventsAnswer = async (store: EventStore, filter: EventFilter | null) =>
  listed(filter === null ? [] : (await store.events(filter)).map(eventItem))
