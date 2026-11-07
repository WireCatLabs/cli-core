import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { explainDamage } from "./damage.js"
import { storeHealth } from "./health.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { danglingRows, recoverStore, sqlite3Program, tableRows } from "./recover.js"

const seeded = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "store-recover-")), "m.db")
  const database = await openCache(path)
  migrate(database, { now: () => Date.UTC(2026, 9, 1) })
  database.exec(
    "INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'chat', '500', 0, 0)",
  )
  database.exec(
    `INSERT INTO chats (id, account_id, external_id, kind, title, updated_at, created_at)
     VALUES (1, 1, '7', 'group', 'Book club', 0, 0), (2, 1, '8', 'private', 'Ana', 0, 0)`,
  )
  const root = Number(
    database.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'email_words_data'").get()?.rootpage,
  )
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size)
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  database.close()
  return { path, root, pageSize }
}

const damage = (path: string, page: number, pageSize: number) => {
  const file = openSync(path, "r+")
  writeSync(file, Buffer.alloc(64, 0xa5), 0, 64, (page - 1) * pageSize)
  closeSync(file)
}

describe("store health", () => {
  it("passes a whole store, quickly by default and deeply on request", async () => {
    const { path } = await seeded()
    expect((await storeHealth(path)).ok).toBe(true)
    const deep = await storeHealth(path, { deep: true })
    expect(deep).toMatchObject({ checked: "deep", ok: true, problems: 0 })
    expect(deep.searchIndexes?.every((index) => index.ok)).toBe(true)
  })

  it("names a damaged search index by its own name, and explains it in plain words", async () => {
    const { path, root, pageSize } = await seeded()
    damage(path, root, pageSize)
    const health = await storeHealth(path, { deep: true })
    expect(health.ok).toBe(false)
    expect(health.damagedTables?.map((one) => one.table)).toContain("email_words")
    const explained = explainDamage(health, "chat")
    expect(explained?.what).toContain("email_words")
    expect(explained?.externalUnaffected).toMatch(/fetched again/)
    expect(explained?.steps).toContain("chat store recover run")
  })
})

const recovered = async (path: string) => {
  expect((await storeHealth(path, { deep: true })).ok).toBe(true)
  const database = await openCache(path)
  expect(database.prepare("SELECT count(*) AS n FROM chats").get()?.n).toBe(2)
  expect(database.prepare("SELECT rowid FROM chats_fts WHERE chats_fts MATCH 'Book'").all()).toHaveLength(1)
  database.close()
}

/** Stands in for `sqlite3 .recover`, which some builds leave out: the rows as they were before the damage. */
const copyOf = (clean: string) => async (_path: string, target: string) => {
  copyFileSync(clean, target)
  return { errors: [], read: { chats: 2, accounts: 1 } }
}

describe("store recovery", () => {
  it("rebuilds every index from the copied rows, checks it, and keeps the damaged file beside it", async () => {
    const { path, root, pageSize } = await seeded()
    const clean = `${path}.clean`
    copyFileSync(path, clean)
    damage(path, root, pageSize)
    const recovery = await recoverStore({ path, command: "chat", copy: copyOf(clean) })
    expect(recovery.health.ok).toBe(true)
    expect(recovery.rebuilt.searchIndexes).toContain("email_words")
    expect(recovery.lost).toEqual([])
    expect(recovery.dangling).toEqual([])
    expect(existsSync(recovery.keptAt)).toBe(true)
    await recovered(path)
  })

  it("names what is missing when it cannot copy: no sqlite3 program", async () => {
    const { path } = await seeded()
    expect(sqlite3Program("no-such-sqlite3")).toMatchObject({ usable: false, version: null })
    await expect(recoverStore({ path, command: "chat", sqlite3: "no-such-sqlite3" })).rejects.toMatchObject({
      details: { reason: "store.sqlite3-missing" },
    })
  })

  it("says a store whose header is damaged cannot be recovered, not to run store recover", async () => {
    const { path } = await seeded()
    writeFileSync(path, "not a database header".repeat(400))
    await expect(recoverStore({ path, command: "chat", copy: copyOf(path) })).rejects.toMatchObject({
      details: { reason: "store.unreadable" },
    })
  })

  it("leaves the store as it was, and its own file gone, when the copy fails", async () => {
    const { path } = await seeded()
    const failing = async () => {
      throw new Error("copy failed")
    }
    await expect(recoverStore({ path, command: "chat", copy: failing })).rejects.toThrow("copy failed")
    expect(readdirSync(dirname(path)).filter((file) => file.includes("recovering"))).toEqual([])
    expect((await storeHealth(path, { deep: true })).ok).toBe(true)
  })

  it("counts the rows of every data table, leaving search shadow tables out", async () => {
    const { path } = await seeded()
    const database = await openCache(path)
    const rows = tableRows(database)
    database.close()
    expect(rows).toMatchObject({ chats: 2, accounts: 1 })
    expect(Object.keys(rows).some((table) => table.startsWith("chats_fts_"))).toBe(false)
  })

  it("lists rows that point at a row the store does not hold", async () => {
    const { path } = await seeded()
    const database = await openCache(path)
    database.exec("PRAGMA foreign_keys = OFF")
    database.exec("DELETE FROM accounts WHERE id = 1")
    expect(danglingRows(database)).toContainEqual({ table: "chats", parent: "accounts", rows: 2, missing: [1] })
    database.close()
  })
})

describe.skipIf(!sqlite3Program().usable)("store recovery with the sqlite3 program", () => {
  it("copies the readable rows of a damaged store with .recover", async () => {
    const { path, root, pageSize } = await seeded()
    damage(path, root, pageSize)
    const recovery = await recoverStore({ path, command: "chat" })
    expect(recovery.health.ok).toBe(true)
    await recovered(path)
  })
})
