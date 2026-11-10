import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { Message } from "../../domain/models.js"
import { migrate } from "../../store/migrations.js"
import { openSqlite } from "../../store/sqlite/open.js"
import { newestMessagesQuery, replyDelaysQuery, TAIL_SQL } from "../../store/sqlite/reply-times.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { searchesCommand } from "./searches-command.js"
import { statsCommand } from "./stats-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const MINUTE = 60_000

const message = (chatId: string, id: number, at: string, outgoing: boolean, text = "Synthetic words"): Message => ({
  id: String(id),
  chatId,
  senderId: outgoing ? "500" : "11",
  senderName: outgoing ? "Owner" : "Alice",
  timestamp: at,
  text,
  editedAt: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  outgoing,
  attachments: [],
})

const setup = async (inMuted: Message[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "reply-stats-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  const account = { provider: "chat", account: "500" }
  rememberAccount(app, "default", account.account, env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  const chat = { unreadCount: 0, lastMessageAt: null, participantsCount: 2 }
  await store.chats.saveChats(account, [
    { ...chat, id: "7", title: "Alice", kind: "dialog" },
    { ...chat, id: "8", title: "Club", kind: "group" },
    { ...chat, id: "9", title: "Muted", kind: "dialog", muted: true },
    { ...chat, id: "10", title: "News", kind: "channel" },
  ])
  const save = (chatId: string, messages: Message[]) =>
    store.messages.saveMessages(account, chatId, messages, { via: "test" })
  await save("7", [
    message("7", 1, "2026-10-07T10:00:00Z", false),
    message("7", 2, "2026-10-07T10:01:00Z", false, "Are you there?"),
    message("7", 3, "2026-10-07T10:03:00Z", true),
    message("7", 4, "2026-10-07T10:04:00Z", true),
    message("7", 5, "2026-10-07T12:03:00Z", false),
    message("7", 6, "2026-10-08T08:00:00Z", true),
    message("7", 7, "2026-10-08T09:00:00Z", false, "Can we talk?"),
  ])
  await save("8", [
    message("8", 1, "2026-10-08T07:00:00Z", true),
    message("8", 2, "2026-10-08T07:30:00Z", false),
    { ...message("8", 3, "2026-10-08T08:30:00Z", false, "see this"), mentions: ["500"] },
  ])
  await save("9", [message("9", 1, "2026-10-08T06:00:00Z", false, "Lunch?"), ...inMuted])
  await save("10", [message("10", 1, "2026-10-08T05:00:00Z", false, "Any news?")])
  await store.close()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: vi.fn(async () => {
      throw new Error("connected unexpectedly")
    }),
    chatArgument: "a chat",
  }
  return async (...args: string[]) => {
    const streams = captureStreams()
    const code = await run(
      args,
      { app, commands: () => [statsCommand(messenger), searchesCommand(messenger)] },
      { streams, tty: false, env },
    )
    const stdout = streams.stdout.join("")
    return { code, json: stdout ? JSON.parse(stdout) : undefined, stderr: streams.stderr.join("") }
  }
}

describe("stats messages responses and waiting", () => {
  it("times one reply per run from its first message, and reads the run before the period", async () => {
    const call = await setup()
    const me = await call("stats", "messages", "responses", "--by", "day", "--timezone", "UTC", "--json")
    expect(me.json.item).toEqual({
      who: "me",
      replies: 2,
      median_ms: 36_000_000,
      p90_ms: 71_820_000,
      mean_ms: 36_000_000,
      buckets: { under_5m: 1, under_1h: 0, under_1d: 1, over_1d: 0 },
      rows: [
        { key: "2026-10-07", replies: 1, median_ms: 3 * MINUTE, p90_ms: 3 * MINUTE, mean_ms: 3 * MINUTE },
        { key: "2026-10-08", replies: 1, median_ms: 71_820_000, p90_ms: 71_820_000, mean_ms: 71_820_000 },
      ],
    })
    const others = await call("stats", "messages", "responses", "--who", "others", "--json")
    expect(others.json.item).toMatchObject({ replies: 2, median_ms: 5_400_000, rows: [] })
    const period = await call(
      "stats",
      "messages",
      "responses",
      "--timezone",
      "UTC",
      "--json",
      "--",
      "date>=2026-10-08",
      "chat:7",
    )
    expect(period.json.item).toMatchObject({ replies: 1, median_ms: 71_820_000 })
    expect((await call("stats", "messages", "responses", "--json", "--", "kind:group")).json.item.replies).toBe(0)
    const words = await call("stats", "messages", "responses", "--json", "--", "hello")
    expect([words.code, words.stderr]).toEqual([2, expect.stringContaining("date:, chat:, kind: and muted:")])
    expect((await call("stats", "messages", "waiting", "--json", "--", "chat:Al*")).code).toBe(2)
  })

  it("leaves muted chats out of reply times and waiting chats on muted:false", async () => {
    const call = await setup([message("9", 2, "2026-10-08T06:10:00Z", true)])
    const replies = async (...terms: string[]) =>
      (await call("stats", "messages", "responses", "--json", "--", ...terms)).json.item.replies
    expect([await replies(), await replies("muted:false"), await replies("muted:true")]).toEqual([3, 2, 1])
    expect(await replies("muted:false", "chat:7")).toBe(2)
    const both = await call("stats", "messages", "responses", "--json", "--", "muted:true", "muted:false")
    expect([both.code, both.stderr]).toEqual([2, expect.stringContaining("cannot both hold")])
    const waiting = await call("stats", "messages", "waiting", "--json", "--", "muted:true")
    expect(waiting.json.item.chats).toBe(0)
  })

  it("counts chats whose newest message asks the owner, leaving out muted chats and channels", async () => {
    const call = await setup()
    expect((await call("stats", "messages", "waiting", "--json")).json.item).toEqual({
      chats: 2,
      messages: 3,
      oldest_at: "2026-10-08T07:30:00.000Z",
      by_kind: { private: 1, group: 1 },
    })
    expect((await call("stats", "messages", "waiting", "--json", "--", "kind:group")).json.item).toMatchObject({
      chats: 1,
      messages: 2,
    })
    expect(
      (await call("stats", "messages", "waiting", "--json", "--", 'date:[* TO "2026-10-08T08:45:00Z"]')).json.item
        .chats,
    ).toBe(1)
  })

  it("keeps no search history with --no-record", async () => {
    const call = await setup()
    const history = async () => (await call("searches", "history", "--json")).json.items.length
    const before = await history()
    expect((await call("stats", "messages", "responses", "--no-record", "--json")).code).toBe(0)
    expect((await call("stats", "messages", "waiting", "--no-record", "--json")).code).toBe(0)
    expect(await history()).toBe(before)
  })

  it("reads messages by index, never by a scan", async () => {
    const sqlite = await openSqlite(":memory:")
    migrate(sqlite.database)
    const scope = {
      accounts: [{ provider: "chat", account: "500" }],
      chats: [],
      kinds: [],
      since: 1,
      until: 2,
    }
    const plans = [replyDelaysQuery(scope, "me", 0), newestMessagesQuery(scope, 0), { sql: TAIL_SQL, params: [1, 100] }]
    for (const { sql, params } of plans) {
      const plan = sqlite.database
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(params as never[]))
        .map((row) => String(row.detail))
      expect(plan.filter((line) => /^SCAN (messages|m|n|p|l|q)\b/.test(line) && !line.includes("USING"))).toEqual([])
      expect(plan.join("\n")).toContain("messages_by_time")
    }
    sqlite.database.close()
  })
})
