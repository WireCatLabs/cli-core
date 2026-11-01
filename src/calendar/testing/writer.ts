import { CliError } from "@wirecat/cli-base"
import type { EntryInput, StoredCalendar } from "../../meetings/index.js"
import { type CalendarWriter, calendarConflict, type EventDraft, type EventPatch } from "../writer.js"

export interface FakeCalendarWriterCall {
  write: "create" | "quick-add" | "import" | "update" | "remove" | "respond" | "move"
  calendar: string
  externalId: string
  notify: boolean
  scope?: "this" | "series"
  /** A move's calendar. */
  target?: string
}

/**
 * A provider's calendars held in memory, as a writer sees them. Every entry carries an etag that each change moves
 * on; a write with an older one is a conflict, as Google's or CalDAV's `If-Match` is.
 */
export interface FakeCalendarWriter extends CalendarWriter {
  /** Entries the provider holds already, as a sync would have stored them; each gets an etag unless it has one. */
  put(calendar: string, ...entries: EntryInput[]): EntryInput[]
  /** Another client changes the entry: its etag moves on, so the stored one is old. */
  changeBehind(calendar: string, externalId: string): void
  /** The next write takes effect, and then its answer is lost: it throws `outcome_unknown`. */
  loseNextAnswer(): void
  held(calendar: string): EntryInput[]
  readonly calls: FakeCalendarWriterCall[]
}

export const fakeCalendarWriter = (options: { provider?: string } = {}): FakeCalendarWriter => {
  const calendars = new Map<string, Map<string, EntryInput>>()
  const calls: FakeCalendarWriterCall[] = []
  let version = 0
  let lose = false
  const of = (calendar: string) => {
    if (!calendars.has(calendar)) calendars.set(calendar, new Map())
    return calendars.get(calendar) as Map<string, EntryInput>
  }
  const stamp = (entry: EntryInput): EntryInput => ({ ...entry, etag: `"v${++version}"` })
  const answer = <T>(value: T): T => {
    if (!lose) return value
    lose = false
    throw new CliError("outcome_unknown", "the provider did not answer")
  }
  const current = (calendar: StoredCalendar, externalId: string, etag: string) => {
    const found = of(calendar.externalId).get(externalId)
    if (!found || found.status === "cancelled") throw new CliError("not_found", `no event ${externalId}`)
    if (found.etag !== etag) throw calendarConflict()
    return found
  }
  const fields = (patch: EventPatch): Partial<EntryInput> => {
    const { attendees, title, ...rest } = patch
    return {
      ...rest,
      ...(title === undefined ? {} : { title }),
      ...(patch.startDate === undefined ? {} : { allDay: true, startsAt: null, endsAt: null }),
      ...(patch.startsAt === undefined ? {} : { allDay: false, startDate: null, endDate: null }),
      ...(attendees === undefined
        ? {}
        : { participants: attendees.map(({ email, optional }) => ({ email, optional: optional === true })) }),
    }
  }

  return {
    provider: options.provider ?? "example-calendar",
    calls,
    put(calendar, ...entries) {
      return entries.map((entry) => {
        const held = entry.etag ? entry : stamp(entry)
        of(calendar).set(entry.externalId, held)
        return held
      })
    },
    changeBehind(calendar, externalId) {
      const found = of(calendar).get(externalId)
      if (found) of(calendar).set(externalId, stamp(found))
    },
    loseNextAnswer() {
      lose = true
    },
    held(calendar) {
      return [...of(calendar).values()]
    },
    async create(calendar, draft: EventDraft, { id, notify }) {
      calls.push({ write: "create", calendar: calendar.externalId, externalId: id, notify })
      const existing = of(calendar.externalId).get(id)
      if (existing) return answer(existing)
      const entry = stamp({
        externalId: id,
        kind: draft.recurrence ? "series" : "single",
        status: "confirmed",
        participants: [],
        ...fields(draft),
      })
      of(calendar.externalId).set(id, entry)
      return answer(entry)
    },
    /** Reads no date: the event is the whole line as its title, an hour from noon UTC of 2 November 2026. */
    async quickAdd(calendar, text, { notify }) {
      const id = `quick${++version}`
      calls.push({ write: "quick-add", calendar: calendar.externalId, externalId: id, notify })
      const noon = Date.UTC(2026, 10, 2, 12)
      const entry = stamp({
        externalId: id,
        icalUid: `${id}@example.com`,
        kind: "single",
        status: "confirmed",
        title: text,
        startsAt: noon,
        endsAt: noon + 3_600_000,
        participants: [],
      })
      of(calendar.externalId).set(id, entry)
      return answer(entry)
    },
    /** Keeps one event per UID on a calendar: a UID sent again replaces the event under the same id. */
    async importEvent(calendar, event) {
      const held = [...of(calendar.externalId).values()].find((one) => one.icalUid === event.uid)
      const id = held?.externalId ?? `imported${++version}`
      calls.push({ write: "import", calendar: calendar.externalId, externalId: id, notify: false })
      const entry = stamp({
        externalId: id,
        icalUid: event.uid,
        kind: event.recurrence ? "series" : "single",
        status: event.status ?? "confirmed",
        title: event.title,
        description: event.description ?? null,
        location: event.location ?? null,
        ...(event.startDate === undefined
          ? { startsAt: event.startsAt ?? null, endsAt: event.endsAt ?? null, timezone: event.timezone ?? null }
          : { allDay: true, startDate: event.startDate, endDate: event.endDate ?? null }),
        ...(event.recurrence ? { recurrence: event.recurrence } : {}),
        participants: (event.attendees ?? []).map(({ email, name }) => ({ email, name: name ?? null })),
      })
      of(calendar.externalId).set(id, entry)
      return answer(entry)
    },
    async update(calendar, externalId, patch, { scope, etag, notify }) {
      calls.push({ write: "update", calendar: calendar.externalId, externalId, notify, scope })
      const entry = stamp({ ...current(calendar, externalId, etag), ...fields(patch) })
      of(calendar.externalId).set(externalId, entry)
      return answer(entry)
    },
    async remove(calendar, externalId, { scope, etag, notify }) {
      calls.push({ write: "remove", calendar: calendar.externalId, externalId, notify, scope })
      of(calendar.externalId).set(externalId, stamp({ ...current(calendar, externalId, etag), status: "cancelled" }))
      answer(undefined)
    },
    async respond(calendar, externalId, response, { etag, notify }) {
      calls.push({ write: "respond", calendar: calendar.externalId, externalId, notify })
      const found = current(calendar, externalId, etag)
      const entry = stamp({
        ...found,
        ownResponse: response,
        ...(found.participants
          ? { participants: found.participants.map((one) => (one.self ? { ...one, response } : one)) }
          : {}),
      })
      of(calendar.externalId).set(externalId, entry)
      return answer(entry)
    },
    async move(calendar, externalId, target, { etag, notify }) {
      calls.push({ write: "move", calendar: calendar.externalId, externalId, notify, target: target.externalId })
      const arrived = of(target.externalId).get(externalId)
      // A retry after a lost answer: the event left this calendar on the first try.
      if (arrived && !of(calendar.externalId).has(externalId)) return arrived
      const entry = stamp(current(calendar, externalId, etag))
      of(calendar.externalId).delete(externalId)
      of(target.externalId).set(externalId, entry)
      return answer(entry)
    },
  }
}
