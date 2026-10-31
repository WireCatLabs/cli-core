import { CliError } from "@wirecat/cli-base"
import {
  dateRange,
  dayBoundary,
  type Predicate,
  type QueryRegistry,
  queryError,
  queryFieldsOf,
} from "@wirecat/cli-base/query"
import { LIST_QUERY_GUIDE, listQuery, nativeTerms, type QueryWords, typedQuery } from "../cli/list-query.js"
import {
  type Event,
  type EventDetails,
  type EventFilter,
  type EventStore,
  event,
  eventChange,
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

/** Fields whose text whoever sent the invitation wrote: an agent reads them as data. */
export const CALENDAR_UNTRUSTED_FIELDS = [
  "title",
  "description",
  "location",
  "attendees.name",
  "candidates.title",
  "entries.title",
  "entry.title",
  "ended.title",
  "history.title",
  "history.location",
  "attachments.title",
]

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

const LIST = "events list"

const oneSided = (field: string, example: string) => (node: Predicate) => {
  if (node.operator !== "range" || node.upper !== "*")
    queryError("query.unsupported-operator", node.span, `${field} takes only an earliest moment, such as ${example}`, {
      command: LIST,
      guide: LIST_QUERY_GUIDE,
    })
}

/** `events list`'s query. The store answers `ends_at` and `changed_at` from below only; `starts_at` either way. */
export const EVENTS_QUERY: QueryRegistry = {
  entity: "event",
  backend: "native",
  fields: queryFieldsOf(event, {
    native: ["starts_at", "ends_at", "changed_at", "calendar", "person"],
    relations: {
      calendar: { type: "kw", example: "calendar:3", relation: "one calendar, by its id or the provider's id" },
      person: {
        type: "kw",
        example: "person:ana@example.com",
        relation: "events one person attends: an address, or a person id from search",
      },
    },
    examples: {
      starts_at: "starts_at:[2026-11-02 TO 2026-11-07}",
      ends_at: "ends_at>=2026-11-02",
      changed_at: "changed_at>=2026-10-01",
    },
    validate: {
      ends_at: oneSided("ends_at", "ends_at>=2026-11-02; for the latest, write starts_at<2026-11-07"),
      changed_at: oneSided("changed_at", "changed_at>=2026-10-01"),
    },
  }).map((field) =>
    field.native
      ? { ...field, operators: field.type === "time" ? (["term", "range"] as const) : (["term", "phrase"] as const) }
      : field,
  ),
}

export const EVENTS_QUERY_NOTE =
  "\nends_at keeps events that end after its moment, so one that ends exactly then is left out. Without starts_at " +
  "or ends_at: events that end after the start of today, in your time zone."

/** A time term as epoch ms: from `lower` on, and before `upper`. */
export const timeWindow = (node: Predicate, zone: string, now: number): { lower?: number; upper?: number } => {
  const range =
    node.operator === "range"
      ? dateRange(
          node.value,
          node.upper ?? "*",
          node.lower_inclusive !== false,
          node.upper_inclusive !== false,
          zone,
          node.span,
          now,
        )
      : dateRange(node.value, node.value, true, true, zone, node.span, now)
  return {
    ...(range.lower === undefined ? {} : { lower: range.lower_inclusive ? range.lower : range.lower + 1 }),
    ...(range.upper === undefined ? {} : { upper: range.upper_inclusive ? range.upper + 1 : range.upper }),
  }
}

/**
 * `events list`'s query into a store filter, for one account. A person named by address is found through the
 * shared store; one nobody knows matches no event.
 */
export const eventsFilter = async (
  query: QueryWords,
  context: {
    store: EventStore
    accountId: number
    zone: string
    now: number
    personOf?: (reference: string) => Promise<number | null>
  },
): Promise<EventFilter | null> => {
  const filter: EventFilter = { accountId: context.accountId }
  const { zone, now } = context
  const span = (text: string) => ({ start: 0, end: text.length })
  const day = (date: string) => dayBoundary(date, zone, false, span(date))
  for (const [field, node] of nativeTerms(listQuery(typedQuery(query), EVENTS_QUERY, LIST), LIST)) {
    if (field === "starts_at") {
      const { lower, upper } = timeWindow(node, zone, now)
      if (lower !== undefined) filter.startsFrom = lower
      if (upper !== undefined) filter.to = upper
    } else if (field === "ends_at") {
      // Strictly after, as the default window: `ends_at>=today` leaves out yesterday's all-day event, which ends at
      // today's midnight.
      const { lower } = timeWindow(node, zone, now)
      if (lower !== undefined) filter.from = lower
    } else if (field === "changed_at") {
      const { lower } = timeWindow(node, zone, now)
      if (lower !== undefined) filter.changedSince = lower
    } else if (field === "calendar")
      filter.calendarId = (await calendarIn(context.store, context.accountId, node.value)).id
    else if (field === "person") {
      if (!context.personOf) throw new CliError("configuration_error", "this tool cannot look people up")
      const person = await context.personOf(node.value)
      if (person === null) return null
      filter.personId = person
    }
  }
  if (filter.from === undefined && filter.startsFrom === undefined && filter.to === undefined)
    filter.from = day(localDate(now, zone))
  return datedFilter(filter, zone)
}

/** Events that end after the start of today and start within seven days, in `zone`. */
export const weekFilter = (accountId: number, zone: string, now: number): EventFilter => {
  const today = localDate(now, zone)
  const day = (date: string) => dayBoundary(date, zone, false, { start: 0, end: date.length })
  return datedFilter({ accountId, from: day(today), to: day(plusDays(today, 7)) }, zone)
}

/** The local days an all-day event is compared by, from the filter's instants. */
const datedFilter = (filter: EventFilter, zone: string): EventFilter => {
  if (filter.from !== undefined) filter.fromDate = localDate(filter.from, zone)
  if (filter.to !== undefined) filter.toDate = plusDays(localDate(filter.to - 1, zone), 1)
  if (filter.startsFrom !== undefined) {
    const date = localDate(filter.startsFrom, zone)
    const midnight = dayBoundary(date, zone, false, { start: 0, end: date.length })
    filter.startsFromDate = midnight < filter.startsFrom ? plusDays(date, 1) : date
  }
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

const EVENTS_COUNTED = 1000

/** One page of events, and whether another follows; probed with one row, since a store reads at most 1000. */
const page = async (store: EventStore, filter: EventFilter) => {
  const rows = await store.events(filter)
  const limit = filter.limit ?? 100
  const hasMore =
    rows.length === limit &&
    (await store.events({ ...filter, offset: (filter.offset ?? 0) + limit, limit: 1 })).length > 0
  return { rows, limit, hasMore }
}

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
  const { rows, hasMore } = await page(store, { ...options.filter, accountId, limit: EVENTS_COUNTED })
  const byEvent = new Map<number, StoredParticipant[]>()
  for (const { eventId, ...one } of await store.participantsOf(
    rows.map(({ id }) => id),
    [...mine],
  ))
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), one])
  for (const event of rows) {
    const seen = new Set<string>()
    for (const one of byEvent.get(event.id) ?? []) {
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
  const answer = listed(
    people
      .map((one) => ({ ...one, events: counted.get(one.email)?.events ?? 0 }))
      .sort((a, b) => b.events - a.events || a.email.localeCompare(b.email)),
  )
  return hasMore ? { ...answer, meta: { complete: true, truncated: true } } : answer
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

export const resolveAnswer = async (
  store: EventStore,
  accountId: number,
  review: string,
  choice: string,
  now: number,
) => {
  if (!/^[1-9]\d*$/u.test(review)) throw new CliError("validation_error", "a review is its id from links review")
  const decision = choice === "apart" ? { apart: true as const } : { choose: eventIdOf(choice) }
  const found = (await store.reviews()).find(({ id }) => id === Number(review))
  if (found && (found.calendarId === null || !(await calendarIds(store, accountId)).has(found.calendarId)))
    throw new CliError(
      "permission_error",
      `review ${review} is about a copy on another account's calendar; resolve it from that account's profile`,
    )
  const resolved = await store.resolveReview(Number(review), decision, now)
  return {
    id: String(resolved.id),
    status: resolved.status,
    chosen: resolved.chosenId === null ? null : `event:${resolved.chosenId}`,
  }
}

/** What changed about each listed event since the filter's instant, from its own copies. */
const changesOf = async (store: EventStore, rows: Event[], filter: EventFilter, since: number) => {
  const mine = filter.accountId === undefined ? [] : [...(await calendarIds(store, filter.accountId))]
  const { entries, revisions } = await store.historyOf(
    rows.map(({ id }) => id),
    mine,
    since,
  )
  return new Map(
    rows.map((event) => [
      event.id,
      eventChange(
        event,
        entries.filter(({ eventId }) => eventId === event.id),
        revisions,
        since,
      ),
    ]),
  )
}

/** The other listed-kind events each one overlaps: those `overlapping` finds across the page's whole span. */
const overlapsOf = async (store: EventStore, rows: Event[], filter: EventFilter) => {
  const timed = rows.filter((one) => one.startsAt !== null && one.endsAt !== null)
  if (!timed.length) return new Map<number, Event[]>()
  const others = await store.events({
    ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
    from: Math.min(...timed.map(({ startsAt }) => startsAt as number)),
    to: Math.max(...timed.map(({ endsAt }) => endsAt as number)),
    overlapping: true,
    limit: 1000,
  })
  return new Map(
    timed.map((event) => [
      event.id,
      others.filter(
        (other) =>
          other.id !== event.id &&
          (other.startsAt as number) < (event.endsAt as number) &&
          (other.endsAt as number) > (event.startsAt as number),
      ),
    ]),
  )
}

export const eventsAnswer = async (store: EventStore, filter: EventFilter | null) => {
  if (filter === null) return listed([])
  const { rows, limit, hasMore } = await page(store, filter)
  const changes = filter.changedSince === undefined ? null : await changesOf(store, rows, filter, filter.changedSince)
  const overlaps = filter.overlapping ? await overlapsOf(store, rows, filter) : null
  return listed(
    rows.map((event) => {
      const change = changes?.get(event.id)
      return {
        ...eventItem(event),
        ...(change
          ? {
              change: change.change,
              changed_at: iso(change.at),
              ...(change.was ? { was: { starts_at: iso(change.was.startsAt), ends_at: iso(change.was.endsAt) } } : {}),
            }
          : {}),
        ...(overlaps ? { overlaps: (overlaps.get(event.id) ?? []).map(({ id }) => `event:${id}`) } : {}),
      }
    }),
    { limit, hasMore },
  )
}
