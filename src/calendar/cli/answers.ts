import { annotate } from "@wirecat/cli-base/commands"
import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { count, id, text, time, untrusted } from "../../entities/fields.js"
import { event } from "../../meetings/index.js"

const nullableText = v.nullable(text)
const nullableTime = v.nullable(time)
const stretch = v.strictObject({ start: time, end: time })
const epochWindow = v.strictObject({ from: v.number(), to: v.number() })

export const calendar = v.strictObject({
  id,
  external_id: text,
  title: nullableText,
  timezone: nullableText,
  access_role: nullableText,
  primary: v.boolean(),
  synced: v.boolean(),
  seen_at: nullableTime,
})

const busyRow = v.strictObject({
  /** One of the account's calendars, by its id; or `person`, by the address asked. */
  calendar: v.optional(id),
  person: v.optional(text),
  id: text,
  busy: v.array(stretch),
  error: v.optional(text),
})

export const calendarBusy = v.strictObject({
  start: time,
  end: time,
  timezone: text,
  calendars: v.array(busyRow),
  slots: v.optional(v.array(stretch)),
  unknown: v.optional(v.array(text)),
})

const syncedCalendar = v.strictObject({
  calendar_id: v.number(),
  external_id: text,
  title: nullableText,
  round: v.picklist(["full", "changes"]),
  reset: v.boolean(),
  state: v.picklist(["partial", "complete"]),
  saved: count,
  removed: count,
  occurrences: count,
  unseen: count,
  error: v.optional(text),
})

export const calendarSync = v.strictObject({
  provider: text,
  account_id: v.number(),
  window: epochWindow,
  calendars: count,
  synced: v.array(syncedCalendar),
  not_synced: v.array(v.strictObject({ calendar_id: v.number(), external_id: text, title: nullableText })),
  complete: v.boolean(),
  state: v.picklist(["partial", "complete"]),
  stopped: v.optional(v.picklist(["requests", "deadline", "cancelled"])),
  progress: v.strictObject({
    calendars: count,
    calendars_done: count,
    requests: count,
    saved: count,
    steps: count,
  }),
  hint: v.optional(text),
  /** What `sync --embed` embedded: `embedEvents`' answer. */
  embeddings: v.optional(v.strictObject({ model: text, embedded: count, left: v.boolean() })),
})

export const calendarSyncProgress = v.strictObject({
  calendar_id: id,
  external_id: text,
  title: nullableText,
  round: v.nullable(v.picklist(["full", "changes"])),
  job: text,
  profile: text,
  done: count,
  total: v.nullable(count),
  remaining: v.nullable(count),
  state: v.picklist(["partial", "complete"]),
  updated_at: nullableTime,
  cursor_age_ms: v.nullable(count),
  line: text,
})

const entry = v.strictObject({
  id,
  calendar_id: id,
  external_id: text,
  kind: text,
  title: nullableText,
  status: text,
  event_type: nullableText,
  own_response: nullableText,
  starts_at: nullableTime,
  ends_at: nullableTime,
  join_url: nullableText,
  url: nullableText,
  deleted_at: nullableTime,
})

const attendee = {
  email: text,
  name: nullableText,
  response: nullableText,
  organizer: v.boolean(),
  optional: v.boolean(),
  resource: v.boolean(),
  self: v.boolean(),
  /** `person:<id>` when the shared store knows the address. */
  person: nullableText,
}

const { untrusted: _eventMarker, ...eventFields } = event.entries

export const calendarEvent = v.strictObject({
  ...eventFields,
  ref: text,
  entries: v.array(entry),
  attendees: v.array(v.strictObject(attendee)),
  attachments: v.array(v.strictObject({ file_id: text, title: nullableText, document: nullableText })),
  history: v.array(
    v.strictObject({
      title: nullableText,
      starts_at: nullableTime,
      ends_at: nullableTime,
      location: nullableText,
      status: nullableText,
      changed_at: time,
    }),
  ),
  untrusted,
})

const hitFields = {
  provider: nullableText,
  account: nullableText,
  title: nullableText,
  starts_at: nullableTime,
  ends_at: nullableTime,
  all_day: v.boolean(),
  status: nullableText,
  location: nullableText,
  url: v.optional(text),
  untrusted,
}

/** A hit of the stored search, or with `--backend server` one the provider's own search found and nothing stored. */
export const calendarSearchHit = v.union([
  v.strictObject({
    ...hitFields,
    ref: text,
    excerpt: text,
    occurrences: count,
    updated_at: time,
    found_by: v.array(v.picklist(["words", "meaning"])),
  }),
  v.strictObject({
    ...hitFields,
    calendar: text,
    external_id: text,
    found_by: v.array(v.literal("server")),
  }),
])

