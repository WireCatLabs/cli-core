import { closeSync, copyFileSync, mkdtempSync, openSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { migrate } from "../store/migrations.js"
import { openCache } from "../store/open.js"
import { run } from "./program.js"
import { recoveryNotes, storeRecoverCommand, storeRecoveryCheck, storeRecoveryRun } from "./store-recover.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const damagedStore = async () => {
  const root = mkdtempSync(join(tmpdir(), "store-recover-cli-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const database = await openCache(env.MESSAGING_STORE)
  migrate(database, { now: () => 0 })
  database.exec(
    "INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'chat', '500', 0, 0)",
  )
  const page = Number(
    database.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'email_words_data'").get()?.rootpage,
  )
  const size = Number(database.prepare("PRAGMA page_size").get()?.page_size)
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  database.close()
  const clean = `${env.MESSAGING_STORE}.clean`
  copyFileSync(env.MESSAGING_STORE, clean)
  const file = openSync(env.MESSAGING_STORE, "r+")
  writeSync(file, Buffer.alloc(64, 0xa5), 0, 64, (page - 1) * size)
  closeSync(file)
  return { env, clean }
}

const copyOf = (clean: string) => async (_path: string, target: string) => {
  copyFileSync(clean, target)
  return { errors: [], read: {} }
}

describe("store recover", () => {
  it("answers a damaged store in plain words, with the commands to run", async () => {
    const { env } = await damagedStore()
    const streams = captureStreams()
    const code = await run(
      ["store", "recover", "--json"],
      { app, commands: () => [new Command("store").addCommand(storeRecoverCommand({ command: "chat" }))] },
      { streams, tty: false, env },
    )
    expect(code).toBe(0)
    const { item } = JSON.parse(streams.stdout[0] ?? "null")
    expect(item).toMatchObject({ exists: true, ok: false })
    expect(item.damaged_search_indexes.map((index: { name: string }) => index.name)).toContain("email_words")
    expect(Object.keys(item.explanation)).toEqual([
      "what",
      "causes",
      "investigate",
      "impact",
      "external_unaffected",
      "steps",
    ])
    expect(item.next.at(-1)).toBe("chat store recover run")
  })

  it("says a missing store is fine and a healthy one needs nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-recover-none-"))
    const missing = await storeRecoveryCheck({ MESSAGING_STORE: join(root, "none.db") }, "chat")
    expect(missing).toMatchObject({ exists: false, ok: true, next: [] })
    expect(recoveryNotes(missing)).toEqual(["no store yet"])
    const { env, clean } = await damagedStore()
    const healthy = await storeRecoveryCheck({ ...env, MESSAGING_STORE: clean }, "chat")
    expect(healthy).toMatchObject({ ok: true, next: [], explanation: null })
    expect(recoveryNotes(healthy)[0]).toMatch(/healthy/)
  })

  it("refuses to run while a WireCat timer is scheduled, naming the command that stops it", async () => {
    const { env } = await damagedStore()
    await expect(storeRecoveryRun(env, { command: "chat", timers: () => ["memo-import.timer"] })).rejects.toThrow(
      "systemctl --user stop memo-import.timer",
    )
  })

  it("runs the recovery, and says where the damaged file is and what to run next", async () => {
    const { env, clean } = await damagedStore()
    const answer = await storeRecoveryRun(env, { command: "chat", timers: () => [], copy: copyOf(clean) })
    expect(answer.checkedOk).toBe(true)
    expect(answer.next.at(-1)).toMatch(/systemctl --user start/)
    expect(recoveryNotes(answer)[0]).toContain(answer.keptAt)
    expect((await storeRecoveryCheck(env, "chat")).ok).toBe(true)
  })
})
