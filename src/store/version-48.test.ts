import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import { run } from "../cli/program.js"
import type { Message } from "../domain/models.js"
import { rollBackTo } from "../testing/older-store.js"
import { sharedProgram } from "../testing/shared-program.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const LEAKED: AccountKey = { provider: "chat", account: "500" }
const REAL: AccountKey = { provider: "telegram", account: "1" }

const message = (id: string, chatId: string, senderId: string, text: string): Message => ({
  id,
  chatId,
  senderId,
  senderName: `Person ${senderId}`,
  timestamp: `2026-10-0${id}T10:00:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const counts = async (path: string) => {
  const database = await openCache(path)
  try {
    const of = (sql: string) => Number(database.prepare(sql).get()?.n)
    const chatRows = (table: string) =>
      of(`SELECT count(*) AS n FROM ${table} WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'chat')`)
    return {
      accounts: of("SELECT count(*) AS n FROM accounts WHERE provider = 'chat'"),
      identities: chatRows("account_identities"),
      chats: chatRows("chats"),
      involvements: chatRows("involvements"),
      messages: chatRows("messages"),
      cursors: chatRows("sync_cursors"),
      flag: of("SELECT count(*) AS n FROM store_settings WHERE key = 'test_accounts_to_purge'"),
    }
  } finally {
    database.close()
  }
}

it("removes the test messenger's account that tests leaked into a store, and keeps every other account", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-48-")), "wirecat.db")
  const store = await openStore({ path })
  await store.messages.saveMessages(LEAKED, "7", [message("1", "7", "11", "leaked lighthouse")], { via: "history" })
  await store.messages.saveMessages(LEAKED, "8", [message("2", "8", "12", "leaked lighthouse again")], {
    via: "history",
  })
  await store.messages.saveMessages(
    LEAKED,
    "9",
    [message("3", "9", "11", "leaked harbour"), message("4", "9", "13", "leaked harbour twice")],
    { via: "history" },
  )
  await store.sync.setSyncState(LEAKED, "updates", "42")
  await store.messages.saveMessages(REAL, "70", [message("5", "70", "21", "real lighthouse")], { via: "history" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 48)
  old.close()
  expect(await counts(path)).toEqual({
    accounts: 1,
    identities: 3,
    chats: 3,
    involvements: 4,
    messages: 4,
    cursors: 1,
    flag: 0,
  })

  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.accounts.accounts()).toEqual([REAL])
    const hits = await upgraded.messages.search("lighthouse", { limit: 10 })
    expect(hits.items.map((hit) => hit.text)).toEqual(["real lighthouse"])
  } finally {
    await upgraded.close()
  }
  expect(await counts(path)).toEqual({
    accounts: 0,
    identities: 0,
    chats: 0,
    involvements: 0,
    messages: 0,
    cursors: 0,
    flag: 0,
  })

  const streams = captureStreams()
  const env = { MESSAGING_STORE: path, CHAT_STATE_DIR: join(path, "..", "state"), CHAT_CONFIG_DIR: join(path, "..") }
  expect(await run(["store", "check", "--json"], sharedProgram, { streams, tty: false, env })).toBe(0)
  expect(JSON.parse(streams.stdout[0] ?? "null").item).toMatchObject({
    ok: true,
    integrity: ["ok"],
    foreign_key_violations: 0,
  })
})

it("leaves a store with no test account without the purge key, so a test's own chat rows stay", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-48-")), "wirecat.db")
  const store = await openStore({ path })
  await store.messages.saveMessages(LEAKED, "7", [message("1", "7", "11", "kept")], { via: "history" })
  await store.close()

  expect(await counts(path)).toMatchObject({ accounts: 1, messages: 1, flag: 0 })
})
