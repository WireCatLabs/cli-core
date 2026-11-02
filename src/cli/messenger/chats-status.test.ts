import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import { openCache } from "../../store/open.js"
import { COVERAGE_SQL } from "../../store/sqlite/completeness.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const account = { provider: "chat", account: "500" }

const message = (id: string, chatId: string, timestamp: string): Message => ({
  id,
  chatId,
  senderId: "11",
  senderName: "Synthetic author",
  timestamp,
  editedAt: null,
  text: "synthetic",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const chat = (id: string, lastMessageAt: string | null = null) => ({
  id,
  title: `Chat ${id}`,
  kind: "group" as const,
  unreadCount: 0,
  lastMessageAt,
  participantsCount: null,
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "chats-status-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  rememberAccount(app, "default", account.account, env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats(account, [
    chat("complete", "2026-03-02T00:00:00.000Z"),
    chat("ranged", "2026-03-05T00:00:00.000Z"),
    chat("pushed"),
    chat("never"),
    chat("hidden"),
  ])
  await store.messages.saveMessages(
    account,
    "complete",
    [message("1", "complete", "2026-03-01T00:00:00.000Z"), message("2", "complete", "2026-03-02T00:00:00.000Z")],
    { via: "history" },
  )
  await store.sync.markRange(account, "complete", 1, 2)
  await store.sync.setSyncState(account, "history_start:complete", "1")
  await store.messages.saveMessages(account, "ranged", [message("5", "ranged", "2026-03-03T00:00:00.000Z")], {
    via: "history",
  })
  await store.sync.markRange(account, "ranged", 5, 5)
  await store.messages.saveMessages(account, "pushed", [message("9", "pushed", "2025-12-31T00:00:00.000Z")], {
    via: "test",
  })
  await store.messages.saveMessages(account, "hidden", [message("3", "hidden", "2020-01-01T00:00:00.000Z")], {
    via: "test",
  })
  const other = { provider: "chat", account: "600" }
  await store.chats.saveChats(other, [chat("elsewhere")])
  await store.messages.saveMessages(other, "elsewhere", [message("4", "elsewhere", "2019-01-01T00:00:00.000Z")], {
    via: "test",
  })
  await store.close()
  const database = await openCache(env.MESSAGING_STORE)
  database.prepare("UPDATE chats SET searchable = 0 WHERE external_id = 'hidden'").run()
  database.close()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("chats status never connects")
    },
    chatArgument: "a chat",
  }
  const call = async (args: string[]) => {
    const streams = captureStreams()
    const code = await run(
      ["chats", "status", ...args],
      { app, commands: () => [chatsCommand(messenger)] },
      {
        streams,
        tty: false,
        env,
      },
    )
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
  const searches = async () => {
    const database = await openCache(env.MESSAGING_STORE)
    try {
      return Number(database.prepare("SELECT count(*) AS n FROM searches").get()?.n)
    } finally {
      database.close()
    }
  }
  return { env, call, searches }
}

describe("chats status", () => {
  it("splits the account's searchable chats into fetched, partial and never, without recording", async () => {
    const { call, searches } = await setup()
    const before = await searches()
    const result = await call(["--no-record", "--json"])
    expect(result.code, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout)
    v.parse(itemEnvelopeSchema(ENTITIES.chat_coverage), body)
    expect(body.item).toEqual({
      chats: 4,
      fetched: 1,
      partial: 2,
      never: 1,
      oldest_message_at: "2025-12-31T00:00:00.000Z",
    })
    expect(body.item.fetched + body.item.partial + body.item.never).toBe(body.item.chats)
    expect(await searches()).toBe(before)
  })

  it("reads the oldest and newest through messages_by_time, never a scan or a sort", async () => {
    const { env } = await setup()
    const database = await openCache(env.MESSAGING_STORE)
    try {
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${COVERAGE_SQL}`)
        .all(1)
        .map((row) => String(row.detail))
      expect(plan.filter((detail) => detail.includes("messages_by_time"))).toHaveLength(2)
      expect(plan.filter((detail) => detail.startsWith("SCAN") || detail.includes("TEMP B-TREE"))).toEqual([])
    } finally {
      database.close()
    }
  })
})
