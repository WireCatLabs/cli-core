import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const owner = { provider: "telegram", account: "500" }

it("**a store from before version 37 gains identities.phone** and the contact card triggers", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-37-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 36), now: () => 1000 })
  old.close()

  const store = await openStore({ path })
  const database = await openCache(path)
  expect(database.prepare("SELECT name FROM pragma_table_info('identities') WHERE name = 'phone'").all()).toEqual([
    { name: "phone" },
  ])
  expect(
    database
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'mention_pending_attachment_contact_%'")
      .get(),
  ).toEqual({ n: 2 })
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 37").get()).toEqual({
    min_compatible: 34,
  })
  database.close()
  await store.close()
})

it("keeps a phone once shown, and a later read without one does not erase it", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "version-37-")), "wirecat.db") })
  await store.people.savePeople(owner, [{ id: "11", name: "Ana", phone: "+34600000123" }])
  await store.people.savePeople(owner, [{ id: "11", name: "Ana" }])

  expect(await store.people.phoneOf(owner, "11")).toBe("+34600000123")
  expect(await store.people.phoneOf(owner, "12")).toBeNull()
  await store.close()
})
