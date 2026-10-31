import { CliError } from "@wirecat/cli-base"
import type { Event, EventFilter } from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { eventOf } from "./events.js"

const DAY = 86_400_000

/** The events of a filter, earliest first (`EventStore.events`). */
export const listEvents = (database: CacheDatabase, filter: EventFilter): Event[] => {
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
  dated("start_date >= ?", filter.startsFromDate, "e.starts_at >= ?", filter.startsFrom)
  // Bounds on starts_at alone let SQLite seek its index; the CASE above cannot. They are wider than the CASE: by the
  // longest stored event back, and by a day each way for an all-day event's zone.
  const longest = () =>
    Number(
      database.prepare("SELECT coalesce(max(ends_at - starts_at), 0) AS ms FROM events WHERE deleted_at IS NULL").get()
        ?.ms ?? 0,
    )
  if (filter.from !== undefined) {
    clauses.push("e.starts_at >= ?")
    params.push(filter.from - longest() - DAY)
  }
  if (filter.to !== undefined && filter.toDate !== undefined) {
    clauses.push("e.starts_at < ?")
    params.push(filter.to + DAY)
  }
  if (filter.startsFrom !== undefined && filter.startsFromDate !== undefined) {
    clauses.push("e.starts_at >= ?")
    params.push(filter.startsFrom - DAY)
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
  const account = (alias: string) => {
    if (filter.accountId === undefined) return ""
    params.push(filter.accountId)
    return ` AND ${alias}.account_id = ?`
  }
  if (filter.changedSince !== undefined) {
    // The SQL form of eventChange: first stored since, cancelled since, or a live copy's time changed since.
    const since = filter.changedSince
    const own = account("c")
    params.push(since)
    const older = account("oc")
    params.push(since, since, since, since)
    clauses.push(
      `EXISTS (SELECT 1 FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id WHERE ce.event_id = e.id${own}
         AND ((ce.created_at >= ? AND NOT EXISTS (SELECT 1 FROM calendar_entries o JOIN calendars oc
                 ON oc.id = o.calendar_id WHERE o.event_id = e.id${older} AND o.created_at < ?))
           OR ((e.status = 'cancelled' OR e.source_deleted_at IS NOT NULL) AND (ce.deleted_at >= ?
             OR (ce.status = 'cancelled' AND EXISTS (SELECT 1 FROM calendar_entry_revisions r WHERE r.entry_id = ce.id
               AND r.created_at >= ? AND r.status IS NOT 'cancelled'))))
           OR (ce.deleted_at IS NULL AND ce.status <> 'cancelled' AND (SELECT r.starts_at IS NOT ce.starts_at
             OR r.ends_at IS NOT ce.ends_at FROM calendar_entry_revisions r WHERE r.entry_id = ce.id AND r.created_at >= ?
             ORDER BY r.created_at, r.id LIMIT 1) = 1)))`,
    )
  }
  if (filter.overlapping) {
    const busy = (event: string) =>
      `${event}.deleted_at IS NULL AND ${event}.status <> 'cancelled' AND ${event}.all_day = 0
         AND ${event}.starts_at IS NOT NULL AND ${event}.ends_at IS NOT NULL AND EXISTS (SELECT 1 FROM calendar_entries
           bce JOIN calendars bc ON bc.id = bce.calendar_id WHERE bce.event_id = ${event}.id${account("bc")}
           AND bce.deleted_at IS NULL AND bce.status <> 'cancelled' AND coalesce(bce.own_response, '') <> 'declined'
           AND coalesce(bce.transparency, '') <> 'transparent')`
    const own = busy("e")
    params.push(longest())
    clauses.push(
      `${own} AND EXISTS (SELECT 1 FROM events e2 WHERE e2.id <> e.id AND e2.starts_at < e.ends_at
         AND e2.ends_at > e.starts_at AND e2.starts_at >= e.starts_at - ? AND ${busy("e2")})`,
    )
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
}
