import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import { botCopy } from "./copy.js"
import type { BotAdapter, BotMessenger } from "./port.js"
import { ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let clock: number
let adapter: BotAdapter

const said = (chatId: string, id: string, senderId: string, senderName: string, text: string): Message => ({
  id,
  chatId,
  senderId,
  senderName,
  timestamp: new Date(clock++).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
}

const call = async (argv: string[]) => {
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [botCommand(bot)] }, { streams, tty: false, env })
  const out = streams.stdout.join("\n")
  return { code, answer: out ? JSON.parse(out) : undefined, out, stderr: streams.stderr.join("\n") }
}

const configure = (contents: object) => {
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(join(root, "config", "config.json"), JSON.stringify(contents))
}

const people = [
  { id: "42", name: "Ann", username: "ann" },
  { id: "43", name: "Bob" },
]

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "bot-people-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  clock = Date.parse("2026-10-01T10:00:00Z")
  adapter = { me: async () => ({ id: "1", name: "First", username: "first_bot" }), close: async () => {} }
  new BotTokenStore({ app, profile: "first", env: {}, configDir: join(root, "config"), keyring }).write("t")
  new ChatRegistry(app, "first", env).rememberBot("1")
  new ChatRegistry(app, "second", env).rememberBot("2")
  const copy = botCopy("chat-bot")
  await copy.keep(
    "1",
    [
      said("-100", "a1", "42", "Ann", "ann in team"),
      said("-100", "b1", "43", "Bob", "bob in team"),
      said("42", "d1", "42", "Ann", "hi bot"),
    ],
    "watch",
    () => {},
    people,
  )
  await copy.keep(
    "2",
    [said("-200", "a2", "42", "Ann", "ann elsewhere"), said("-200", "b2", "43", "Bob", "bob elsewhere")],
    "watch",
    () => {},
    people,
  )
})

describe("bot contacts show", () => {
  it("**shows a person by @username from the local copy**: where they wrote, and the private chat", async () => {
    const { code, answer } = await call(["first", "bot", "contacts", "show", "@ann", "--json"])

    expect(code).toBe(0)
    expect(answer).toMatchObject({ id: "42", name: "Ann" })
    expect(answer.chats.map((chat: { id: string; kind: string }) => [chat.id, chat.kind]).sort()).toEqual([
      ["-100", "group"],
      ["42", "dialog"],
    ])
    expect(answer.messages.map((message: Message) => message.text)).toEqual(["hi bot"])
  })

  it("**reads another bot's copy only when readOtherBots allows it**, and names the setting", async () => {
    const refused = await call(["first", "bot", "contacts", "show", "@ann", "--bots", "second", "--json"])
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain("readOtherBots")

    configure({ bot: { profiles: { first: { readOtherBots: ["second"] } } } })
    const allowed = await call(["first", "bot", "contacts", "show", "@ann", "--all-bots", "--json"])
    expect(allowed.answer.chats.map((chat: { id: string }) => chat.id)).toContain("-200")
  })

  it("refuses --refresh for a bot that cannot read a chat back", async () => {
    const { code, stderr } = await call(["first", "bot", "contacts", "show", "@ann", "--refresh", "--limit", "5"])

    expect(code).toBe(2)
    expect(stderr).toContain("cannot read a chat back")
  })
})

describe("bot search messages and messages between", () => {
  it("**finds by words or by --from**, in this bot's copy only", async () => {
    const byWord = await call(["first", "bot", "search", "messages", "team", "--json"])
    const byPerson = await call([
      "first",
      "bot",
      "search",
      "messages",
      "--from",
      "@ann",
      "--newest",
      "--limit",
      "5",
      "--json",
    ])

    expect(byWord.answer.items.map((message: Message) => message.id).sort()).toEqual(["a1", "b1"])
    expect(byPerson.answer.items.map((message: Message) => message.id)).toEqual(["d1", "a1"])
    expect((await call(["first", "bot", "search", "messages", "--json"])).code).toBe(2)
  })

  it("**keeps the chats every one of them wrote in**, and with --bots reads the other copy too", async () => {
    configure({ bot: { profiles: { first: { readOtherBots: true } } } })
    const own = await call(["first", "bot", "messages", "between", "@ann", "Bob", "--json"])
    const both = await call([
      "first",
      "bot",
      "messages",
      "between",
      "@ann",
      "Bob",
      "--bots",
      "second",
      "--limit",
      "1",
      "--json",
    ])

    expect(own.answer.chats.map((chat: { id: string }) => chat.id)).toEqual(["-100"])
    expect(both.answer.chats.map((chat: { id: string }) => chat.id).sort()).toEqual(["-100", "-200"])
    expect(both.answer.chats.every((chat: { messages: unknown[] }) => chat.messages.length === 1)).toBe(true)
    expect((await call(["first", "bot", "messages", "between", "@ann"])).code).toBe(2)
  })
})
