import type { CacheDatabase } from "../driver.js"
import { dropOrphanPeople, unreferenced } from "./accounts.js"
import { forgetDanglingEvidence, forgetEvidenceTo } from "./evidence-signature.js"
import { dropUnusedVectors } from "./vector-index.js"

const distinctIds = (rows: Record<string, unknown>[]): number[] => [...new Set(rows.map((row) => Number(row.id)))]

/**
 * `EventStore.forgetCalendar` inside its transaction: children before parents, since the foreign keys are enforced.
 * `refresh` gives a kept event or series its fields again from the copies left.
 */
export const forgetCalendarRows = (
  database: CacheDatabase,
  { calendarId, accountId, cursorKey, now }: { calendarId: number; accountId: number; cursorKey: string; now: number },
  refresh: { event: (id: number, now: number) => void; series: (id: number, now: number) => void },
): { entries: number; events: number } => {
  const unseenBefore = unreferenced(database, "identities")
  const ids = (sql: string) => distinctIds(database.prepare(sql).all(calendarId))
  const entryIds = ids("SELECT id FROM calendar_entries WHERE calendar_id = ?")
  const eventIds = ids("SELECT event_id AS id FROM calendar_entries WHERE calendar_id = ? AND event_id IS NOT NULL")
  const seriesIds = ids(
    "SELECT event_series_id AS id FROM calendar_entries WHERE calendar_id = ? AND event_series_id IS NOT NULL",
  )
  const hashes: string[] = []
  const dropAround = (type: string, list: number[]) => {
    const json = JSON.stringify(list)
    const inList = "IN (SELECT value FROM json_each(?))"
    for (const row of database
      .prepare(`SELECT DISTINCT content_hash FROM chunks WHERE chunkable_type = ? AND chunkable_id ${inList}`)
      .all(type, json))
      hashes.push(String(row.content_hash))
    database.prepare(`DELETE FROM chunks WHERE chunkable_type = ? AND chunkable_id ${inList}`).run(type, json)
    database
      .prepare(`DELETE FROM links WHERE (from_type = ? AND from_id ${inList}) OR (to_type = ? AND to_id ${inList})`)
      .run(type, json, type, json)
    for (const [table, pointer] of [
      ["taggings", "taggable"],
      ["aliases", "aliasable"],
      ["attachments", "attachable"],
      ["link_reviews", "linkable"],
      ["entity_link_events", "linkable"],
    ])
      database.prepare(`DELETE FROM ${table} WHERE ${pointer}_type = ? AND ${pointer}_id ${inList}`).run(type, json)
  }
  const entries = JSON.stringify(entryIds)
  for (const table of ["calendar_entry_participants", "calendar_entry_revisions"])
    database.prepare(`DELETE FROM ${table} WHERE entry_id IN (SELECT value FROM json_each(?))`).run(entries)
  dropAround("calendar_entry", entryIds)
  // Occurrences point at their series in the same table: the pointers go first, so the order of rows is free.
  database.prepare("UPDATE calendar_entries SET series_entry_id = NULL WHERE calendar_id = ?").run(calendarId)
  database.prepare("DELETE FROM calendar_entries WHERE calendar_id = ?").run(calendarId)

  const held = (column: string, id: number) =>
    database.prepare(`SELECT 1 FROM calendar_entries WHERE ${column} = ? LIMIT 1`).get(id) !== undefined
  const goneSeries = seriesIds.filter((id) => !held("event_series_id", id))
  const goneEvents = eventIds.filter((id) => !held("event_id", id))
  const gone = (list: number[]) => JSON.stringify(list)
  database
    .prepare("UPDATE meetings SET event_id = NULL, updated_at = ? WHERE event_id IN (SELECT value FROM json_each(?))")
    .run(now, gone(goneEvents))
  forgetEvidenceTo(database, "event", { sql: "SELECT value FROM json_each(?)", params: [gone(goneEvents)] }, now)
  dropAround("event", goneEvents)
  database.prepare("DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))").run(gone(goneEvents))
  for (const table of ["meeting_series", "events"])
    database
      .prepare(
        `UPDATE ${table} SET event_series_id = NULL, updated_at = ? WHERE event_series_id IN (SELECT value FROM json_each(?))`,
      )
      .run(now, gone(goneSeries))
  dropAround("event_series", goneSeries)
  database.prepare("DELETE FROM event_series WHERE id IN (SELECT value FROM json_each(?))").run(gone(goneSeries))
  for (const id of seriesIds) if (!goneSeries.includes(id)) refresh.series(id, now)
  for (const id of eventIds) if (!goneEvents.includes(id)) refresh.event(id, now)

  database.prepare("DELETE FROM sync_cursors WHERE account_id = ? AND key = ?").run(accountId, cursorKey)
  database.prepare("DELETE FROM calendars WHERE id = ?").run(calendarId)
  dropOrphanPeople(database, unseenBefore)
  forgetDanglingEvidence(database, now)
  dropUnusedVectors(database, hashes)
  return { entries: entryIds.length, events: goneEvents.length }
}