export const calendarEventWrite = v.strictObject({
  operation_id: text,
  event: nullableText,
  entry: v.optional(v.nullable(entry)),
  /** `this`, `series` or `following`. */
  scope: v.optional(text),
  /** Copies the store marked deleted. */
  removed: v.optional(count),
  /** The series a `--following` change ended before the occurrence. */
  ended: v.optional(v.nullable(entry)),
  converted: v.optional(text),
  from_calendar: v.optional(id),
  calendar: v.optional(id),
  hint: v.optional(text),
  untrusted,
})

export const calendarAttendee = v.strictObject({
  ...attendee,
  /** How many of the listed events the person attends; only on the week's list. */
  events: v.optional(count),
  untrusted,
})

export const calendarLinkedPerson = v.strictObject({ person: text, name: nullableText, identities: v.array(text) })

export const calendarLinkReview = v.strictObject({
  id,
  entry_id: id,
  reason: text,
  candidates: v.array(v.strictObject({ ref: text, title: nullableText, starts_at: nullableTime })),
  untrusted,
})

export const calendarLinkResolution = v.strictObject({ id, status: text, chosen: nullableText })

const ANSWERS: Record<string, { name: string; schema?: v.GenericSchema }> = {
  "calendars list": { name: "calendar", schema: calendar },
  "calendars sync": { name: "calendar", schema: calendar },
  "calendars unsync": { name: "calendar", schema: calendar },
  "calendars busy": { name: "calendar_busy", schema: calendarBusy },
  sync: { name: "calendar_sync", schema: calendarSync },
  status: { name: "calendar_sync_progress", schema: calendarSyncProgress },
  "events list": { name: "event" },
  "events show": { name: "calendar_event", schema: calendarEvent },
  "events create": { name: "calendar_event_write", schema: calendarEventWrite },
  "events update": { name: "calendar_event_write", schema: calendarEventWrite },
  "events delete": { name: "calendar_event_write", schema: calendarEventWrite },
  "events move": { name: "calendar_event_write", schema: calendarEventWrite },
  "events respond": { name: "calendar_event_write", schema: calendarEventWrite },
  search: { name: "calendar_search_hit", schema: calendarSearchHit },
  "people list": { name: "calendar_attendee", schema: calendarAttendee },
  "people link": { name: "calendar_linked_person", schema: calendarLinkedPerson },
  "links review": { name: "calendar_link_review", schema: calendarLinkReview },
  "links resolve": { name: "calendar_link_resolution", schema: calendarLinkResolution },
}

/**
 * Each command's answer entity: one item of a list, or the one value. They describe what a host prints, with the
 * keys in snake_case, though a command hands its host some keys in camelCase (`notSynced`, `hasMore`).
 */
export const declareCalendarAnswers = (program: Command, commands: readonly Command[]): void => {
  const pathOf = (command: Command) => {
    const words: string[] = []
    for (let at: Command | null = command; at && at !== program; at = at.parent) words.unshift(at.name())
    return words.join(" ")
  }
  for (const command of commands) {
    const answer = ANSWERS[pathOf(command)]
    if (!answer) continue
    if (answer.schema) answerEntity(command, answer.name, answer.schema)
    else annotate(command, { output: { entity: answer.name } })
  }
}

export const CALENDAR_ANSWER_PATHS = Object.keys(ANSWERS)

const wholeValues = (registry: QueryRegistry): QueryRegistry => ({
  ...registry,
  fields: registry.fields.map((field) =>
    field.native ? { ...field, operators: field.operators.filter((one) => one === "term" || one === "phrase") } : field,
  ),
})

/** The provider answers the whole list, never a page, so the terms narrow every calendar it has. */
export const CALENDARS_QUERY = wholeValues({
  entity: "calendar",
  backend: "native",
  fields: queryFieldsOf(calendar, {
    native: ["synced", "primary", "access_role"],
    examples: { synced: "synced:true", primary: "primary:true", access_role: "access_role:owner" },
  }),
})

export const PEOPLE_QUERY = wholeValues({
  entity: "calendar_attendee",
  backend: "native",
  fields: queryFieldsOf(calendarAttendee, {
    native: ["event"],
    relations: {
      event: {
        type: "kw",
        example: "event:42",
        relation: "one event's attendees, by its id; without it, everyone in this week's events",
      },
    },
  }),
})
