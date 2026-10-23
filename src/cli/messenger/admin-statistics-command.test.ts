import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
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
  await store.chats.saveChats(account, [
    { id: "7", title: "Synthetic club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.messages.saveMessages(
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
    const result = await call(["stats", "messages", "unanswered", "chat:7", "--json", "older_than:1h"])
    expect(result.code, result.stderr).toBe(0)
    const found = v.parse(itemEnvelopeSchema(ENTITIES.admin_report), JSON.parse(result.stdout))
    expect(found.item).toMatchObject({
      report: "unanswered",
      total: 1,
      rows: [{ ref: "msg:chat/500/7/1", id: "msg:chat/500/7/1", status: "no-observed-answer" }],
    })
    const row = found.item.rows[0] as (typeof found.item.rows)[number]
    expect(found.next?.[0]).toMatchObject({ step: "stats.evidence", args: { message: row.id, component: "report" } })
    const evidence = await call([
      "stats",
      "messages",
      "evidence",
      row.id,
      "--component",
      "report",
      "--selection",
      JSON.stringify(row.selection),
      "--jsonl",
    ])
    expect(evidence.code, evidence.stderr).toBe(0)
    const [line, end] = evidence.stdout
      .trim()
      .split("\n")
      .map((one) => JSON.parse(one))
    expect(line).toMatchObject({ type: "item", data: { message: { ref: "msg:chat/500/7/1" } } })
    expect(end).toMatchObject({ type: "end", complete: true })
    const responses = await call(["stats", "contacts", "responses", "--answerer", "12", "--json"])
    expect(responses.code, responses.stderr).toBe(0)
    expect(JSON.parse(responses.stdout).item).toMatchObject({
      report: "responses",
      rows: [{ ref: "contact:chat/12", id: "12", answered: 0, median_ms: null }],
    })
    const newcomers = await call(["stats", "chats", "newcomers", "7", "--within", "3d", "--json"])
    expect(newcomers.code, newcomers.stderr).toBe(0)
    expect(JSON.parse(newcomers.stdout).item).toMatchObject({ report: "newcomers", rows: [] })
    const dated = await call([
      "stats",
      "chats",
      "newcomers",
      "7",
      "--since-time",
      "2026-09-01",
      "--until-time",
      "2026-09-01",
      "--timezone",
      "Asia/Vladivostok",
      "--json",
    ])
    expect(dated.code, dated.stderr).toBe(0)
    expect(JSON.parse(dated.stdout).meta).toMatchObject({
      timezone: "Asia/Vladivostok",
      window: { since: "2026-08-31T14:00:00.000Z", until: "2026-09-01T13:59:59.999Z" },
    })
    const discussion = await call(["stats", "messages", "discussion", "max_replies:2", "--json"])
    expect(discussion.code, discussion.stderr).toBe(0)
    expect(JSON.parse(discussion.stdout).item).toMatchObject({ report: "discussion", rows: [] })
    expect(connect).not.toHaveBeenCalled()
  })
  it("refuses JSONL for a report, keeps its quality in JSON, and enforces message-read permission", async () => {
    const { call } = await setup()
    const lines = await call(["stats", "messages", "unanswered", "--jsonl", "older_than:1h"])
    expect(lines.code).not.toBe(0)
    expect(JSON.parse(lines.stderr).error).toMatchObject({ code: "validation_error", reason: "output.one-object" })
    const result = await call(["stats", "messages", "unanswered", "--json", "older_than:1h"])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).item).toMatchObject({
      report: "unanswered",
      quality: { counter_freshness: "unknown" },
    })
    const denied = await setup({ messages: "deny" })
    const rejected = await denied.call(["stats", "contacts", "responses", "--answerer", "12", "--json"])
    expect(rejected.code).not.toBe(0)
  })
  it("rejects incomplete response input and invalid nonnegative counters", async () => {
    const { call } = await setup()
    expect((await call(["stats", "contacts", "responses", "--json"])).code).not.toBe(0)
    expect((await call(["stats", "messages", "discussion", "min_views:-1", "--json"])).code).not.toBe(0)
  })
})
