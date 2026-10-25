import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { storeInfo as storeInfoEntity } from "../entities/store-maintenance.js"
import { compatibilityOf } from "../store/compatibility.js"
import { MIGRATIONS, migrate } from "../store/migrations.js"
import { openSqlite } from "../store/store.js"
import { run } from "./program.js"
import { sharedStoreCommand, storeInfo } from "./store-info.js"

const latest = MIGRATIONS.at(-1)?.version ?? 0
const envFor = () => ({ MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-info-")), "wirecat.db") })
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

const storeAt = async (env: { MESSAGING_STORE: string }, migrations = MIGRATIONS, client?: string) => {
  const { database } = await openSqlite(env.MESSAGING_STORE)
  migrate(database, { migrations, ...(client ? { command: client, version: "1.2.3", now: () => 0 } : {}) })
  database.close()
}

const infoOf = async (env: NodeJS.ProcessEnv) => v.parse(storeInfoEntity, await storeInfo(env))

describe("store info's schema answer", () => {
  it("says a missing store is missing, what this tool would create, and creates nothing", async () => {
    const env = envFor()
    const answer = await infoOf(env)
    expect(answer).toMatchObject({
      exists: false,
      schema: { version: 0, speaks: latest, writable: true, reason: "missing", upgrade: { version: latest } },
    })
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })

  it("**reads an older store without migrating it**, and says what this tool's next run would raise it to", async () => {
    const env = envFor()
    await storeAt(env, MIGRATIONS.slice(0, -1))
    const before = hash(env.MESSAGING_STORE)

    const answer = await infoOf(env)

    expect(answer).toMatchObject({
      schema: {
        version: latest - 1,
        speaks: latest,
        writable: true,
        reason: "older",
        upgrade: {
          version: latest,
          min_compatible: compatibilityOf({ version: latest - 1, minCompatible: 1 }).upgrade?.minCompatible,
        },
      },
    })
    expect(hash(env.MESSAGING_STORE)).toBe(before)
  })

  it("leaves a WAL store with no shared-memory file byte for byte as it was", async () => {
    const env = envFor()
    await storeAt(env)
    rmSync(`${env.MESSAGING_STORE}-shm`, { force: true })
    const before = hash(env.MESSAGING_STORE)

    expect((await infoOf(env)).schema).toMatchObject({ reason: "current", upgrade: null })
    expect(hash(env.MESSAGING_STORE)).toBe(before)
  })

  it("reads a newer store this tool may still write, rows included", async () => {
    const env = envFor()
    await storeAt(env, [...MIGRATIONS, { version: latest + 1, minCompatible: 1, statements: [] }])
    const answer = await infoOf(env)
    expect(answer).toMatchObject({
      schema: { version: latest + 1, writable: true, reason: "newer" },
      rows: { chats: 0 },
    })
  })

  it("**answers for a store too new for this tool** with its schema instead of an error", async () => {
    const env = envFor()
    await storeAt(env, [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }], "tg")

    const answer = await infoOf(env)

    expect(answer).toMatchObject({
      exists: true,
      schema: { version: latest + 1, min_compatible: latest + 1, speaks: latest, writable: false, reason: "too_new" },
      clients: [{ command: "tg", version: "1.2.3", speaks: latest + 1, seen_at: "1970-01-01T00:00:00.000Z" }],
      rows: {},
    })
  })

  it("names this tool's support even for a file that is not a database", async () => {
    const env = envFor()
    writeFileSync(env.MESSAGING_STORE, "not a database".repeat(80))
    expect(await infoOf(env)).toMatchObject({ opens: false, schema: { speaks: latest } })
  })
})

describe("compatibilityOf", () => {
  const migrations = [
    { version: 1, minCompatible: 1, statements: [] },
    { version: 2, minCompatible: 2, statements: [] },
    { version: 3, minCompatible: 2, statements: [] },
  ]

  it("takes the highest minimum among the versions a run would add", () => {
    expect(compatibilityOf({ version: 1, minCompatible: 1 }, migrations).upgrade).toEqual({
      version: 3,
      minCompatible: 2,
    })
    expect(compatibilityOf({ version: 2, minCompatible: 2 }, migrations).upgrade).toEqual({
      version: 3,
      minCompatible: 2,
    })
    expect(compatibilityOf({ version: 3, minCompatible: 2 }, migrations).upgrade).toBeNull()
  })
})

describe("store info in a tool that is not a messenger", () => {
  it("runs with no profile and no account", async () => {
    const env = envFor()
    await storeAt(env)
    const app = { command: "notes", appName: "notes-cli", envPrefix: "NOTES", description: "A test", version: "1.0.0" }
    const streams = captureStreams()

    const code = await run(
      ["store", "info", "--json"],
      { app: { ...app, messenger: false }, commands: () => [sharedStoreCommand()] },
      { streams, tty: false, env },
    )

    expect(code, streams.stderr.join("\n")).toBe(0)
    expect(JSON.parse(streams.stdout[0] ?? "null").item.schema).toMatchObject({ speaks: latest, reason: "current" })
  })
})
