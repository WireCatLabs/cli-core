import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { PRAGMAS } from "../driver.js"
import { quietSqliteWarning } from "../sqlite-warning.js"

quietSqliteWarning()
const { cacheOverNodeSqlite, nodeClient } = await import("./node-sqlite.js")

const opened: CacheDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const open = async (path: string, cacheSize?: number) => {
  const database = cacheOverNodeSqlite(await nodeClient(path), cacheSize)
  database.exec(PRAGMAS)
  opened.push(database)
  return database
}

const scratchFile = () => join(mkdtempSync(join(tmpdir(), "statement-cache-")), "cache.db")

const withRows = async (cacheSize?: number) => {
  const database = await open(scratchFile(), cacheSize)
  database.exec("CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2), (3)")
  return database
}

describe("the node:sqlite statement cache", () => {
  it("hands back the same statement for the same SQL text", async () => {
    const database = await withRows()

    expect(database.prepare("SELECT a FROM t WHERE a = ?")).toBe(database.prepare("SELECT a FROM t WHERE a = ?"))
    expect(database.prepare("SELECT a FROM t WHERE a = ?")).not.toBe(database.prepare("SELECT a FROM t"))
  })

  it("runs two handles of one SQL text interleaved, and the same SQL inside a loop over its own rows", async () => {
    const database = await withRows()
    const first = database.prepare("SELECT a FROM t WHERE a >= ? ORDER BY a")
    const second = database.prepare("SELECT a FROM t WHERE a >= ? ORDER BY a")

    expect(first.get(2)).toEqual({ a: 2 })
    expect(second.get(3)).toEqual({ a: 3 })
    expect(first.all(1)).toHaveLength(3)
    const nested = first.all(1).map((row) => first.all(row.a as number).length)
    expect(nested).toEqual([3, 2, 1])
  })

  it("keeps working after a failed run", async () => {
    const database = await withRows()
    const insert = database.prepare("INSERT INTO t VALUES (?)")

    expect(() => insert.run(1)).toThrow(/UNIQUE/)
    expect(database.prepare("INSERT INTO t VALUES (?)").run(9).changes).toBe(1)
  })

  it("does not cache SQL that fails to prepare", async () => {
    const database = await withRows()

    expect(() => database.prepare("SELECT nope FROM t")).toThrow()
    database.exec("ALTER TABLE t ADD COLUMN nope TEXT")
    expect(database.prepare("SELECT nope FROM t WHERE a = 1").get()).toEqual({ nope: null })
  })

  it("does not hold a read open after get(), so another connection's write is seen", async () => {
    const path = scratchFile()
    const reader = await open(path)
    reader.exec("CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2), (3)")
    const writer = await open(path)

    expect(reader.prepare("SELECT a FROM t ORDER BY a").get()).toEqual({ a: 1 })
    writer.prepare("INSERT INTO t VALUES (?)").run(4)

    expect(reader.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 4 })
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 })
  })

  it("drops the least recently used statement past its size, and a held one still works", async () => {
    const database = await withRows(2)
    const one = database.prepare("SELECT 1 AS n")
    const firstTwo = database.prepare("SELECT 2 AS n")
    database.prepare("SELECT 1 AS n")
    database.prepare("SELECT 3 AS n")

    expect(database.prepare("SELECT 1 AS n"), "used recently, so kept").toBe(one)
    const two = database.prepare("SELECT 2 AS n")
    expect(two, "evicted by the 3, so prepared again").not.toBe(firstTwo)
    expect(two.get()).toEqual({ n: 2 })
    expect(one.get(), "evicted but held").toEqual({ n: 1 })
  })

  it("finalizes its statements on close, and a reopened connection prepares afresh", async () => {
    const path = scratchFile()
    const database = cacheOverNodeSqlite(await nodeClient(path))
    database.exec("CREATE TABLE t (a INTEGER)")
    const held = database.prepare("SELECT count(*) AS n FROM t")
    database.close()

    expect(() => held.get()).toThrow(/finalized/)
    const reopened = await open(path)
    expect(reopened.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 })
  })
})
