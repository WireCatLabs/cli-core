import { execFileSync } from "node:child_process"
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
import { recoveryNotes } from "../cli/store-recover.js"
import { storeDamageReport } from "./damage.js"
import { storeHealth } from "./health.js"
import { readHealthMark } from "./marks.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import {
  danglingRows,
  placeLostRows,
  recoverStore,
  runningRecovery,
  sqlite3Program,
  storeHolders,
  tableRows,
} from "./recover.js"
import { openSqlite } from "./sqlite/open.js"

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
    const report = storeDamageReport({ health, command: "chat" })
    expect(report?.whatHappened).toContain("email_words")
    expect(report?.externalDataSafe).toMatch(/fetched again/)
    expect(report?.steps.map((step) => step.command)).toContain("chat store recover run")
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

const withMessages = async (count: number) => {
  const { path } = await seeded()
  const database = await openCache(path)
  const insert = database.prepare(
    "INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source, updated_at) " +
      "VALUES (1, 1, ?, ?, ?, 0, 'chat', 0)",
  )
  for (let id = 1; id <= count; id++) insert.run(String(id), id * 1000, `message ${id}`)
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  database.close()
  return path
}

const shell = (path: string, sql: string) =>
  execFileSync("sqlite3", ["-cmd", ".dbconfig defensive off", path, sql], { stdio: ["ignore", "ignore", "pipe"] })

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
    expect(readHealthMark(path)).toMatchObject({ ok: true, cli: "chat" })
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

  it("swaps the file when another tool only reads the store during the recovery", async () => {
    const { path } = await seeded()
    const reading = async (from: string, target: string) => {
      for (const readOnly of [true, false]) {
        const database = readOnly ? (await openSqlite(from, { readOnly })).database : await openCache(from)
        database.prepare("SELECT count(*) FROM chats").get()
        database.close()
      }
      copyFileSync(from, target)
      return { errors: [], read: {} }
    }
    const recovery = await recoverStore({ path, command: "chat", copy: reading })
    expect(existsSync(recovery.keptAt)).toBe(true)
  })

  it("leaves the store as it was when another tool writes to it during the recovery", async () => {
    const { path } = await seeded()
    const writing = async (from: string, target: string) => {
      copyFileSync(from, target)
      const database = await openCache(from)
      database.exec("UPDATE chats SET title = 'Poetry club' WHERE id = 1")
      database.close()
      return { errors: [], read: {} }
    }
    await expect(recoverStore({ path, command: "chat", copy: writing })).rejects.toMatchObject({
      details: { reason: "store.changed-during-recovery" },
    })
    expect(readdirSync(dirname(path)).filter((file) => file.includes("before-recover"))).toEqual([])
  })

  it("refuses a second recovery while one runs, and shows the running one as holding the store", async () => {
    const { path } = await seeded()
    let second: Promise<unknown> | undefined
    const racing = async (from: string, target: string) => {
      expect(runningRecovery(from)).toBe(process.pid)
      second = recoverStore({ path, command: "chat", copy: copyOf(from) })
      await second.catch(() => {})
      copyFileSync(from, target)
      return { errors: [], read: {} }
    }
    await recoverStore({ path, command: "chat", copy: racing })
    await expect(second).rejects.toMatchObject({ details: { reason: "store.recovering" } })
    expect(runningRecovery(path)).toBeNull()
  })

  it("takes over a lock left by a recovery that ended", async () => {
    const { path } = await seeded()
    writeFileSync(`${path}.recover-lock`, "999999999")
    expect(storeHolders(path)?.map(({ pid }) => pid)).not.toContain(999999999)
    const clean = `${path}.clean`
    copyFileSync(path, clean)
    await recoverStore({ path, command: "chat", copy: copyOf(clean) })
    expect(existsSync(`${path}.recover-lock`)).toBe(false)
  })

  it("clears values that are not valid JSON, drops rows whose JSON is required, and counts both", async () => {
    const { path } = await seeded()
    const database = await openCache(path)
    database.exec("UPDATE chats SET metadata = '{\"broken\": ' WHERE id = 1")
    database.exec(
      "INSERT INTO searches (name, command, params, language, version, fields_version, created_at, updated_at) " +
        "VALUES ('saved', 'search', '{not json', 'lucene', 1, 1, 0, 0)",
    )
    const health = await storeHealth(path, { deep: true })
    database.close()
    expect(health.ok).toBe(false)
    expect(health.invalidJson).toEqual([
      { table: "chats", column: "metadata", rows: 1, required: false },
      { table: "searches", column: "params", rows: 1, required: true },
    ])
    expect(storeDamageReport({ health, command: "chat" })?.whatHappened).toContain("chats.metadata")
    const copying = async (from: string, target: string) => {
      copyFileSync(from, target)
      return { errors: [], read: {} }
    }
    const recovery = await recoverStore({ path, command: "chat", copy: copying })
    expect(recovery.invalidJson.map(({ table, rows }) => [table, rows])).toEqual([
      ["chats", 1],
      ["searches", 1],
    ])
    const after = await openCache(path)
    expect(after.prepare("SELECT metadata FROM chats WHERE id = 1").get()?.metadata).toBeNull()
    expect(after.prepare("SELECT count(*) AS n FROM searches").get()?.n).toBe(0)
    after.close()
  })

  it("counts the rows of every data table, leaving search shadow tables out", async () => {
    const { path } = await seeded()
    const database = await openCache(path)
    const rows = tableRows(database)
    database.close()
    expect(rows).toMatchObject({ chats: 2, accounts: 1 })
    expect(Object.keys(rows).some((table) => table.startsWith("chats_fts_"))).toBe(false)
  })

  it("puts a row found on no table's page back into the one table its values fit, and leaves the rest out", async () => {
    const path = await withMessages(1)
    const database = await openCache(path)
    const names = database
      .prepare("SELECT name FROM pragma_table_info('messages')")
      .all()
      .map((row) => String(row.name))
    const fields = names.map((_, at) => `c${at}`)
    database.exec(`CREATE TABLE recover_lost_and_found (rootpgno, pgno, nfield, id, ${fields.join(", ")})`)
    database.exec(
      `INSERT INTO recover_lost_and_found SELECT 9, 9, ${names.length}, id, ` +
        `${names.map((name) => (name === "id" ? "NULL" : `"${name}"`)).join(", ")} FROM messages`,
    )
    database.exec(
      "INSERT INTO recover_lost_and_found (rootpgno, pgno, nfield, id, c0, c1) VALUES (9, 9, 2, 5, 'x', 'y')",
    )
    database.exec("DELETE FROM messages")
    expect(placeLostRows(database)).toEqual({ messages: 1 })
    expect(database.prepare("SELECT external_id, text FROM messages").all()).toEqual([
      { external_id: "1", text: "message 1" },
    ])
    expect(database.prepare("SELECT count(*) AS n FROM recover_lost_and_found").get()?.n).toBe(1)
    database.close()
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
  it("counts the rows an index of the damaged file lists and its table lost, and never says nothing was lost", async () => {
    const path = await withMessages(5)
    const entry = execFileSync(
      "sqlite3",
      [path, "SELECT rootpage, sql FROM sqlite_master WHERE name = 'messages_by_account'"],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("|")
    shell(
      path,
      "PRAGMA writable_schema = ON; DELETE FROM sqlite_master WHERE name = 'messages_by_account'; " +
        "PRAGMA schema_version = 900;",
    )
    shell(path, "DELETE FROM messages WHERE external_id IN ('4', '5')")
    shell(
      path,
      "PRAGMA writable_schema = ON; INSERT INTO sqlite_master VALUES " +
        `('index', 'messages_by_account', 'messages', ${entry[0]}, '${String(entry.slice(1).join("|")).replaceAll("'", "''")}'); ` +
        "PRAGMA schema_version = 901;",
    )
    const recovery = await recoverStore({ path, command: "chat" })
    expect(recovery.lost).toContainEqual(
      expect.objectContaining({ table: "messages", kept: 3, goneAtLeast: 2, seenIn: "messages_by_account" }),
    )
    const notes = recoveryNotes({ ...recovery, copyErrors: 0, checkedOk: true, next: [] })
    expect(notes).toContainEqual(expect.stringContaining("messages: 3 kept of 3; at least 2 rows are gone"))
    expect(notes.at(-1)).toMatch(/^more rows may be gone: /)
  })

  it("puts back rows cut off their table onto pages no table claims", async () => {
    const path = await withMessages(3)
    const holder = execFileSync(
      "sqlite3",
      [path, "CREATE TABLE holder (a); SELECT rootpage FROM sqlite_master WHERE name = 'holder';"],
      { encoding: "utf8" },
    ).trim()
    shell(
      path,
      `PRAGMA writable_schema = ON; UPDATE sqlite_master SET rootpage = ${holder} WHERE name = 'messages'; ` +
        "DELETE FROM sqlite_master WHERE name = 'holder'; PRAGMA schema_version = 900;",
    )
    const recovery = await recoverStore({ path, command: "chat" })
    expect(recovery.placed).toEqual({ messages: 3 })
    expect(recovery.health.ok).toBe(true)
    const database = await openCache(path)
    expect(database.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(3)
    database.close()
  })

  it("copies the readable rows of a damaged store with .recover", async () => {
    const { path, root, pageSize } = await seeded()
    damage(path, root, pageSize)
    const recovery = await recoverStore({ path, command: "chat" })
    expect(recovery.health.ok).toBe(true)
    await recovered(path)
  })
})
