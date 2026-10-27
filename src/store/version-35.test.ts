import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 35 keeps its calendar rows in neutral words**, occurrences by series column", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-35-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 34), now: () => 1000 })
  const id = (sql: string, ...values: (string | number | null)[]) => Number(old.prepare(sql).get(...values)?.id)
  const account = id(
    "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('google-calendar', 'a', 1, 1) RETURNING id",
  )
  const calendar = id(
    `INSERT INTO calendars (account_id, external_id, access_role, primary_calendar, synced, created_at, updated_at)
      VALUES (?, 'shared', 'freeBusyReader', 0, 1, 1, 1) RETURNING id`,
    account,
  )
  const entry = (externalId: string, kind: string, eventType: string | null, metadata: string | null) =>
    id(
      `INSERT INTO calendar_entries (calendar_id, kind, external_id, original_starts_at, exception, status, all_day,
         event_type, own_response, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 5000, 0, 'confirmed', 0, ?, 'needsAction', ?, 1, 1) RETURNING id`,
      calendar,
      kind,
      externalId,
      eventType,
      metadata,
    )
  const occurrence = entry("s1_5000", "occurrence", "outOfOffice", JSON.stringify({ recurring_event_id: "s1" }))
  entry("f1", "single", "focusTime", null)
  entry("w1", "single", "workingLocation", "not json")
  entry("g1", "single", "fromGmail", null)
  entry("d1", "single", "default", null)
  old
    .prepare(
      `INSERT INTO calendar_entry_participants (entry_id, email, response, optional, organizer, self, resource,
         created_at, updated_at) VALUES (?, 'alice@example.com', 'needsAction', 0, 0, 0, 0, 1, 1)`,
    )
    .run(occurrence)
  old.close()

  const store = await openStore({ path })
  const database = await openCache(path)
  expect(
    database
      .prepare("SELECT external_id, series_external_id, event_type, own_response FROM calendar_entries ORDER BY id")
      .all(),
  ).toEqual([
    { external_id: "s1_5000", series_external_id: "s1", event_type: "out-of-office", own_response: "needs-action" },
    { external_id: "f1", series_external_id: null, event_type: "focus", own_response: "needs-action" },
    { external_id: "w1", series_external_id: null, event_type: "working-location", own_response: "needs-action" },
    { external_id: "g1", series_external_id: null, event_type: "from-mail", own_response: "needs-action" },
    { external_id: "d1", series_external_id: null, event_type: "default", own_response: "needs-action" },
  ])
  expect(database.prepare("SELECT response FROM calendar_entry_participants").all()).toEqual([
    { response: "needs-action" },
  ])
  expect(database.prepare("SELECT access_role FROM calendars").all()).toEqual([{ access_role: "free-busy" }])
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 35").get()).toEqual({
    min_compatible: 34,
  })
  const [series] = await store.calendar.saveEntries(
    calendar,
    [{ externalId: "s1", kind: "series", status: "confirmed", startsAt: 5000, endsAt: 6000, recurrence: [] }],
    2000,
  )
  expect(database.prepare("SELECT series_entry_id FROM calendar_entries WHERE external_id = 's1_5000'").get()).toEqual({
    series_entry_id: series?.id,
  })
  database.close()
  await store.close()
})
