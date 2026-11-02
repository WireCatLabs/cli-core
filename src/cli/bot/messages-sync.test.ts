import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import type { BotAdapter, BotConnectOptions, BotMessenger } from "./port.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)
const START = Date.parse("2026-09-01T00:00:00Z")

const message = (n: number): Message => ({
  id: `m${n}`,
  chatId: "-100",
  senderId: "42",
  senderName: "Ann",
  timestamp: new Date(START + n * 60_000).toISOString(),
  editedAt: null,
  text: `message ${n}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const CHAT = Array.from({ length: 250 }, (_, n) => message(n))

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>

/** Newest first, back from `before` — as MAX's getMessages pages by time. */
const adapter: BotAdapter = {
  me: async () => ({ id: "900", name: "Helper", username: "helper_bot" }),
  close: async () => {},
  historyBefore: async (_chat, { limit, before }) => {
    const older = CHAT.filter((one) => before === undefined || one.timestamp <= before).reverse()
    return { items: older.slice(0, limit), hasMore: older.length > limit }
  },
}

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  fetching: { page: 100, pause: "1ms", maxPages: 10, orderBy: "time" },
}

const call = async (argv: string[], messenger = bot) => {
  const streams = captureStreams()
  const code = await run(
    ["sales", "bot", ...argv],
    { app, commands: () => [botCommand(messenger)] },
    { streams, tty: false, env },
  )
  const out = streams.stdout.join("\n")
  return { code, answer: out ? JSON.parse(out) : undefined, stderr: streams.stderr.join("\n") }
}

const saveBotPermissions = (permissions: Record<string, string>) => {
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(join(root, "config", "config.json"), JSON.stringify({ bot: { profiles: { sales: { permissions } } } }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-fetch-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("t")
})

describe("bot messages sync", () => {
  it("**fetches newest first, stops at --limit, and the next run carries on to the start**", async () => {
    const first = await call(["messages", "sync", "-100", "--limit", "150", "--page-size", "100", "--json"])
    expect(first.answer.item).toMatchObject({ chat: "-100", complete: false })
    // By time each page repeats the message the last one ended at; a repeat does not count.
    expect(first.answer.item.fetched).toBeGreaterThanOrEqual(149)

    const second = await call(["messages", "sync", "-100", "--json"])
    expect(second.answer.item).toMatchObject({ complete: true })

    const kept = await call(["messages", "list", "-100", "--limit", "300", "--offline", "--json"])
    expect(kept.answer.items).toHaveLength(250)
  })

  it("takes the bot's own chat reference as the chat, and refuses another bot's", async () => {
    const before = await call(["messages", "list", "chat:chat-bot/900/-100", "--offline", "--json"])
    expect(before.stderr).toContain("the account of this profile is not known yet")
    await call(["messages", "sync", "-100", "--limit", "10", "--json"])

    const byId = await call(["messages", "list", "-100", "--offline", "--json"])
    const byRef = await call(["messages", "list", "chat:chat-bot/900/-100", "--offline", "--json"])
    expect(byRef.answer.items).toEqual(byId.answer.items)
    const other = await call(["messages", "list", "chat:chat-bot/901/-100", "--offline", "--json"])
    expect(other.code).toBe(2)
    expect(JSON.parse(other.stderr).error).toMatchObject({
      reason: "ref.wrong-account",
      message: "chat:chat-bot/901/-100 belongs to account 901; profile sales is account 900",
    })
  })

  it("stops at --last and at --since-time, and refuses both together", async () => {
    expect(
      (await call(["messages", "sync", "-100", "--last", "50", "--page-size", "20", "--json"])).answer.item,
    ).toMatchObject({
      reached_last: true,
    })
    const since = new Date(START + 200 * 60_000).toISOString()
    const reached = (await call(["messages", "sync", "-100", "--since-time", since, "--json"])).answer
    expect(reached.item).toMatchObject({ reached_since: true })
    expect(reached.meta).toMatchObject({ window: { since } })
    expect(reached.meta).not.toHaveProperty("timezone")
    expect((await call(["messages", "sync", "-100", "--last", "5", "--since-time", since])).code).toBe(2)
  })

  it("is not there for a messenger whose bot cannot page back", async () => {
    const { fetching: _fetching, ...without } = bot
    const messages = botCommand(without).commands.find((one) => one.name() === "messages")
    expect(messages?.commands.map((one) => one.name())).not.toContain("sync")
  })

  it.each([
    [{ "bot.messages.sync": "deny" }, "bot.messages.sync is deny"],
    [{ "bot.messages": "deny" }, "bot.messages is deny"],
  ])("**refuses under %o** before it connects", async (permissions, named) => {
    saveBotPermissions(permissions)
    const refused = await call(["messages", "sync", "-100", "--json"])
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain(`permissions.${named}`)
  })

  it("syncs under `bot.messages: deny` when the profile allows `bot.messages.sync` itself", async () => {
    saveBotPermissions({ "bot.messages": "deny", "bot.messages.sync": "allow" })
    expect((await call(["messages", "sync", "-100", "--limit", "5", "--json"])).code).toBe(0)
  })

  it("refuses a saved key no command checks, naming only that key", async () => {
    saveBotPermissions({ "bot.store.fetch": "deny" })
    const refused = await call(["messages", "sync", "-100", "--json"])
    expect(refused.code).toBe(3)
    expect(JSON.parse(refused.stderr).error).toMatchObject({
      code: "configuration_error",
      message: `${join(root, "config", "config.json")}: permissions.bot.store.fetch names no command — remove it with \`chat sales config unset --bot permissions.bot.store.fetch\``,
    })
  })

  it("passes --from and the pause to the history-only connection, with its stop signal", async () => {
    let connecting: BotConnectOptions | undefined
    const messenger: BotMessenger = {
      ...bot,
      fetching: { page: 100, maxPages: 10, pause: "1ms", orderBy: "time", from: "a message link" },
      connect: async (_command, _token, options) => {
        connecting = options
        return adapter
      },
    }
    const fetched = await call(
      ["messages", "sync", "-100", "--until-id", "https://example.org/10", "--limit", "1", "--json"],
      messenger,
    )
    expect(fetched.code).toBe(0)
    expect(connecting?.history).toEqual({ from: "https://example.org/10", pauseMs: 1 })
    expect(connecting?.stop).toBeInstanceOf(AbortSignal)
    expect((await call(["messages", "sync", "-100", "--until-id", "https://example.org/10"])).code).toBe(2)
  })
})
