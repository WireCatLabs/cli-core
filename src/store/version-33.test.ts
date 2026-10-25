import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 33 keeps its meetings and events**, gains join keys and calendar tables", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-33-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 32), now: () => 1000 })
  const account = Number(
    old
      .prepare(
        "INSERT INTO accounts (provider, external_id, name, created_at, updated_at) VALUES ('zoom', 'z1', 'Zoom', 1000, 1000) RETURNING id",
      )
      .get()?.id,
  )
  const event = Number(
    old
      .prepare(
        "INSERT INTO events (title, starts_at, ends_at, origin, created_at, updated_at) VALUES ('Planning', 2000, 3000, 'auto', 1000, 1000) RETURNING id",
      )
      .get()?.id,
  )
  const meeting = old.prepare(
    "INSERT INTO meetings (account_id, event_id, external_id, title, join_url, started_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'Planning', ?, 2000, 1000, 1000)",
  )
  meeting.run(account, event, "occ-1", "https://example.zoom.us/j/81234567890?pwd=SYNTHETICPASS")
  meeting.run(account, null, "occ-2", "not a link")
  old.close()

  await (await openStore({ path })).close()

  const database = await openCache(path)
  expect(database.prepare("SELECT external_id, join_key FROM meetings ORDER BY external_id").all()).toEqual([
    { external_id: "occ-1", join_key: "zoom:81234567890" },
    { external_id: "occ-2", join_key: "" },
  ])
  expect(database.prepare("SELECT status, all_day, source_deleted_at FROM events").all()).toEqual([
    { status: null, all_day: null, source_deleted_at: null },
  ])
  expect(database.prepare("SELECT indexable_type, id FROM event_index_pending").all()).toEqual([
    { indexable_type: "event", id: event },
  ])
  for (const table of ["calendars", "calendar_entries", "calendar_entry_revisions", "calendar_entry_participants"])
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toEqual({
      name: table,
    })
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 33").get()).toEqual({
    min_compatible: 32,
  })
  database.close()
})

it("refuses a calendar entry that ends before it starts", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-33-")), "wirecat.db")
  await (await openStore({ path })).close()
  const database = await openCache(path)
  const account = Number(
    database
      .prepare(
        "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('google-calendar', 'g1', 1, 1) RETURNING id",
      )
      .get()?.id,
  )
  const calendar = Number(
    database
      .prepare(
        "INSERT INTO calendars (account_id, external_id, primary_calendar, synced, created_at, updated_at) VALUES (?, 'primary', 1, 1, 1, 1) RETURNING id",
      )
      .get(account)?.id,
  )
  const entry = database.prepare(
    "INSERT INTO calendar_entries (calendar_id, kind, external_id, exception, status, starts_at, ends_at, all_day, created_at, updated_at) " +
      "VALUES (?, 'single', ?, 0, 'confirmed', ?, ?, 0, 1, 1)",
  )
  expect(() => entry.run(calendar, "e1", 2000, 1000)).toThrow(/cannot end before it starts/)
  entry.run(calendar, "e2", 2000, 2000)
  database.close()
})
