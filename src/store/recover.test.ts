import { closeSync, existsSync, mkdtempSync, openSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { explainDamage } from "./damage.js"
import { storeHealth } from "./health.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { recoverStore, sqlite3Program } from "./recover.js"

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

describe.skipIf(!sqlite3Program().usable)("store recovery", () => {
  it("rebuilds a damaged store from its readable rows, checks it, and keeps the damaged file beside it", async () => {
    const { path, root, pageSize } = await seeded()
    damage(path, root, pageSize)
    const recovery = await recoverStore({ path, command: "chat" })
    expect(recovery.health.ok).toBe(true)
    expect(recovery.rebuilt.searchIndexes).toContain("email_words")
    expect(existsSync(recovery.keptAt)).toBe(true)
    expect((await storeHealth(path, { deep: true })).ok).toBe(true)
    const database = await openCache(path)
    expect(database.prepare("SELECT count(*) AS n FROM chats").get()?.n).toBe(2)
    expect(database.prepare("SELECT rowid FROM chats_fts WHERE chats_fts MATCH 'Book'").all()).toHaveLength(1)
    database.close()
  })
})
