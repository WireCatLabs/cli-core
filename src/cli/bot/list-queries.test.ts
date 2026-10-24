import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { SendJournal } from "../../sends/journal.js"
import { RecipientList } from "../../sends/recipients.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import { botCopy } from "./copy.js"
import type { BotMessenger } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)
const at = "2026-10-01T10:00:00.000Z"
let root: string, env: NodeJS.ProcessEnv, keyring: ReturnType<typeof memoryKeyring>, connected: number

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => {
    connected++
    return {
      me: async () => ({ id: "1", name: "First", username: "first_bot" }),
      menu: async () => [{ name: "help", description: "Help" }],
      webhooks: async () => [{ url: "https://example.invalid/hook", types: null }],
      admins: async () => [
        { id: "42", name: "Alice Example", username: null, role: "admin", rights: ["read"], title: null },
      ],
      close: async () => {},
    }
  },
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
}
const call = async (...argv: string[]) => {
  const streams = captureStreams()
  const code = await run(
    ["first", "bot", ...argv, "--json"],
    { app, commands: () => [botCommand(bot)] },
    { streams, tty: false, env },
  )
  const output = streams.stdout.join("\n")
  return { code, body: output ? JSON.parse(output) : undefined, stderr: streams.stderr.join("\n") }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-list-query-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  process.env.MESSAGING_STORE = join(root, "messages.db")
  env.MESSAGING_STORE = process.env.MESSAGING_STORE
  connected = 0
  for (const profile of ["first", "second"]) {
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }).write("synthetic")
    new ChatRegistry(app, profile, env).rememberBot(profile === "first" ? "1" : "2")
  }
  new ChatRegistry(app, "first", env).observe(
    [
      { id: "-1", title: "Book club", kind: "group" },
      { id: "-2", title: "Bulletin", kind: "channel" },
    ],
    new Date(at),
  )
})

describe("bot lists use their native sources", () => {
  it("checks only the selected profile, without reading or connecting the others", async () => {
    const result = await call("list", "name:first", "--check")
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.items).toHaveLength(1)
    expect(result.body.items[0]).toMatchObject({ name: "first", bot: "first_bot" })
    expect(connected).toBe(1)
  })

  it("narrows the persistent chat registry by native fields", async () => {
    const result = await call("chats", "list", 'title:"Book club" kind:group')
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.items.map((row: { id: string }) => row.id)).toEqual(["-1"])
    expect(connected).toBe(0)
  })

  it("uses the recipient source without changing its allowlist", async () => {
    const list = new RecipientList(botFiles(app, "first", env).recipients, "chat")
    list.add({ id: "-1", title: "Book club", addedAt: at })
    list.add({ id: "-2", title: "Bulletin", addedAt: at })
    const result = await call("recipients", "list", 'id:"-2"')
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.items.map((row: { id: string }) => row.id)).toEqual(["-2"])
    expect(list.read()).toHaveLength(2)
  })

  it("passes exact predicates into the send-journal reader", async () => {
    const journal = new SendJournal(botFiles(app, "first", env).journal)
    journal.append({ at, profile: "first", chatId: "-1", outcome: "sent", messageId: "1" })
    journal.append({ at, profile: "first", chatId: "-2", outcome: "failed", errorCode: "timeout" })
    const result = await call("sends", "list", "outcome:failed error_code:timeout")
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.items).toHaveLength(1)
    expect(result.body.items[0]).toMatchObject({ chat_id: "-2", outcome: "failed" })
    expect(connected).toBe(0)
  })

  it.each([
    ["commands", "list", "name:help"],
    ["webhooks", "list", "url:https"],
    ["chats", "admins", "list", "-1", "role:admin"],
  ])("refuses unsupported provider filters before connecting: %s", async (...argv) => {
    const result = await call(...argv)
    expect(result.code).toBe(2)
    expect(connected).toBe(0)
    expect(result.stderr).toContain("query.unsupported-field")
  })

  it.each([
    ["commands", "list"],
    ["webhooks", "list"],
    ["chats", "admins", "list", "-1"],
  ])("still reads the full provider list without a query: %s", async (...argv) => {
    const result = await call(...argv)
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.items).toHaveLength(1)
    expect(connected).toBe(1)
  })

  it("rejects a malformed local query before checking credentials", async () => {
    const result = await call("chats", "list", "kind:group OR kind:channel")
    expect(result.code).toBe(2)
    expect(connected).toBe(0)
    expect(result.stderr).toContain("query.unsupported-placement")
  })
})

const message = (id: string, outgoing: boolean, timestamp: string): Message => ({
  id,
  chatId: "-1",
  senderId: "42",
  senderName: null,
  timestamp,
  editedAt: null,
  text: "Synthetic",
  outgoing,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

describe("bot message queries", () => {
  it("applies SQLite predicates before the limit, without a connection", async () => {
    await botCopy("chat-bot").keep(
      "1",
      [message("old", true, "2026-10-01T10:00:00.000Z"), message("new", false, "2026-10-02T10:00:00.000Z")],
      "test",
      () => {},
    )
    const result = await call("messages", "list", "-1", "outgoing:true", "--offline", "--limit", "1")
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.items.map((row: { id: string }) => row.id)).toEqual(["old"])
    expect(connected).toBe(0)
  })

  it("records the interpreted time window in the answer", async () => {
    await botCopy("chat-bot").keep("1", [message("1", false, "2026-10-02T10:00:00.000Z")], "test", () => {})
    const result = await call("messages", "list", "-1", 'timestamp>"2026-10-01T00:00:00Z"', "--offline")
    expect(result.code, result.stderr).toBe(0)
    expect(result.body.meta.window.since).toMatch(/^2026-10-01T00:00:00/)
    expect(result.body.items).toHaveLength(1)
  })

  it("requires an explicit local read rather than filtering a remote page", async () => {
    const result = await call("messages", "list", "-1", "outgoing:true")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("--offline")
    expect(connected).toBe(0)
  })

  it("rejects an unsupported time direction before opening a source", async () => {
    const result = await call("messages", "list", "-1", "timestamp<2026-10-01", "--offline")
    expect(result.code).toBe(2)
    expect(connected).toBe(0)
  })
})
