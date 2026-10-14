import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { searchesCommand } from "./searches-command.js"
import { statsCommand } from "./stats-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const setup = async (permissions?: object) => {
  const root = mkdtempSync(join(tmpdir(), "ranking-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  if (permissions) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ defaults: { permissions } }))
  }
  const account = { provider: "chat", account: "500" }
  rememberAccount(app, "default", account.account, env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.saveChats(account, [
    { id: "7", title: "Synthetic club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.saveMessages(
    account,
    "7",
    [1, 2, 3].map((id) => ({
      id: String(id),
      chatId: "7",
      senderId: id === 3 ? "12" : "11",
      senderName: id === 3 ? "Bob" : "Alice",
      timestamp: `2026-10-07T10:00:0${id}Z`,
      text: "Synthetic words",
      editedAt: null,
      replyTo: null,
      forwardedFrom: null,
      reactions: { total: id, counts: [], mine: null },
      outgoing: false,
      attachments: [],
      providerMetadata: { views: id, graph: { version: 1, reply: null } },
    })),
    { via: "test" },
  )
  await store.close()
  const connect = vi.fn(async () => {
    throw new Error("ranking connected unexpectedly")
  })
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
  }
  const call = async (args: string[]) => {
    const streams = captureStreams()
    const code = await run(
      args,
      { app, commands: () => [statsCommand(messenger), searchesCommand(messenger)] },
      { streams, tty: false, env },
    )
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
  return { call, connect }
}

describe("ranking command views", () => {
  it("ranks messages, authors, weighted scores and JSONL without connecting", async () => {
    const { call, connect } = await setup()
    const messages = await call([
      "stats",
      "messages",
      "top",
      "--measure",
      "views",
      "--chat",
      "7",
      "--timezone",
      "UTC",
      "--limit",
      "2",
      "--json",
    ])
    expect(messages.code, messages.stderr).toBe(0)
    const ranked = v.parse(itemEnvelopeSchema(ENTITIES.ranking), JSON.parse(messages.stdout))
    expect(ranked.item).toMatchObject({
      total: 3,
      rows: [
        { id: "3", value: 3 },
        { id: "2", value: 2 },
      ],
    })
    expect(ranked.next?.map(({ step }) => step)).toEqual(["stats.evidence"])
    const authors = await call([
      "stats",
      "contacts",
      "top",
      "--score",
      "active",
      "--weights",
      '{"messages":1}',
      "--min-messages",
      "2",
      "--message-kind",
      "all",
      "--exact",
      "--source",
      "personal",
      "--json",
    ])
    expect(authors.code, authors.stderr).toBe(0)
    expect(JSON.parse(authors.stdout).item.rows[0]).toMatchObject({ id: "11", value: 100 })
    const lines = await call(["stats", "contacts", "top", "--measure", "words", "--jsonl"])
    expect(lines.code, lines.stderr).toBe(0)
    expect(
      lines.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).rows),
    ).toEqual([expect.any(Array)])
    expect(connect).not.toHaveBeenCalled()
  })
  it("follows exact evidence selections and cursor continuation", async () => {
    const { call } = await setup()
    const top = await call(["stats", "contacts", "top", "--json"])
    const row = JSON.parse(top.stdout).item.rows[0]
    const args = [
      "stats",
      "contacts",
      "evidence",
      row.id,
      "--selection",
      JSON.stringify(row.selection),
      "--component",
      "messages",
      "--limit",
      "1",
      "--json",
    ]
    const first = await call(args)
    expect(first.code, first.stderr).toBe(0)
    const page = v.parse(listEnvelopeSchema(ENTITIES.evidence), JSON.parse(first.stdout))
    expect(page.next?.[0]).toMatchObject({ step: "page.next", args: { person: "11", component: "messages" } })
    const second = await call([...args, "--cursor", page.page.cursor as string])
    expect(second.code, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout).page.has_more).toBe(false)
  })
  it("saves and replays a pinned ranking with its weights and explicit overrides", async () => {
    const { call } = await setup()
    const top = await call(["stats", "contacts", "top", "--weights", '{"messages":1}', "--json"])
    const selection = JSON.parse(top.stdout).item.rows[0].selection
    const saved = await call([
      "searches",
      "create",
      "ranking-fixture",
      "--selection",
      JSON.stringify(selection),
      "--json",
    ])
    expect(saved.code, saved.stderr).toBe(0)
    const replay = await call([
      "stats",
      "contacts",
      "top",
      "--saved",
      "ranking-fixture",
      "--weights",
      '{"words":1}',
      "--json",
    ])
    expect(replay.code, replay.stderr).toBe(0)
    expect(JSON.parse(replay.stdout).item.weights).toEqual({ words: 1 })
    expect(JSON.parse(replay.stdout).item.rows[0].id).toBe("11")
  })
  it("honors source-resource denials and validates incompatible choices", async () => {
    const { call, connect } = await setup({ messages: "deny", stats: "allow" })
    const denied = await call(["stats", "contacts", "top", "--json"])
    expect(denied.code).not.toBe(0)
    expect(denied.stderr).toContain("messages")
    const ordinary = await setup()
    const invalid = await ordinary.call([
      "stats",
      "messages",
      "top",
      "--measure",
      "views",
      "--score",
      "engaging",
      "--json",
    ])
    expect(invalid.code).toBe(2)
    expect(JSON.parse(invalid.stderr).error.code).toBe("validation_error")
    expect(connect).not.toHaveBeenCalled()
  })
  it("refuses each ranking refresh before opening a messenger connection", async () => {
    for (const target of ["messages", "contacts"]) {
      const { call, connect } = await setup({ [`stats.${target}.top.sync-first`]: "deny" })
      const result = await call(["stats", target, "top", "--sync-first", "--json"])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("sync-first")
      expect(connect).not.toHaveBeenCalled()
    }
  })
})
