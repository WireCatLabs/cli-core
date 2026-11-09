import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import type { DiagnosticEvent } from "../runs/events.js"
import { inRun } from "../runs/scope.js"
import { openStoreContext } from "./sqlite/open-store.js"
import { write } from "./sqlite/transaction.js"
import { writeTarget } from "./write-events.js"

describe("writeTarget", () => {
  it.each([
    ["INSERT INTO emails (id) VALUES (?)", { table: "emails", op: "insert" }],
    ['INSERT OR REPLACE INTO "main"."chats" VALUES (1)', { table: "chats", op: "insert" }],
    ["  REPLACE INTO tags VALUES (1)", { table: "tags", op: "insert" }],
    ["update `messages` set x = 1", { table: "messages", op: "update" }],
    ["UPDATE OR IGNORE notes SET a = 1", { table: "notes", op: "update" }],
    ["DELETE FROM chunks WHERE id = ?", { table: "chunks", op: "delete" }],
    [
      "WITH gone AS (SELECT id FROM x WHERE (a)) DELETE FROM embeddings WHERE id IN gone",
      { table: "embeddings", op: "delete" },
    ],
  ])("reads %s", (statement, target) => expect(writeTarget(statement)).toEqual(target))

  it.each([
    "SELECT * FROM emails",
    "INSERT INTO temp.scratch VALUES (1)",
    "CREATE TRIGGER t AFTER INSERT ON emails BEGIN DELETE FROM x; END",
    "PRAGMA journal_mode",
  ])("leaves %s", (statement) => expect(writeTarget(statement)).toBeUndefined())
})

const opened = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "store-write-events-")), "m.db")
  return openStoreContext({ path, warn: () => {} })
}

const recording = <T>(body: () => T): { result: T; events: DiagnosticEvent[] } => {
  const events: DiagnosticEvent[] = []
  const result = inRun({ runId: "r1", command: "sync", events: (event) => events.push(event) }, body)
  return { result, events }
}

const insert = "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('chat', ?, 0, 0)"

describe("store write events", () => {
  it("logs one event per table and kind of change when the outermost write commits, with counts and no content", async () => {
    const { database, orm } = await opened()
    const { events } = recording(() =>
      write(database, () => {
        database.prepare(insert).run("a")
        write(database, () => database.prepare(insert).run("b"))
        orm.run(sql`UPDATE accounts SET updated_at = 1`)
      }),
    )
    database.close()
    expect(events).toEqual([
      { event: "store", operation: "store.write", kind: "store", table: "accounts", op: "insert", n: 2 },
      { event: "store", operation: "store.write", kind: "store", table: "accounts", op: "update", n: 2 },
    ])
  })

  it("logs nothing for a write that rolls back, and a statement outside a transaction on its own", async () => {
    const { database } = await opened()
    const { events } = recording(() => {
      expect(() =>
        write(database, () => {
          database.prepare(insert).run("a")
          throw new Error("no")
        }),
      ).toThrow("no")
      database.prepare(insert).run("b")
      database.prepare("DELETE FROM accounts WHERE external_id = 'none'").run()
    })
    database.close()
    expect(events).toEqual([
      { event: "store", operation: "store.write", kind: "store", table: "accounts", op: "insert", n: 1 },
    ])
  })
})
