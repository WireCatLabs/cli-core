import type { QueryAst } from "@wirecat/cli-base/query"
import type { Event, EventCandidateFilter, EventSeries, NewRecord } from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { queryFilter } from "./query-filter.js"

/** JSON columns keep a missing value as SQL NULL, never the text `null`, so a read gives back what was saved. */
export const toJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value)
export const fromJson = <T>(value: unknown): T =>
  (value === null || value === undefined ? null : JSON.parse(String(value))) as T
export const int = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
export const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
export const flag = (value: boolean | null | undefined): number | null =>
  value === null || value === undefined ? null : value ? 1 : 0
export const bool = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : Number(value) === 1

/** SQLite reads `LIMIT -1` as no limit, so a bad page is refused here. */
export const page = (filter: { limit?: number; offset?: number }): [number, number] => {
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0))
    throw new Error("Invalid limit")
  if (filter.offset !== undefined && (!Number.isInteger(filter.offset) || filter.offset < 0))
    throw new Error("Invalid offset")
  return [filter.limit ?? -1, filter.offset ?? 0]
}

const eventOf = (row: Record<string, unknown>): Event => ({
  id: Number(row.id),
  eventSeriesId: int(row.event_series_id),
  title: str(row.title),
  description: str(row.description),
  location: str(row.location),
  startsAt: int(row.starts_at),
  endsAt: int(row.ends_at),
  timezone: str(row.timezone),
  origin: String(row.origin) as Event["origin"],
  deletedAt: int(row.deleted_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const seriesOf = (row: Record<string, unknown>): EventSeries => ({
  id: Number(row.id),
  title: str(row.title),
  recurrence: str(row.recurrence),
  origin: String(row.origin) as EventSeries["origin"],
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const exists = (database: CacheDatabase, table: string, id: number) =>
  database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined

export const events = (database: CacheDatabase, query?: QueryAst): Event[] => {
  const where =
    query &&
    queryFilter(query, {
      id: { type: "num", sql: "id" },
      origin: { type: "enum", sql: "origin" },
      starts_at: { type: "time", sql: "starts_at" },
      ends_at: { type: "time", sql: "ends_at" },
      created_at: { type: "time", sql: "created_at" },
      updated_at: { type: "time", sql: "updated_at" },
    })
  return database
    .prepare(`SELECT * FROM events WHERE deleted_at IS NULL${where ? ` AND (${where.sql})` : ""} ORDER BY id`)
    .all(...(where?.params ?? []))
    .map(eventOf)
}

/** An event without an end occupies its start instant. */
export const eventCandidates = (database: CacheDatabase, filter: EventCandidateFilter): Event[] =>
  database
    .prepare(
      `SELECT e.* FROM events e
        WHERE e.deleted_at IS NULL AND e.starts_at IS NOT NULL
          AND e.starts_at <= ? AND coalesce(e.ends_at, e.starts_at) >= ?
          AND (e.event_series_id IN (SELECT event_series_id FROM meeting_series WHERE id = ?)
            OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM meetings m
              WHERE m.event_id = e.id AND m.deleted_at IS NULL AND m.join_url = ?)))
        ORDER BY e.id`,
    )
    .all(filter.endsAt, filter.startsAt, filter.meetingSeriesId, filter.joinUrl, filter.joinUrl)
    .map(eventOf)

export const createEvent = (database: CacheDatabase, input: NewRecord<Event>, now: number): Event => {
  if (input.eventSeriesId !== null && !exists(database, "event_series", input.eventSeriesId))
    throw new Error("Event series not found")
  const row = database
    .prepare(
      `INSERT INTO events (event_series_id, title, description, location, starts_at, ends_at, timezone, origin,
         created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.eventSeriesId,
      input.title,
      input.description,
      input.location,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.origin,
      now,
      now,
      input.deletedAt,
    )
  return eventOf(row as Record<string, unknown>)
}

export const createEventSeries = (database: CacheDatabase, input: NewRecord<EventSeries>, now: number): EventSeries =>
  seriesOf(
    database
      .prepare(
        "INSERT INTO event_series (title, recurrence, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(input.title, input.recurrence, input.origin, now, now) as Record<string, unknown>,
  )

export const setEventSeries = (
  database: CacheDatabase,
  meetingSeriesId: number,
  eventSeriesId: number,
  now: number,
) => {
  if (!exists(database, "meeting_series", meetingSeriesId) || !exists(database, "event_series", eventSeriesId))
    throw new Error("Series not found")
  database
    .prepare("UPDATE meeting_series SET event_series_id = ?, updated_at = ? WHERE id = ?")
    .run(eventSeriesId, now, meetingSeriesId)
}

/** An automatic link never replaces an existing one; the owner's always does. */
export const linkMeeting = (
  database: CacheDatabase,
  id: number,
  eventId: number,
  now: number,
  mode: "auto" | "owner" = "auto",
) => {
  if (!exists(database, "meetings", id)) throw new Error("Meeting not found")
  if (!exists(database, "events", eventId)) throw new Error("Event not found")
  database
    .prepare(
      `UPDATE meetings SET event_id = ?, updated_at = ? WHERE id = ?${mode === "owner" ? "" : " AND event_id IS NULL"}`,
    )
    .run(eventId, now, id)
}
