import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
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
      text: id === 1 ? "Synthetic question?" : "Synthetic words",
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

describe("administrator statistics command views", () => {
  it("returns stored report rows and exact evidence without a connection", async () => {
    const { call, connect } = await setup()
    const result = await call(["stats", "messages", "unanswered", "--chat", "7", "--json", "--older-than", "1h"])
    expect(result.code, result.stderr).toBe(0)
    const found = JSON.parse(result.stdout)
    expect(found).toMatchObject({
      report: "unanswered",
      total: 1,
      items: [{ message: "msg:chat/500/7/1", status: "no-observed-answer" }],
    })
    const args = found.items[0].drilldown.arguments
    const evidence = await call([
      "stats",
      "messages",
      "evidence",
      args.message,
      "--component",
      "report",
      "--selection",
      JSON.stringify(args.selection),
      "--jsonl",
    ])
    expect(evidence.code, evidence.stderr).toBe(0)
    expect(JSON.parse(evidence.stdout)).toMatchObject({ message: { id: "1" } })
    const responses = await call(["stats", "contacts", "responses", "--answerer", "12", "--json"])
    expect(responses.code, responses.stderr).toBe(0)
    expect(JSON.parse(responses.stdout)).toMatchObject({
      report: "responses",
      items: [{ id: "12", answered: 0, medianMilliseconds: null }],
    })
    const newcomers = await call(["stats", "chats", "newcomers", "7", "--within", "3d", "--json"])
    expect(newcomers.code, newcomers.stderr).toBe(0)
    expect(JSON.parse(newcomers.stdout)).toMatchObject({ report: "newcomers", items: [] })
    const discussion = await call(["stats", "messages", "discussion", "--max-replies", "2", "--json"])
    expect(discussion.code, discussion.stderr).toBe(0)
    expect(JSON.parse(discussion.stdout)).toMatchObject({ report: "discussion", items: [] })
    expect(connect).not.toHaveBeenCalled()
  })
  it("keeps quality on JSONL rows and enforces message-read permission", async () => {
    const { call } = await setup()
    const result = await call(["stats", "messages", "unanswered", "--jsonl", "--older-than", "1h"])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ report: "unanswered", quality: { counterFreshness: "unknown" } })
    const denied = await setup({ messages: "deny" })
    const rejected = await denied.call(["stats", "contacts", "responses", "--answerer", "12", "--json"])
    expect(rejected.code).not.toBe(0)
  })
  it("rejects incomplete response input and invalid nonnegative counters", async () => {
    const { call } = await setup()
    expect((await call(["stats", "contacts", "responses", "--json"])).code).not.toBe(0)
    expect((await call(["stats", "messages", "discussion", "--min-views", "-1", "--json"])).code).not.toBe(0)
  })
})
