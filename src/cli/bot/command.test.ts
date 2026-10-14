import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it } from "vitest"
import type { Account } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import type { BotMessenger } from "./port.js"
import { ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)
const SALES: Account = { id: "42", name: "Sales", username: "sales_bot" }

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let typed: string
let connected: string[]
let closed: number

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  identity: true,
  resolveSettings: config.resolveSettings,
  connect: async (_command, token, { events } = {}) => {
    connected.push(token)
    return {
      me: async () => {
        events?.({ event: "request", operation: "me" })
        if (token !== "good") throw new CliError("authentication_error", "the messenger did not accept this token")
        return SALES
      },
      close: async () => {
        closed++
      },
    }
  },
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  readSecret: async () => typed,
}

const call = async (argv: string[]) => {
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [botCommand(bot)] }, { streams, tty: false, env })
  const answer = streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined
  return { code, answer, stderr: streams.stderr.join("\n") }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-command-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  typed = "good"
  connected = []
  closed = 0
})

describe("bot auth", () => {
  it("**asks the messenger whose token it is before keeping it**, and keeps nothing it refused", async () => {
    typed = "typo"
    expect((await call(["sales", "bot", "auth", "set", "--json"])).code).toBe(4)
    expect(keyring.entries.size).toBe(0)

    typed = "good"
    expect((await call(["sales", "bot", "auth", "set", "--json"])).answer.item).toEqual({
      profile: "sales",
      stored: "keyring",
      bot: "Sales",
      id: "42",
      username: "sales_bot",
    })
    expect([...keyring.entries.keys()]).toEqual(["chat-cli:bot:sales"])
    expect((await call(["sales", "bot", "auth", "show", "--json"])).answer.item).toMatchObject({
      source: "keyring",
      id: "42",
    })
  })

  it("**names the command that stores a token** when there is none", async () => {
    const done = await call(["sales", "bot", "auth", "show", "--json"])

    expect(done.code).toBe(4)
    expect(done.stderr).toContain("chat sales bot auth set")
    expect(connected).toEqual([])
  })

  it("**hands the client the run's events**, so --trace shows each request", async () => {
    await call(["sales", "bot", "auth", "set"])
    const done = await call(["sales", "bot", "auth", "show", "--trace", "--json"])

    expect(done.stderr).toContain('"operation":"me"')
  })

  it("refuses --offline on a command that has to ask the messenger", async () => {
    expect((await call(["sales", "bot", "auth", "set", "--offline"])).code).toBe(2)
    expect(connected).toEqual([])
  })
})

describe("bot list", () => {
  it("**names every bot with a token, and with --check asks who each is**", async () => {
    await call(["sales", "bot", "auth", "set"])
    new ChatRegistry(app, "support", env).touch()
    new BotTokenStore({ app, profile: "support", env: {}, configDir: join(root, "config"), keyring }).write("revoked")

    expect((await call(["bot", "list", "--json"])).answer.items).toEqual([
      { name: "sales", token: "keyring" },
      { name: "support", token: "keyring" },
    ])
    expect((await call(["bot", "list", "--check", "--json"])).answer.items).toEqual([
      { name: "sales", token: "keyring", bot: "sales_bot", id: "42" },
      { name: "support", token: "keyring", problem: "authentication_error" },
    ])
  })
})

describe("bot recipients", () => {
  it("**takes a chat by id, by `user:<id>` or by the title of a chat the bot has seen**, then empties", async () => {
    new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])

    await call(["sales", "bot", "recipients", "add", "Team"])
    const listed = await call(["sales", "bot", "recipients", "add", "user:7", "--json"])
    expect(listed.answer.items).toMatchObject([
      { id: "-100", title: "Team" },
      { id: "user:7", title: null },
    ])
    expect((await call(["sales", "bot", "recipients", "remove", "-100", "--json"])).answer.item.removed).toMatchObject({
      id: "-100",
    })
    await call(["sales", "bot", "recipients", "clear"])
    expect((await call(["sales", "bot", "recipients", "list", "--json"])).answer.items).toEqual([])
    expect((await call(["sales", "bot", "sends", "list", "--json"])).answer.items).toEqual([])
  })
})

describe("bot chats list", () => {
  it("**lists the chats this bot has seen**, offline too, and asks nobody", async () => {
    new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])

    const done = await call(["sales", "bot", "chats", "list", "--offline", "--json"])
    expect(done.answer.items).toMatchObject([{ id: "-100", title: "Team" }])
    expect(connected).toEqual([])
  })
})

describe("bot me", () => {
  it("reads this profile's identity once, closes, and leaves sends unchanged", async () => {
    new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("good")
    const before = await call(["sales", "bot", "sends", "list", "--json"])
    const result = await call(["sales", "bot", "me", "--trace", "--json"])
    expect(result.code).toBe(0)
    expect(result.answer.item).toEqual(SALES)
    expect(result.stderr).toContain("me")
    expect(connected).toEqual(["good"])
    expect(closed).toBe(1)
    expect((await call(["sales", "bot", "sends", "list", "--json"])).answer.items).toEqual(before.answer.items)
  })

  it("refuses missing tokens and offline reads before connecting, and closes an unsuccessful read", async () => {
    expect((await call(["sales", "bot", "me", "--json"])).code).toBe(4)
    expect((await call(["sales", "bot", "me", "--offline", "--json"])).code).toBe(2)
    expect(connected).toEqual([])
    new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("bad")
    expect((await call(["sales", "bot", "me", "--json"])).code).toBe(4)
    expect(closed).toBe(1)
  })
})
