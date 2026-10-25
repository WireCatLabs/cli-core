import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const envFor = () => {
  const root = mkdtempSync(join(tmpdir(), "store-tables-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const seeded = async (env: NodeJS.ProcessEnv) => {
  const database = await openCache(String(env.MESSAGING_STORE))
  migrate(database, { now: () => Date.UTC(2026, 9, 1) })
  database.exec(
    `INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'chat', '500', 0, 0)`,
  )
  database.exec(
    `INSERT INTO chats (id, account_id, external_id, kind, title, updated_at, created_at)
     VALUES (1, 1, '7', 'group', 'Book club', 0, 0), (2, 1, '8', 'private', 'Ana', 0, 0)`,
  )
  database.close()
}

const call = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("listing tables never connects")
    },
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [storeCommand(messenger)] }, { streams, tty: false, env })
  return { code, stderr: streams.stderr.join(""), body: JSON.parse(streams.stdout[0] ?? "null") }
}

type Row = v.InferOutput<typeof ENTITIES.store_table>

describe("store tables list", () => {
  it("lists every table with its kind, counting rows only where a count means something", async () => {
    const env = envFor()
    await seeded(env)
    const { code, stderr, body } = await call(["store", "tables", "list", "--json"], env)
    expect(code, stderr).toBe(0)
    const items = body.items as Row[]
    for (const item of items) v.parse(ENTITIES.store_table, item)
    const byName = new Map(items.map((item) => [item.name, item]))

    expect(byName.get("chats")).toEqual({ name: "chats", kind: "data", rows: 2 })
    expect(byName.get("schema_migrations")).toMatchObject({ kind: "internal", rows: MIGRATIONS.length })
    expect(byName.get("messages_fts")).toEqual({ name: "messages_fts", kind: "search_index", rows: null })
    expect(byName.get("messages_fts_data")).toMatchObject({ kind: "search_index_part", rows: null })
    expect(items.some((item) => "bytes" in item)).toBe(false)
  })

  it("narrows by kind and name in the query", async () => {
    const env = envFor()
    await seeded(env)
    const data = (await call(["store", "tables", "list", "kind:data", "--json"], env)).body.items as Row[]
    expect(data.length).toBeGreaterThan(10)
    expect(new Set(data.map((item) => item.kind))).toEqual(new Set(["data"]))

    const one = (await call(["store", "tables", "list", "name:accounts", "--json"], env)).body.items
    expect(one).toEqual([{ name: "accounts", kind: "data", rows: 1 }])

    const refused = await call(["store", "tables", "list", "kind:everything", "--json"], env)
    expect(refused.code).not.toBe(0)
  })

  it("with --full, gives each table the bytes of its pages and indexes, and a search index none of its own", async () => {
    const env = envFor()
    await seeded(env)
    const items = (await call(["store", "tables", "list", "--full", "--json"], env)).body.items as Row[]
    const byName = new Map(items.map((item) => [item.name, item]))
    const pageSize = 4096
    expect(byName.get("chats")?.bytes).toBeGreaterThanOrEqual(pageSize)
    expect(byName.get("messages_fts")?.bytes).toBeNull()
    const total = items.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
    expect(total).toBeLessThanOrEqual(statSync(String(env.MESSAGING_STORE)).size)
  })

  // A read-only connection to a WAL file still opens an empty -wal beside it; SQLite cannot remove it on close.
  it("opens the file read-only: the file is untouched and nothing is written to its journal", async () => {
    const env = envFor()
    await seeded(env)
    const path = String(env.MESSAGING_STORE)
    const before = statSync(path).mtimeMs
    expect((await call(["store", "tables", "list", "--full", "--json"], env)).code).toBe(0)
    expect(statSync(path).mtimeMs).toBe(before)
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0)
  })

  it("says there is no store rather than creating one", async () => {
    const env = envFor()
    const { code, body } = await call(["store", "tables", "list", "--json"], env)
    expect(code).not.toBe(0)
    expect(body).toBeNull()
    expect(existsSync(String(env.MESSAGING_STORE))).toBe(false)
  })
})

describe("store info, about the file", () => {
  it("gives the journal mode, the pages, every migration and the last backup's marker", async () => {
    const env = envFor()
    await seeded(env)
    const backups = join(dirname(String(env.MESSAGING_STORE)), "backups")
    mkdirSync(backups)
    writeFileSync(
      join(backups, "last.json"),
      JSON.stringify({ at: "2026-10-18T02:16:29Z", file: "wirecat.db.zst", drive_id: "x", checked: "quick_check ok" }),
    )
    const { code, body } = await call(["store", "info", "--json"], env)
    expect(code).toBe(0)
    v.parse(ENTITIES.store_info, body.item)
    expect(body.item.journal_mode).toBe("wal")
    expect(body.item.pages).toMatchObject({ size: 4096, free: 0 })
    expect(body.item.migrations).toHaveLength(MIGRATIONS.length)
    expect(body.item.migrations[0]).toEqual({ version: 1, min_compatible: 1, applied_at: "2026-10-01T00:00:00.000Z" })
    expect(body.item.backup).toEqual({
      at: "2026-10-18T02:16:29.000Z",
      file: "wirecat.db.zst",
      checked: "quick_check ok",
    })
  })

  it("reads a missing or unreadable backup marker as no backup", async () => {
    const env = envFor()
    await seeded(env)
    expect((await call(["store", "info", "--json"], env)).body.item.backup).toBeNull()
    const backups = join(dirname(String(env.MESSAGING_STORE)), "backups")
    mkdirSync(backups)
    writeFileSync(join(backups, "last.json"), "{ not json")
    expect((await call(["store", "info", "--json"], env)).body.item.backup).toBeNull()
  })
})
