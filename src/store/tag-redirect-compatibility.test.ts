import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { type Migration, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { writeBatch } from "./sqlite/transaction.js"

const opened: CacheDatabase[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})
const first: Migration = {
  version: 1,
  minCompatible: 1,
  statements: ["CREATE TABLE fixture_labels (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"],
}
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tag-compatibility-")), "fixture.db")
  const connect = async () => {
    const db = await openCache(path)
    opened.push(db)
    return db
  }
  const old = await connect()
  migrate(old, { migrations: [first], ownTable: null })
  old.exec("INSERT INTO fixture_labels(id,name) VALUES(1,'source'),(2,'survivor')")
  return { old, connect }
}
const redirectMigration = (minimum: number): Migration => ({
  version: 2,
  minCompatible: minimum,
  statements: [
    "CREATE TABLE fixture_redirects(source_id INTEGER PRIMARY KEY, survivor_id INTEGER NOT NULL)",
    "INSERT INTO fixture_redirects(source_id,survivor_id) VALUES(1,2)",
  ],
})

it("an additive manifest admits an old SDK that does not understand retained source IDs", async () => {
  const { connect } = await fixture()
  const newer = await connect()
  migrate(newer, { migrations: [first, redirectMigration(1)], ownTable: null })
  const reopenedOld = await connect()
  expect(() => migrate(reopenedOld, { migrations: [first], ownTable: null })).not.toThrow()
  expect(reopenedOld.prepare("SELECT name FROM fixture_labels ORDER BY id").all()).toEqual([
    { name: "source" },
    { name: "survivor" },
  ])
  expect(() =>
    writeBatch(reopenedOld, () => reopenedOld.exec("UPDATE fixture_labels SET name='old write' WHERE id=1")),
  ).not.toThrow()
})

it("a breaking manifest rejects old opens but cannot revoke an already-open old handle", async () => {
  const { old, connect } = await fixture()
  const newer = await connect()
  migrate(newer, { migrations: [first, redirectMigration(2)], ownTable: null })
  const reopenedOld = await connect()
  expect(() => migrate(reopenedOld, { migrations: [first], ownTable: null })).toThrow(
    expect.objectContaining({ code: "configuration_error" }),
  )
  expect(() =>
    writeBatch(old, () => old.exec("UPDATE fixture_labels SET name='still writable' WHERE id=1")),
  ).not.toThrow()
  expect(newer.prepare("SELECT name FROM fixture_labels WHERE id=1").get()).toEqual({ name: "still writable" })
  expect(old.prepare("SELECT name FROM fixture_labels ORDER BY id").all()).toHaveLength(2)
})
