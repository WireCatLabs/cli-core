import { CliError } from "@wirecat/cli-base"
import {
  calendarText,
  type EntryAttachment,
  type EntryAttachmentInput,
  type EntryInput,
  type EntryParticipantInput,
  type EntryRevision,
  type EventDetails,
  type EventFilter,
  type EventStore,
  entryInWindow,
  entryMetadata,
  joinKeyOf,
  joinUrlWithoutQuery,
  type LinkReview,
  type StoredCalendar,
  type StoredEntry,
  type StoredParticipant,
} from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { bool, eventOf, fromJson, int, str, toJson } from "./events.js"
import { driveDocumentOf, driveFileTarget, logFileLink } from "./files.js"
import { identityOf } from "./identities.js"
import { reviewLink } from "./link-reviews.js"
import type { StoreContext } from "./open.js"
import { read, write } from "./transaction.js"

type Row = Record<string, unknown>

const calendarOf = (row: Row): StoredCalendar => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  externalId: String(row.external_id),
  title: str(row.title),
  timezone: str(row.timezone),
  accessRole: str(row.access_role) as StoredCalendar["accessRole"],
  primary: Number(row.primary_calendar) === 1,
  synced: Number(row.synced) === 1,
  seenAt: int(row.seen_at),
  deletedAt: int(row.deleted_at),
})

const entryOf = (row: Row): StoredEntry => ({
  id: Number(row.id),
  calendarId: Number(row.calendar_id),
  kind: row.kind as StoredEntry["kind"],
  seriesEntryId: int(row.series_entry_id),
  seriesExternalId: str(row.series_external_id),
  eventId: int(row.event_id),
  eventSeriesId: int(row.event_series_id),
  externalId: String(row.external_id),
  icalUid: str(row.ical_uid),
  originalStartsAt: int(row.original_starts_at),
  exception: Number(row.exception) === 1,
  status: row.status as StoredEntry["status"],
  title: str(row.title),
  description: str(row.description),
  location: str(row.location),
  startsAt: int(row.starts_at),
  endsAt: int(row.ends_at),
  allDay: Number(row.all_day) === 1,
  startDate: str(row.start_date),
  endDate: str(row.end_date),
  timezone: str(row.timezone),
  recurrence: fromJson<string[] | null>(row.recurrence),
  recurrenceEndsAt: int(row.recurrence_ends_at),
  eventType: str(row.event_type) as StoredEntry["eventType"],
  ownResponse: str(row.own_response) as StoredEntry["ownResponse"],
  organizerIdentityId: int(row.organizer_identity_id),
  joinUrl: str(row.join_url),
  joinKey: str(row.join_key),
  url: str(row.url),
  externalUpdatedAt: int(row.external_updated_at),
  etag: str(row.etag),
  seenAt: int(row.seen_at),
  deletedAt: int(row.deleted_at),
})

const participantOf = (row: Row): StoredParticipant => ({
  entryId: Number(row.entry_id),
  identityId: int(row.identity_id),
  email: String(row.email),
  name: str(row.name),
  response: str(row.response) as StoredParticipant["response"],
  optional: bool(row.optional) === true,
  organizer: bool(row.organizer) === true,
  self: bool(row.self) === true,
  resource: bool(row.resource) === true,
})

const revisionOf = (row: Row): EntryRevision => ({
  entryId: Number(row.entry_id),
  title: str(row.title),
  startsAt: int(row.starts_at),
  endsAt: int(row.ends_at),
  location: str(row.location),
  status: str(row.status),
  recurrence: fromJson<string[] | null>(row.recurrence),
  recurrenceEndsAt: int(row.recurrence_ends_at),
  externalUpdatedAt: int(row.external_updated_at),
  createdAt: Number(row.created_at),
})

const reviewOf = (row: Row): LinkReview => ({
  id: Number(row.id),
  linkableType: String(row.linkable_type),
  linkableId: Number(row.linkable_id),
  calendarId: int(row.calendar_id),
  entityType: String(row.entity_type),
  candidates: fromJson<number[]>(row.candidates),
  reason: String(row.reason),
  status: row.status as LinkReview["status"],
  chosenId: int(row.chosen_id),
  decidedBy: str(row.decided_by),
  decidedAt: int(row.decided_at),
  createdAt: Number(row.created_at),
})

const attachmentOf = (row: Row): EntryAttachment => ({
  entryId: Number(row.from_id),
  fileId: String(row.target_text).slice(driveFileTarget("").length),
  title: str(fromJson<{ title?: unknown } | null>(row.metadata)?.title),
  documentId: int(row.to_id),
})

const REVIEWS =
  "SELECT r.*, CASE WHEN r.linkable_type = 'calendar_entry' THEN " +
  "(SELECT calendar_id FROM calendar_entries WHERE id = r.linkable_id) END AS calendar_id FROM link_reviews r"

const DAY = 86_400_000

const TRACKED = ["title", "starts_at", "ends_at", "location", "status", "recurrence", "recurrence_ends_at"] as const

const flag = (value: boolean | undefined) => (value ? 1 : 0)

const cursorKey = (calendarId: number) => `calendar:${calendarId}`

