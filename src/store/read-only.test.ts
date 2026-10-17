import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { MIGRATIONS } from "./migrations.js"
import { openCache, openFile } from "./open.js"
import * as sqlite from "./sqlite/open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
  vi.restoreAllMocks()
})
const path = () => join(mkdtempSync(join(tmpdir(), "readonly-store-")), "messages.db")
const latest = MIGRATIONS.at(-1)?.version ?? 0

it("reads existing evidence without filling folded names, normalization, indexes or pruning logs", async () => {
  const f = await contextEvidenceFixture()
  handles.push(f)
  f.db.prepare("UPDATE tasks SET title_folded=NULL").run()
  f.db.prepare("UPDATE messages SET normalizer_version=0 WHERE account_id=?").run(f.accountId)
  f.db.prepare("DELETE FROM store_settings WHERE key='logs_pruned_at'").run()
  const snapshot = () => ({
    schema: f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
    messages: f.db.prepare("SELECT id,normalizer_version,normalized_text FROM messages").all(),
    tasks: f.db.prepare("SELECT id,title_folded FROM tasks").all(),
    settings: f.db.prepare("SELECT * FROM store_settings ORDER BY key").all(),
  })
  const before = snapshot()
  const readonly = await openStore({ path: f.path, readOnly: true, now: () => 100 * 86400000 })
  handles.push(readonly)
  const page = await readonly.contextEvidence?.read(f.request)
  expect(page).toMatchObject({ items: [], coverage: { index: "pending" } })
  expect(await readonly.meetings.account(f.accountId)).toMatchObject(f.key)
  expect(snapshot()).toEqual(before)
  await expect(
    readonly.accounts.saveAccount({ provider: "invented", account: "new" }, { name: "New" }),
  ).rejects.toThrow()
  expect(snapshot()).toEqual(before)
})

it("does not create a missing store or its parent and refuses invalid modes", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "readonly-store-")), "missing", "messages.db")
  await expect(openStore({ path: missing, readOnly: true })).rejects.toMatchObject({ code: "not_found" })
  expect(existsSync(join(missing, ".."))).toBe(false)
  expect(existsSync(missing)).toBe(false)
  await expect(openStore({ path: missing, readOnly: "true" as unknown as boolean })).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("keeps an existing DELETE journal mode and enforces the native read-only handle even with query_only disabled", async () => {
  const file = path(),
    writer = await openStore({ path: file })
  await writer.close()
  const change = await openFile(file)
  change.exec("PRAGMA journal_mode=DELETE")
  change.close()
  const store = await openStore({ path: file, readOnly: true })
  handles.push(store)
  const opened = await sqlite.openSqlite(file, { readOnly: true })
  handles.push(opened.database)
  expect(opened.database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
  expect(opened.database.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 })
  opened.database.exec("PRAGMA query_only=OFF")
  expect(() => opened.database.exec("CREATE TABLE forbidden(id INTEGER)")).toThrow()
})

it.each(["missing-history", "empty-history", "old", "new-incompatible", "invalid"])(
  "refuses %s schema without maintenance and closes the connection",
  async (kind) => {
    const file = path(),
      writable = await openStore({ path: file })
    await writable.close()
    const db = await openCache(file)
    handles.push(db)
    if (kind === "missing-history") db.exec("DROP TABLE schema_migrations")
    else if (kind === "empty-history") db.exec("DELETE FROM schema_migrations")
    else if (kind === "old") db.prepare("DELETE FROM schema_migrations WHERE version=?").run(latest)
    else if (kind === "new-incompatible")
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,0)").run(latest + 1, latest + 1)
    else db.prepare("UPDATE schema_migrations SET min_compatible=0 WHERE version=?").run(latest)
    const before = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()
    const original = sqlite.openSqlite,
      closed = vi.fn()
    vi.spyOn(sqlite, "openSqlite").mockImplementation(async (...args) => {
      const opened = await original(...args),
        close = opened.database.close.bind(opened.database)
      opened.database.close = () => {
        closed()
        close()
      }
      return opened
    })
    await expect(openStore({ path: file, readOnly: true })).rejects.toMatchObject({ code: "configuration_error" })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before)
  },
)

it("accepts a newer additive schema without recording a migration or creating a table", async () => {
  const file = path(),
    writable = await openStore({ path: file })
  await writable.close()
  const db = await openCache(file)
  handles.push(db)
  db.prepare("INSERT INTO schema_migrations VALUES(?,?,0)").run(latest + 1, latest)
  const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()
  const store = await openStore({ path: file, readOnly: true })
  handles.push(store)
  expect(await store.meetings.account(9999)).toBeNull()
  expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before)
})
