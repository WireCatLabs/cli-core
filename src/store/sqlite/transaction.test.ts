import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { migrate } from "../migrations.js"
import { openCache } from "../open.js"
import { read, write } from "./transaction.js"

const QUEUES = ["message_stems_pending", "mention_pending", "involvement_pending"] as const

const opened: CacheDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const fresh = async (): Promise<CacheDatabase> => {
  const database = await openCache(join(mkdtempSync(join(tmpdir(), "transaction-")), "store.db"))
  migrate(database)
  opened.push(database)
  return database
}

const queued = (database: CacheDatabase): Record<string, number> =>
  Object.fromEntries(
    QUEUES.map((queue) => [queue, Number(database.prepare(`SELECT count(*) AS n FROM ${queue}`).get()?.n)]),
  )

const count = (database: CacheDatabase, table: string): number =>
  Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)

let chats = 0
const saveMessage = (database: CacheDatabase, text = "Call Anna at +7 900 000-00-01"): void => {
  chats += 1
  const account = database
    .prepare(
      "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('telegram', ?, 0, 0) RETURNING id",
    )
    .get(`a${chats}`)
  const chat = database
    .prepare(
      "INSERT INTO chats (account_id, external_id, kind, title, created_at, updated_at) VALUES (?, ?, 'group', 'Synthetic', 0, 0) RETURNING id",
    )
    .get(Number(account?.id), String(chats))
  database
    .prepare(
      "INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, normalized_text, normalizer_version, outgoing, " +
        "created_at, source, updated_at) VALUES (?, ?, '1', 0, ?, lower(?), 1, 1, 0, 'test', 0)",
    )
    .run(Number(chat?.id), Number(account?.id), text, text)
}

describe("write", () => {
  it("drains every queue the triggers filled when the outermost write commits", async () => {
    const database = await fresh()
    let during: Record<string, number> = {}
    write(database, () => {
      write(database, () => saveMessage(database))
      during = queued(database)
    })
    expect(Object.values(during).every((n) => n > 0)).toBe(true)
    expect(queued(database)).toEqual({ message_stems_pending: 0, mention_pending: 0, involvement_pending: 0 })
  })

  it("rolls a nested write back to its savepoint and keeps the outer one", async () => {
    const database = await fresh()
    write(database, () => {
      saveMessage(database)
      expect(() =>
        write(database, () => {
          saveMessage(database)
          throw new Error("refused")
        }),
      ).toThrow("refused")
    })
    expect(count(database, "messages")).toBe(1)
  })

  it("keeps the nesting depth per connection", async () => {
    const outer = await fresh()
    const other = await fresh()
    expect(() =>
      write(outer, () => {
        saveMessage(outer)
        write(other, () => saveMessage(other))
        throw new Error("refused")
      }),
    ).toThrow("refused")
    expect(count(outer, "messages")).toBe(0)
    expect(count(other, "messages")).toBe(1)
    expect(queued(other)).toEqual({ message_stems_pending: 0, mention_pending: 0, involvement_pending: 0 })
  })

  it("refuses to write inside a read, where nothing would drain", async () => {
    const database = await fresh()
    expect(() => read(database, () => write(database, () => saveMessage(database)))).toThrow("inside a read")
    expect(count(database, "messages")).toBe(0)
    write(database, () => saveMessage(database))
    expect(count(database, "messages")).toBe(1)
  })
})

describe("a write that finds another process writing", () => {
  const holder = (path: string) => {
    const script = join(path, "..", "holder.mjs")
    writeFileSync(
      script,
      `import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(${JSON.stringify(path)})
db.exec("PRAGMA busy_timeout = 5000")
console.log("ready")
const end = Date.now() + 9000
while (Date.now() < end) {
  db.exec("BEGIN IMMEDIATE")
  const stop = Date.now() + 20
  while (Date.now() < stop);
  db.exec("COMMIT")
  const next = performance.now() + 0.3
  while (performance.now() < next);
}
`,
    )
    return spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] })
  }

  it("gets in between a writer's back-to-back transactions instead of failing after busy_timeout", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "transaction-busy-")), "store.db")
    const database = await openCache(path)
    opened.push(database)
    migrate(database)
    const other = holder(path)
    try {
      await new Promise((resolve) => other.stdout.once("data", resolve))
      await new Promise((resolve) => setTimeout(resolve, 200))
      const started = Date.now()
      write(database, () => saveMessage(database))
      expect(Date.now() - started).toBeLessThan(1000)
      expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
    } finally {
      other.kill()
    }
  }, 20_000)
})