const addressOf = (email: string) => email.trim().toLowerCase()

/** The `email` contact of an address: the same one mail uses, made when missing; it gets a name only when new. */
const contactOf = (context: StoreContext, email: string, name: string | null | undefined): number | null => {
  const address = addressOf(email)
  if (!/^[^\s@]+@[^\s@]+$/u.test(address)) return null
  const found = context.database
    .prepare("SELECT id FROM identities WHERE provider = 'email' AND external_id = ?")
    .get(address)
  return found ? Number(found.id) : identityOf(context, "email", address, name ?? null)
}

const logLink = (database: CacheDatabase, { type, id, entity, from, to, method, author, now }: LinkEvent): void => {
  database
    .prepare(
      "INSERT INTO entity_link_events (linkable_type, linkable_id, entity_type, from_entity_id, to_entity_id, method, " +
        "confidence, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(type, id, entity, from, to, method, author === "owner" ? 1 : null, author, now)
}

interface LinkEvent {
  type: "calendar_entry" | "meeting"
  id: number
  entity: "event" | "event_series"
  from: number | null
  to: number | null
  method: string
  author: string
  now: number
}

/** The owner's last word on a source record: once they unlinked it, no rule links it again. */
const ownerUnlinked = (database: CacheDatabase, type: string, id: number): boolean => {
  const last = database
    .prepare(
      "SELECT to_entity_id FROM entity_link_events WHERE linkable_type = ? AND linkable_id = ? AND author = 'owner' " +
        "ORDER BY id DESC LIMIT 1",
    )
    .get(type, id)
  return last !== undefined && last.to_entity_id == null
}

const distinctIds = (rows: Row[], column = "id"): number[] => [...new Set(rows.map((row) => Number(row[column])))]

const overlap = "starts_at < ? AND coalesce(ends_at, starts_at + 1) > ?"

/** The entry's time as an interval that is never empty, so a point in time still overlaps what it falls in. */
const spanOf = (entry: { startsAt: number | null; endsAt: number | null }) => {
  const start = entry.startsAt ?? 0
  return { start, end: Math.max(entry.endsAt ?? start, start + 1) }
}

export const eventStoreOver = (context: StoreContext): EventStore => {
  const { database } = context

  const entryRow = (id: number) => database.prepare("SELECT * FROM calendar_entries WHERE id = ?").get(id) as Row
  const calendarRow = (id: number) => {
    const row = database.prepare("SELECT * FROM calendars WHERE id = ?").get(id)
    if (!row) throw new CliError("not_found", `no calendar ${id} in the local store`)
    return row
  }

  /** Rule 3, then rule 4: the entities this entry may be a copy of. */
  const candidatesFor = (entry: StoredEntry): { ids: number[]; method: string } => {
    const entity = entry.kind === "series" ? "event_series_id" : "event_id"
    if (entry.icalUid) {
      const rows = database
        .prepare(
          `SELECT DISTINCT ${entity} AS id FROM calendar_entries WHERE ical_uid = ? AND calendar_id <> ? AND kind = ?
             AND deleted_at IS NULL AND ${entity} IS NOT NULL AND original_starts_at IS ?`,
        )
        .all(entry.icalUid, entry.calendarId, entry.kind, entry.originalStartsAt)
      if (rows.length) return { ids: distinctIds(rows), method: "ical-uid" }
    }
    if (entry.joinKey) {
      if (entry.kind === "series") {
        const rows = database
          .prepare(
            "SELECT DISTINCT s.id, ms.join_url FROM event_series s JOIN meeting_series ms ON ms.event_series_id = s.id " +
              "WHERE s.origin = 'auto' AND ms.deleted_at IS NULL AND ms.join_url IS NOT NULL",
          )
          .all()
          .filter((row) => joinKeyOf(str(row.join_url)) === entry.joinKey)
        return { ids: distinctIds(rows), method: "join-key" }
      }
      const { start, end } = spanOf(entry)
      const rows = database
        .prepare(
          `SELECT DISTINCT e.id FROM events e JOIN meetings m ON m.event_id = e.id
            WHERE e.origin = 'auto' AND e.deleted_at IS NULL AND m.deleted_at IS NULL AND m.join_key = ?
              AND e.${overlap}`,
        )
        .all(entry.joinKey, end, start)
      return { ids: distinctIds(rows), method: "join-key" }
    }
    return { ids: [], method: "new" }
  }

  const setEntity = (entry: StoredEntry, to: number, method: string, author: string, now: number) => {
    const column = entry.kind === "series" ? "event_series_id" : "event_id"
    const from = entry.kind === "series" ? entry.eventSeriesId : entry.eventId
    database.prepare(`UPDATE calendar_entries SET ${column} = ?, updated_at = ? WHERE id = ?`).run(to, now, entry.id)
    logLink(database, {
      type: "calendar_entry",
      id: entry.id,
      entity: entry.kind === "series" ? "event_series" : "event",
      from,
      to,
      method,
      author,
      now,
    })
  }

  const newEntity = (entry: StoredEntry, now: number): number =>
    entry.kind === "series"
      ? Number(
          database
            .prepare(
              "INSERT INTO event_series (title, recurrence, origin, created_at, updated_at) VALUES (?, ?, 'calendar', ?, ?) RETURNING id",
            )
            .get(entry.title, toJson(entry.recurrence), now, now)?.id,
        )
      : Number(
          database
            .prepare(
              "INSERT INTO events (title, starts_at, ends_at, timezone, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'calendar', ?, ?) RETURNING id",
            )
            .get(entry.title, entry.startsAt, entry.endsAt, entry.timezone, now, now)?.id,
        )

  /** Rules 3–5 for an entry with no entity yet. */
  const link = (entry: StoredEntry, now: number) => {
    const linked = entry.kind === "series" ? entry.eventSeriesId : entry.eventId
    if (linked !== null || ownerUnlinked(database, "calendar_entry", entry.id)) return
    const entity = entry.kind === "series" ? "event_series" : "event"
    const { ids, method } = candidatesFor(entry)
    if (ids.length > 1) return reviewLink(database, { type: "calendar_entry", id: entry.id }, entity, ids, method, now)
    if (ids.length === 1) {
      const [id] = ids as [number]
      setEntity(entry, id, method, "rules", now)
      if (method === "join-key")
        database
          .prepare(
            `UPDATE ${entity === "event" ? "events" : "event_series"} SET origin = 'calendar', updated_at = ? WHERE id = ?`,
          )
          .run(now, id)
      return
    }
    // A slot cancelled before it was ever stored is no event.
    if (entry.status === "cancelled") return
    setEntity(entry, newEntity(entry, now), "new", "rules", now)
  }

  /**
   * The event's fields from its preferred entry: a copy with text before one without (a busy-only slot), then the
   * owner's copy when the owner organizes, then the latest. With no live copy left, a past event stays as history
   * and a future one is cancelled.
   */
  const refreshEvent = (eventId: number, now: number) => {
    // Search reads the event's status and its copies' visibility, which no index trigger watches.
    database.prepare("INSERT OR IGNORE INTO event_index_pending (indexable_type, id) VALUES ('event', ?)").run(eventId)
    const entries = database
      .prepare(
        `SELECT ce.*, EXISTS (SELECT 1 FROM calendar_entry_participants p WHERE p.entry_id = ce.id AND p.self = 1
           AND p.organizer = 1) AS own FROM calendar_entries ce WHERE ce.event_id = ? AND ce.deleted_at IS NULL
         ORDER BY trim(coalesce(ce.title, '') || coalesce(ce.description, '') || coalesce(ce.location, '')) <> '' DESC,
           own DESC, coalesce(ce.external_updated_at, ce.updated_at) DESC, ce.id DESC`,
      )
      .all(eventId)
    const preferred = entries[0]
    const event = database.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as Row
    if (!preferred) {
      if (!event || !database.prepare("SELECT 1 FROM calendar_entries WHERE event_id = ?").get(eventId)) return
      const startsAt = int(event.starts_at)
      if (startsAt !== null && startsAt < now)
        database
          .prepare("UPDATE events SET source_deleted_at = coalesce(source_deleted_at, ?), updated_at = ? WHERE id = ?")
          .run(now, now, eventId)
      else database.prepare("UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, eventId)
      return
    }
    const cancelled = entries.every((row) => row.status === "cancelled")
    const series = preferred.series_entry_id == null ? null : entryRow(Number(preferred.series_entry_id))
    const startsAt = int(preferred.starts_at) ?? int(event.starts_at)
    // History: what was on the calendar and has passed stays as a meeting that happened (NEED-1764 A).
    const past = startsAt !== null && startsAt < now
    database
      .prepare(
        `UPDATE events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, timezone = ?,
           all_day = ?, status = ?, source_deleted_at = ?, event_series_id = coalesce(?, event_series_id), updated_at = ?
         WHERE id = ?`,
      )
      .run(
        cancelled && past ? str(event.title) : str(preferred.title),
        cancelled && past ? str(event.description) : str(preferred.description),
        cancelled && past ? str(event.location) : str(preferred.location),
        cancelled && past ? int(event.starts_at) : int(preferred.starts_at),
        cancelled && past ? int(event.ends_at) : int(preferred.ends_at),
        str(preferred.timezone),
        Number(preferred.all_day),
        cancelled ? (past ? str(event.status) : "cancelled") : String(preferred.status),
        cancelled && past ? (int(event.source_deleted_at) ?? now) : null,
        series ? int(series.event_series_id) : null,
        now,
        eventId,
      )
  }

  const refreshSeries = (seriesId: number, now: number) => {
    const preferred = database
      .prepare(
        "SELECT * FROM calendar_entries WHERE event_series_id = ? AND deleted_at IS NULL " +
          "ORDER BY coalesce(external_updated_at, updated_at) DESC, id DESC LIMIT 1",
      )
      .get(seriesId)
    if (preferred)
      database
        .prepare("UPDATE event_series SET title = ?, recurrence = ?, updated_at = ? WHERE id = ?")
        .run(str(preferred.title), str(preferred.recurrence), now, seriesId)
  }

  const saveParticipants = (entryId: number, participants: EntryParticipantInput[], now: number) => {
    const kept = new Set<string>()
    const upsert = database.prepare(
      `INSERT INTO calendar_entry_participants (entry_id, identity_id, email, name, response, optional, organizer, self,
         resource, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entry_id, email) DO UPDATE SET identity_id = excluded.identity_id, name = excluded.name,
         response = excluded.response, optional = excluded.optional, organizer = excluded.organizer,
         self = excluded.self, resource = excluded.resource, updated_at = excluded.updated_at`,
    )
    for (const one of participants) {
      const email = addressOf(one.email)
      if (!email || kept.has(email)) continue
      kept.add(email)
      upsert.run(
        entryId,
        one.resource ? null : contactOf(context, email, one.name),
        email,
        one.name ?? null,
        one.response ?? null,
        flag(one.optional),
        flag(one.organizer),
        flag(one.self),
        flag(one.resource),
        now,
        now,
      )
    }
    const stale = database
      .prepare("SELECT email FROM calendar_entry_participants WHERE entry_id = ?")
      .all(entryId)
      .map((row) => String(row.email))
      .filter((email) => !kept.has(email))
    const drop = database.prepare("DELETE FROM calendar_entry_participants WHERE entry_id = ? AND email = ?")
    for (const email of stale) drop.run(entryId, email)
  }

  /**
   * The entry's Drive files as `attached` links: the list given replaces the one held. A link still waiting for its
   * document tries again, since the file may have become one account's since.
   */
  const saveAttachments = (entryId: number, attachments: EntryAttachmentInput[], now: number) => {
    const held = new Map(
      database
        .prepare(
          "SELECT id, target_text, to_id FROM links WHERE from_type = 'calendar_entry' AND from_id = ? AND kind = 'attached'",
        )
        .all(entryId)
        .map((row) => [String(row.target_text), { id: Number(row.id), documentId: int(row.to_id) }]),
    )
    const insert = database.prepare(
      `INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, target_text, metadata, confirmed, author,
         created_at, updated_at) VALUES ('calendar_entry', ?, 'document', ?, 'attached', 'calendar', ?, ?, 1, 'rule', ?, ?)`,
    )
    const retitle = database.prepare("UPDATE links SET metadata = ?, updated_at = ? WHERE id = ? AND metadata IS NOT ?")
    const resolve = database.prepare("UPDATE links SET to_id = ?, updated_at = ? WHERE id = ?")
    const handled = new Set<string>()
    for (const { fileId, title } of attachments) {
      const file = fileId.trim()
      const target = driveFileTarget(file)
      if (!file || handled.has(target)) continue
      handled.add(target)
      const metadata = title ? JSON.stringify({ title }) : null
      const link = held.get(target)
      if (link === undefined) insert.run(entryId, driveDocumentOf(database, file), target, metadata, now, now)
      else {
        retitle.run(metadata, now, link.id, metadata)
        const document = link.documentId === null ? driveDocumentOf(database, file) : null
        if (document !== null) resolve.run(document, now, link.id)
      }
      held.delete(target)
    }
    const drop = database.prepare("DELETE FROM links WHERE id = ?")
    for (const { id } of held.values()) drop.run(id)
  }

  /** Rules 1 and 2: the row this entry already is, if any. */
  const existingFor = (calendarId: number, input: EntryInput, seriesEntryId: number | null): Row | undefined => {
    const same = database
      .prepare("SELECT * FROM calendar_entries WHERE calendar_id = ? AND external_id = ?")
      .get(calendarId, input.externalId)
    if (same || input.kind !== "occurrence" || input.originalStartsAt == null) return same
    if (seriesEntryId !== null)
      return database
        .prepare("SELECT * FROM calendar_entries WHERE series_entry_id = ? AND original_starts_at = ?")
        .get(seriesEntryId, input.originalStartsAt)
    return database
      .prepare(
        "SELECT * FROM calendar_entries WHERE calendar_id = ? AND series_entry_id IS NULL AND original_starts_at = ? " +
          "AND series_external_id = ?",
      )
      .get(calendarId, input.originalStartsAt, input.seriesExternalId ?? null)
  }

  const saveEntry = (calendarId: number, input: EntryInput, now: number): StoredEntry => {
    if (input.startsAt != null && input.endsAt != null && input.endsAt < input.startsAt)
      throw new CliError("validation_error", `calendar entry ${input.externalId} ends before it starts`)
    const series =
      input.kind === "occurrence" && input.seriesExternalId
        ? database
            .prepare("SELECT * FROM calendar_entries WHERE calendar_id = ? AND external_id = ? AND kind = 'series'")
            .get(calendarId, input.seriesExternalId)
        : undefined
    const seriesEntryId = series ? Number(series.id) : null
    const joinUrl = joinUrlWithoutQuery(input.joinUrl)
    const values = {
      kind: input.kind,
      series_entry_id: seriesEntryId,
      series_external_id: input.kind === "occurrence" ? (input.seriesExternalId ?? null) : null,
      external_id: input.externalId,
      ical_uid: input.icalUid ?? null,
      original_starts_at: input.originalStartsAt ?? null,
      exception: flag(input.exception),
      status: input.status,
      title: calendarText(input.title, { dropSecretLines: false }),
      description: calendarText(input.description),
      location: calendarText(input.location),
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      all_day: flag(input.allDay),
      start_date: input.startDate ?? null,
      end_date: input.endDate ?? null,
      timezone: input.timezone ?? null,
      recurrence: toJson(input.recurrence ?? null),
      recurrence_ends_at: input.recurrenceEndsAt ?? null,
      event_type: input.eventType ?? null,
      transparency: input.transparency ?? null,
      visibility: input.visibility ?? null,
      own_response: input.ownResponse ?? null,
      organizer_identity_id: input.organizer ? contactOf(context, input.organizer.email, input.organizer.name) : null,
      join_url: joinUrl,
      join_key: joinUrl ? (joinKeyOf(joinUrl) ?? "") : null,
      conference: input.conference ?? null,
      url: input.url ?? null,
      sequence: input.sequence ?? null,
      etag: input.etag ?? null,
      external_updated_at: input.externalUpdatedAt ?? null,
      metadata: toJson(entryMetadata(input.metadata)),
      seen_at: now,
      deleted_at: null,
    }
    const found = existingFor(calendarId, input, seriesEntryId)
    let id: number
    if (found) {
      id = Number(found.id)
      if (TRACKED.some((key) => found[key] !== values[key]))
        database
          .prepare(
            `INSERT INTO calendar_entry_revisions (entry_id, title, starts_at, ends_at, location, status, recurrence,
               recurrence_ends_at, external_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            str(found.title),
            int(found.starts_at),
            int(found.ends_at),
            str(found.location),
            str(found.status),
            str(found.recurrence),
            int(found.recurrence_ends_at),
            int(found.external_updated_at),
            now,
          )
      // Rule 2 found the slot's row under another id; rule 1 found none under this one, so it is free to take.
      database
        .prepare(
          `UPDATE calendar_entries SET ${Object.keys(values)
            .map((key) => `${key} = ?`)
            .join(", ")}, updated_at = ? WHERE id = ?`,
        )
        .run(...(Object.values(values) as (string | number | null)[]), now, id)
    } else {
      const columns = Object.keys(values)
      id = Number(
        database
          .prepare(
            `INSERT INTO calendar_entries (calendar_id, ${columns.join(", ")}, created_at, updated_at)
             VALUES (?, ${columns.map(() => "?").join(", ")}, ?, ?) RETURNING id`,
          )
          .get(calendarId, ...(Object.values(values) as (string | number | null)[]), now, now)?.id,
      )
    }
    if (input.participants) saveParticipants(id, input.participants, now)
    if (input.attachments) saveAttachments(id, input.attachments, now)
    if (input.kind === "series")
      database
        .prepare(
          "UPDATE calendar_entries SET series_entry_id = ?, updated_at = ? WHERE calendar_id = ? AND kind = 'occurrence' " +
            "AND series_entry_id IS NULL AND series_external_id = ?",
        )
        .run(id, now, calendarId, input.externalId)
    return entryOf(entryRow(id))
  }

  const cancel = (row: Row, now: number) => {
    database
      .prepare(
        `INSERT INTO calendar_entry_revisions (entry_id, title, starts_at, ends_at, location, status, recurrence,
           recurrence_ends_at, external_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Number(row.id),
        str(row.title),
        int(row.starts_at),
        int(row.ends_at),
        str(row.location),
        str(row.status),
        str(row.recurrence),
        int(row.recurrence_ends_at),
        int(row.external_updated_at),
        now,
      )
    database
      .prepare("UPDATE calendar_entries SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now, Number(row.id))
  }

  /** A series cancelled at the provider cancels its occurrences: past ones stay as history, future ones cancel. */
  const cancelOccurrences = (seriesEntryId: number, now: number) => {
    const occurrences = database
      .prepare(
        "SELECT * FROM calendar_entries WHERE series_entry_id = ? AND status <> 'cancelled' AND deleted_at IS NULL",
      )
      .all(seriesEntryId)
    for (const row of occurrences) cancel(row, now)
  }

  /** The events and series of these entries and of their occurrences take their fields again. */
  const refreshAround = (entryIds: number[], now: number) => {
    const ids = JSON.stringify(entryIds)
    const touched = database
      .prepare(
        `SELECT DISTINCT ce.event_id, ce.event_series_id FROM calendar_entries ce
          WHERE ce.id IN (SELECT value FROM json_each(?)) OR ce.series_entry_id IN (SELECT value FROM json_each(?))`,
      )
      .all(ids, ids)
    for (const row of touched) {
      if (row.event_series_id != null) refreshSeries(Number(row.event_series_id), now)
      if (row.event_id != null) refreshEvent(Number(row.event_id), now)
    }
  }

  return {
    saveCalendars: async (accountId, calendars, now) =>
      write(database, () => {
        const upsert = database.prepare(
          `INSERT INTO calendars (account_id, external_id, title, timezone, access_role, primary_calendar, synced, seen_at,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, external_id) DO UPDATE SET title = excluded.title, timezone = excluded.timezone,
             access_role = excluded.access_role, primary_calendar = excluded.primary_calendar, seen_at = excluded.seen_at,
             deleted_at = NULL, updated_at = excluded.updated_at
           RETURNING *`,
        )
        return calendars.map((one) =>
          calendarOf(
            upsert.get(
              accountId,
              one.externalId,
              one.title,
              one.timezone,
              one.accessRole,
              flag(one.primary),
              flag(one.syncByDefault),
              now,
              now,
              now,
            ) as Row,
          ),
        )
      }),
    calendars: async (accountId) =>
      database
        .prepare("SELECT * FROM calendars WHERE account_id = ? ORDER BY primary_calendar DESC, title, id")
        .all(accountId)
        .map(calendarOf),
    setCalendarSynced: async (calendarId, synced, now) =>
      write(database, () => {
        calendarRow(calendarId)
        database
          .prepare("UPDATE calendars SET synced = ?, updated_at = ? WHERE id = ?")
          .run(flag(synced), now, calendarId)
      }),
    saveEntries: async (calendarId, entries, now) =>
      write(database, () => {
        calendarRow(calendarId)
        // A series first, so an occurrence in the same page finds it.
        const ordered = [...entries].sort((a, b) => Number(b.kind === "series") - Number(a.kind === "series"))
        const ids = new Map<EntryInput, number>()
        const saved = ordered.map((input) => {
          const entry = saveEntry(calendarId, input, now)
          ids.set(input, entry.id)
          return entry
        })
        for (const entry of saved)
          if (entry.kind === "series" && entry.status === "cancelled") cancelOccurrences(entry.id, now)
        const current = saved.map(({ id }) => entryOf(entryRow(id)))
        for (const entry of current) link(entry, now)
        refreshAround(
          current.map(({ id }) => id),
          now,
        )
        return entries.map((input) => entryOf(entryRow(ids.get(input) as number)))
      }),
    removeEntries: async (calendarId, externalIds, now) =>
      write(database, () => {
        calendarRow(calendarId)
        const removed = database
          .prepare(
            `SELECT * FROM calendar_entries WHERE calendar_id = ? AND external_id IN (SELECT value FROM json_each(?))
               AND status <> 'cancelled' AND deleted_at IS NULL`,
          )
          .all(calendarId, JSON.stringify(externalIds))
        for (const row of removed) {
          cancel(row, now)
          database.prepare("UPDATE calendar_entries SET seen_at = ? WHERE id = ?").run(now, Number(row.id))
          if (row.kind === "series") cancelOccurrences(Number(row.id), now)
        }
        refreshAround(
          removed.map((row) => Number(row.id)),
          now,
        )
        return removed.length
      }),
    markUnseen: async (calendarId, seenBefore, window, now) =>
      write(database, () => {
        const marked = database
          .prepare(
            `SELECT * FROM calendar_entries WHERE calendar_id = ? AND deleted_at IS NULL AND (seen_at IS NULL OR seen_at < ?)
               AND min(coalesce(starts_at, original_starts_at), coalesce(original_starts_at, starts_at)) < ? AND (kind = 'series'
                 OR max(coalesce(ends_at, 0), coalesce(starts_at, 0) + 1, coalesce(original_starts_at, 0)) >= ?)`,
          )
          .all(calendarId, seenBefore, window.to, window.from)
          .filter((row) => entryInWindow(entryOf(row), window))
        const mark = database.prepare("UPDATE calendar_entries SET deleted_at = ?, updated_at = ? WHERE id = ?")
        for (const row of marked) mark.run(now, now, Number(row.id))
        for (const eventId of new Set(marked.map((row) => int(row.event_id))))
          if (eventId !== null) refreshEvent(eventId, now)
        return marked.length
      }),
    restoreUnseen: async (calendarId, windowAt, now) =>
      write(database, () => {
        const restored = database
          .prepare("SELECT * FROM calendar_entries WHERE calendar_id = ? AND deleted_at IS NOT NULL")
          .all(calendarId)
          .map(entryOf)
          .filter((entry) => !entryInWindow(entry, windowAt(entry.deletedAt as number)))
        const restore = database.prepare("UPDATE calendar_entries SET deleted_at = NULL, updated_at = ? WHERE id = ?")
        for (const { id } of restored) restore.run(now, id)
        refreshAround(
          restored.map(({ id }) => id),
          now,
        )
        return restored.length
      }),
    entry: async (calendarId, externalId) =>
      read(database, () => {
        const row = database
          .prepare("SELECT * FROM calendar_entries WHERE calendar_id = ? AND external_id = ?")
          .get(calendarId, externalId) as Row | undefined
        return row ? entryOf(row) : null
      }),
    slotsOf: async (calendarId, seriesExternalId, window) =>
      read(database, () =>
        database
          .prepare(
            `SELECT * FROM calendar_entries WHERE calendar_id = ? AND kind = 'occurrence' AND series_external_id = ?
               AND original_starts_at >= ? AND original_starts_at < ? AND deleted_at IS NULL ORDER BY original_starts_at`,
          )
          .all(calendarId, seriesExternalId, window.from, window.to)
          .map(entryOf),
      ),
    cursor: async (calendarId) =>
      read(database, () => {
        const { account_id } = calendarRow(calendarId)
        return str(
          database
            .prepare("SELECT value FROM sync_cursors WHERE account_id = ? AND key = ?")
            .get(Number(account_id), cursorKey(calendarId))?.value,
        )
      }),
    setCursor: async (calendarId, value, now) =>
      write(database, () => {
        const accountId = Number(calendarRow(calendarId).account_id)
        if (value === null)
          database
            .prepare("DELETE FROM sync_cursors WHERE account_id = ? AND key = ?")
            .run(accountId, cursorKey(calendarId))
        else
          database
            .prepare(
              `INSERT INTO sync_cursors (account_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(accountId, cursorKey(calendarId), value, now, now)
      }),
    events: async (filter: EventFilter = {}) => {
      const clauses = ["e.deleted_at IS NULL"]
      const params: (string | number)[] = []
      const entries = (extra: string) =>
        `EXISTS (SELECT 1 FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id WHERE ce.event_id = e.id AND ${extra})`
      const dated = (column: string, date: string | undefined, instant: string, at: number | undefined) => {
        if (at === undefined) return
        if (date === undefined) {
          clauses.push(instant)
          params.push(at)
          return
        }
        clauses.push(
          `(CASE WHEN e.all_day = 1 THEN EXISTS (SELECT 1 FROM calendar_entries ce WHERE ce.event_id = e.id AND ce.${column}) ELSE ${instant} END)`,
        )
        params.push(date, at)
      }
      dated("end_date > ?", filter.fromDate, "coalesce(e.ends_at, e.starts_at + 1) > ?", filter.from)
      dated("start_date < ?", filter.toDate, "e.starts_at < ?", filter.to)
      // Bounds on starts_at alone let SQLite seek its index; the CASE above cannot. They are wider than the CASE: by the
      // longest stored event back, and by a day each way for an all-day event's zone.
      if (filter.from !== undefined) {
        const longest = Number(
          database
            .prepare("SELECT coalesce(max(ends_at - starts_at), 0) AS ms FROM events WHERE deleted_at IS NULL")
            .get()?.ms ?? 0,
        )
        clauses.push("e.starts_at >= ?")
        params.push(filter.from - longest - DAY)
      }
      if (filter.to !== undefined && filter.toDate !== undefined) {
        clauses.push("e.starts_at < ?")
        params.push(filter.to + DAY)
      }
      if (filter.calendarId !== undefined) {
        clauses.push(entries("ce.calendar_id = ?"))
        params.push(filter.calendarId)
      }
      if (filter.accountId !== undefined) {
        clauses.push(entries("c.account_id = ?"))
        params.push(filter.accountId)
      }
      if (filter.personId !== undefined) {
        clauses.push(
          entries(
            "EXISTS (SELECT 1 FROM calendar_entry_participants p JOIN identity_links il ON il.identity_id = p.identity_id " +
              "WHERE p.entry_id = ce.id AND il.person_id = ?)",
          ),
        )
        params.push(filter.personId)
      }
      const limit = filter.limit ?? 100
      const offset = filter.offset ?? 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
        throw new CliError("validation_error", "limit takes 1–1000 and offset 0 or more")
      return database
        .prepare(
          `SELECT e.* FROM events e WHERE ${clauses.join(" AND ")} ORDER BY ${filter.newest ? "e.starts_at DESC, e.id DESC" : "e.starts_at, e.id"} LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
        .map(eventOf)
    },
    event: async (id) =>
      read(database, (): EventDetails | null => {
        const row = database.prepare("SELECT * FROM events WHERE id = ?").get(id)
        if (!row) return null
        const entries = database
          .prepare("SELECT * FROM calendar_entries WHERE event_id = ? ORDER BY id")
          .all(id)
          .map(entryOf)
        const ids = JSON.stringify(entries.map((entry) => entry.id))
        return {
          event: eventOf(row),
          entries,
          participants: database
            .prepare(
              "SELECT * FROM calendar_entry_participants WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id, email",
            )
            .all(ids)
            .map(participantOf),
          revisions: database
            .prepare(
              "SELECT * FROM calendar_entry_revisions WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id",
            )
            .all(ids)
            .map(revisionOf),
          attachments: database
            .prepare(
              "SELECT l.from_id, l.target_text, CASE WHEN d.deleted_at IS NULL THEN l.to_id END AS to_id, l.metadata " +
                "FROM links l LEFT JOIN documents d ON d.id = l.to_id WHERE l.from_type = 'calendar_entry' " +
                "AND l.kind = 'attached' AND l.from_id IN (SELECT value FROM json_each(?)) ORDER BY l.from_id, l.id",
            )
            .all(ids)
            .map(attachmentOf),
        }
      }),
    participantsOf: async (eventIds, calendarIds) =>
      read(database, () =>
        database
          .prepare(
            `SELECT p.*, ce.event_id FROM calendar_entry_participants p JOIN calendar_entries ce ON ce.id = p.entry_id
              WHERE ce.event_id IN (SELECT value FROM json_each(?)) AND ce.calendar_id IN (SELECT value FROM json_each(?))
              ORDER BY ce.event_id, p.entry_id, p.email`,
          )
          .all(JSON.stringify(eventIds), JSON.stringify(calendarIds))
          .map((row) => ({ ...participantOf(row), eventId: Number(row.event_id) })),
      ),
    linkEntry: async (entryId, eventId, now) =>
      write(database, () => {
        const row = database.prepare("SELECT * FROM calendar_entries WHERE id = ?").get(entryId)
        if (!row) throw new CliError("not_found", `no calendar entry ${entryId} in the local store`)
        const entry = entryOf(row)
        const table = entry.kind === "series" ? "event_series" : "events"
        if (!database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(eventId))
          throw new CliError("not_found", `no ${entry.kind === "series" ? "event series" : "event"} ${eventId}`)
        setEntity(entry, eventId, "owner", "owner", now)
        if (entry.kind !== "series") refreshEvent(eventId, now)
      }),
    unlinkEntry: async (entryId, now) =>
      write(database, () => {
        const row = database.prepare("SELECT * FROM calendar_entries WHERE id = ?").get(entryId)
        if (!row) throw new CliError("not_found", `no calendar entry ${entryId} in the local store`)
        const entry = entryOf(row)
        const column = entry.kind === "series" ? "event_series_id" : "event_id"
        database.prepare(`UPDATE calendar_entries SET ${column} = NULL, updated_at = ? WHERE id = ?`).run(now, entryId)
        logLink(database, {
          type: "calendar_entry",
          id: entryId,
          entity: entry.kind === "series" ? "event_series" : "event",
          from: entry.kind === "series" ? entry.eventSeriesId : entry.eventId,
          to: null,
          method: "owner",
          author: "owner",
          now,
        })
      }),
    reviews: async (filter = {}) =>
      database
        .prepare(`${REVIEWS}${filter.status ? " WHERE r.status = ?" : ""} ORDER BY r.created_at, r.id`)
        .all(...(filter.status ? [filter.status] : []))
        .map(reviewOf),
    resolveReview: async (id, decision, now) =>
      write(database, () => {
        const row = database.prepare(`${REVIEWS} WHERE r.id = ?`).get(id)
        if (!row) throw new CliError("not_found", `no review ${id} in the local store`)
        const review = reviewOf(row)
        if (review.status !== "open") throw new CliError("validation_error", `review ${id} is already ${review.status}`)
        if ("choose" in decision && !review.candidates.includes(decision.choose))
          throw new CliError("validation_error", `${decision.choose} is not one of review ${id}'s candidates`)
        const chosen = "choose" in decision ? decision.choose : null
        if (chosen !== null && review.linkableType === "calendar_entry") {
          setEntity(entryOf(entryRow(review.linkableId)), chosen, "owner", "owner", now)
          if (review.entityType === "event") refreshEvent(chosen, now)
        }
        if (chosen !== null && review.linkableType === "meeting") {
          database
            .prepare("UPDATE meetings SET event_id = ?, updated_at = ? WHERE id = ?")
            .run(chosen, now, review.linkableId)
          logLink(database, {
            type: "meeting",
            id: review.linkableId,
            entity: "event",
            from: null,
            to: chosen,
            method: "owner",
            author: "owner",
            now,
          })
        }
        if (chosen !== null && review.linkableType === "file") {
          // The document made for the file while the choice was open goes when nothing else holds it.
          const file = database.prepare("SELECT document_id FROM files WHERE id = ?").get(review.linkableId)
          const made = file?.document_id == null ? null : Number(file.document_id)
          database
            .prepare("UPDATE files SET document_id = ?, updated_at = ? WHERE id = ?")
            .run(chosen, now, review.linkableId)
          logFileLink(database, now, review.linkableId, made, chosen, "owner", "owner")
          if (made !== null && made !== chosen)
            database
              .prepare(
                "UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND NOT EXISTS " +
                  "(SELECT 1 FROM files WHERE document_id = ? AND deleted_at IS NULL)",
              )
              .run(now, now, made, made)
        }
        if (chosen === null && review.linkableType === "calendar_entry") {
          const entry = entryOf(entryRow(review.linkableId))
          setEntity(entry, newEntity(entry, now), "owner", "owner", now)
        }
        if (chosen === null && review.linkableType === "meeting") {
          const event = Number(
            database
              .prepare(
                `INSERT INTO events (title, description, location, starts_at, ends_at, timezone, origin, created_at, updated_at)
                 SELECT title, description, location, started_at, ended_at, timezone, 'auto', ?, ? FROM meetings WHERE id = ?
                 RETURNING id`,
              )
              .get(now, now, review.linkableId)?.id,
          )
          database
            .prepare("UPDATE meetings SET event_id = ?, updated_at = ? WHERE id = ?")
            .run(event, now, review.linkableId)
          logLink(database, {
            type: "meeting",
            id: review.linkableId,
            entity: "event",
            from: null,
            to: event,
            method: "owner",
            author: "owner",
            now,
          })
        }
        database
          .prepare(
            "UPDATE link_reviews SET status = ?, chosen_id = ?, decided_by = 'owner', decided_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(chosen === null ? "apart" : "linked", chosen, now, now, id)
        return reviewOf(database.prepare(`${REVIEWS} WHERE r.id = ?`).get(id) as Row)
      }),
  }
}
