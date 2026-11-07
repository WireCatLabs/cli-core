import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, renameSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { storeSummary } from "../cli/messenger/store-maintenance-command.js"
import { run } from "../cli/program.js"
import { storeRecoveryCheck } from "../cli/store-recover.js"
import { storeHealth } from "./health.js"
import { damageMarkPath, markStoreDamaged, readDamageMark, readHealthMark, recordDeepCheck } from "./marks.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openSqlite } from "./sqlite/open.js"
import { openStoreContext } from "./sqlite/open-store.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }

const seeded = async () => {
  const root = mkdtempSync(join(tmpdir(), "store-marks-"))
  const path = join(root, "m.db")
  const database = await openCache(path)
  migrate(database, { now: () => Date.UTC(2026, 9, 1) })
  database.exec(
    "INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'chat', '500', 0, 0)",
  )
  const page = Number(database.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'accounts'").get()?.rootpage)
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size)
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  database.close()
  const damage = () => {
    const file = openSync(path, "r+")
    writeSync(file, Buffer.alloc(64, 0xa5), 0, 64, (page - 1) * pageSize)
    closeSync(file)
  }
  return { root, path, damage }
}

/** One command that reads the damaged table, as a sync would before writing. */
const readsAccounts = (path: string) =>
  new Command("sync").action(async () => {
    const { database } = await openSqlite(path, { readOnly: true })
    try {
      database.prepare("SELECT * FROM accounts").all()
    } finally {
      database.close()
    }
  })

const runSync = async (root: string, path: string) =>
  run(
    ["sync"],
    { app, commands: () => [readsAccounts(path)] },
    {
      streams: captureStreams(),
      tty: false,
      env: { APP_STATE_DIR: join(root, "state"), APP_CONFIG_DIR: join(root, "config"), MESSAGING_STORE: path },
    },
  )

describe("the damage mark", () => {
  it("is left by a run that finds the store damaged, and then every writable open refuses", async () => {
    const { root, path, damage } = await seeded()
    damage()
    expect(await runSync(root, path)).not.toBe(0)

    expect(readDamageMark(path)).toMatchObject({ command: "app sync", cli_version: "1.2.3", error: /malformed/ })
    expect(readDamageMark(path)?.run_id).toBeTruthy()
    await expect(openStoreContext({ path, command: "app" })).rejects.toMatchObject({
      code: "configuration_error",
      details: { reason: "store.damaged" },
      message: expect.stringContaining("`app store recover`"),
    })
    const reading = await openStoreContext({ path, readOnly: true })
    reading.database.close()
  })

  it("keeps the first sighting, and is not left by a failure that is not damage", async () => {
    const { path } = await seeded()
    expect(markStoreDamaged(new Error("database is locked"), { store: path, command: "app sync" })).toBe(false)
    expect(existsSync(damageMarkPath(path))).toBe(false)

    const corrupt = Object.assign(new Error("fts5: corruption found reading blob 7"), { errcode: 267 })
    expect(markStoreDamaged(corrupt, { store: path, command: "app sync", now: () => 1 })).toBe(true)
    expect(markStoreDamaged(corrupt, { store: path, command: "app later", now: () => 2 })).toBe(false)
    expect(readDamageMark(path)).toMatchObject({ command: "app sync", at: "1970-01-01T00:00:00.001Z" })
  })

  it("no longer counts once the file it was seen in is replaced", async () => {
    const { path } = await seeded()
    const corrupt = Object.assign(new Error("database disk image is malformed"), { errcode: 11 })
    markStoreDamaged(corrupt, { store: path, command: "app sync" })
    copyFileSync(path, `${path}.restored`)
    renameSync(`${path}.restored`, path)

    expect(readDamageMark(path)).toBeNull()
    expect(existsSync(damageMarkPath(path))).toBe(false)
    const writable = await openStoreContext({ path })
    writable.database.close()
  })
})

describe("the health mark", () => {
  it("keeps the last deep check that passed as the last known good, and a pass lifts the damage mark", async () => {
    const { path, damage } = await seeded()
    const good = recordDeepCheck(path, await storeHealth(path, { deep: true }), {
      cli: "app",
      version: "1.2.3",
      schema: 54,
      now: () => Date.UTC(2026, 10, 1),
    })
    expect(good.previous).toBeNull()
    expect(readHealthMark(path)).toMatchObject({
      ok: true,
      schema: 54,
      cli: "app",
      last_ok_at: "2026-11-01T00:00:00.000Z",
    })

    damage()
    const check = await storeRecoveryCheck({ MESSAGING_STORE: path }, "app", "1.2.3")
    expect(check.ok).toBe(false)
    expect(check.lastKnownGood).toBe("2026-11-01T00:00:00.000Z")
    expect(readHealthMark(path)).toMatchObject({ ok: false, last_ok_at: "2026-11-01T00:00:00.000Z" })

    const corrupt = Object.assign(new Error("database disk image is malformed"), { errcode: 11 })
    markStoreDamaged(corrupt, { store: path, command: "app sync" })
    const passed = recordDeepCheck(path, { ok: true, problems: 0 }, { cli: "app", schema: 54 })
    expect(passed.cleared).toMatchObject({ command: "app sync" })
    expect(readDamageMark(path)).toBeNull()
  })
  it("doctor names a run's damage the quick check cannot see, and its deep check records the store and lifts it", async () => {
    const { path } = await seeded()
    const env = { MESSAGING_STORE: path }
    const corrupt = Object.assign(new Error("database disk image is malformed"), { errcode: 11 })
    markStoreDamaged(corrupt, { store: path, command: "app sync" })

    const quick = await storeSummary(env, { command: "app" })
    expect(quick).toMatchObject({ health: { ok: true }, damageMark: { command: "app sync" } })
    expect((quick as { damage?: { what: string } }).damage?.what).toMatch(/`app sync` found the store damaged/)

    const deep = await storeSummary(env, { deep: true, command: "app", version: "1.2.3" })
    expect(deep).toMatchObject({ health: { ok: true }, damageMarkCleared: { command: "app sync" } })
    expect(deep).not.toHaveProperty("damage")
    expect(readHealthMark(path)).toMatchObject({
      ok: true,
      cli: "app",
      cli_version: "1.2.3",
      schema: expect.any(Number),
    })
  })
})
