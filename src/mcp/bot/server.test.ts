import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { toJsonSchema } from "@valibot/to-json-schema"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { botCommand } from "../../cli/bot/command.js"
import type { BotAdapter, BotMessenger } from "../../cli/bot/port.js"
import { ChatRegistry } from "../../cli/bot/registry.js"
import { BotTokenStore } from "../../cli/bot/token.js"
import { createProgram, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import type { Message } from "../../domain/models.js"
import { ModerationRules, moderationPathFor } from "../../moderation/rules.js"
import { surfaceOf } from "../../testing/mcp-surface.js"
import { type BotServerOptions, createBotServer, type RunBotCommand } from "./server.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let calls: string[]

const message = (chatId: string, id: string, text: string): Message => ({
  id,
  chatId,
  senderId: "42",
  senderName: "Sales",
  timestamp: "2026-10-01T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const adapter: BotAdapter = {
  me: async () => ({ id: "42", name: "Sales", username: "sales_bot" }),
  close: async () => {},
  send: async (chat, text) => {
    calls.push(`send ${chat} ${text}`)
    return message(chat, "100", text)
  },
  delete: async (chat, ids) => {
    calls.push(`delete ${chat} ${ids.join(",")}`)
  },
  historySince: async () => ({
    messages: [{ ...message("-100", "2", "join https://max.ru/join/other"), senderId: "42", outgoing: false }],
    more: false,
  }),
  admins: async () => [],
}

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  identity: true,
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  mcp: { program: async () => runBot },
}

const definition = { app, commands: () => [botCommand(bot)] }
const runBot: RunBotCommand = (argv, environment) => run(argv, definition, environment)

const configure = (contents: object) => {
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(join(root, "config", "config.json"), JSON.stringify(contents))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-mcp-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  calls = []
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("token")
  new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])
})

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const commands = () => describeProgram(createProgram(definition))

const connect = async (options: Partial<BotServerOptions> = {}) => {
  const settings = config.resolveSettings({ profile: "sales" }, { env, kind: "bot" })
  const { build, offered, tools } = createBotServer({
    bot,
    program: { run: runBot, commands: commands() },
    settings,
    levels: () => config.resolveSettings({ profile: "sales" }, { env, kind: "bot" }).permissions,
    env,
    ...options,
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const server = build()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return { client: surfaceOf(client, "chat_bot"), raw: client, offered, tools }
}

const call = async (client: ReturnType<typeof surfaceOf>, command: string, args: Record<string, unknown> = {}) => {
  const result = await client.run({ command, arguments: args })
  const body = result.structuredContent as Record<string, unknown>
  return { isError: result.isError === true, body, error: body?.error as { code?: string } | undefined }
}

const READS = [
  "me",
  "chats list",
  "chats show",
  "chats rules show",
  "messages list",
  "messages show",
  "chats admins list",
  "commands list",
  "sends list",
  "recipients list",
  "search messages",
  "messages between",
  "contacts show",
]
const WRITES = [
  "messages send",
  "messages edit",
  "messages pin",
  "messages unpin",
  "chats action",
  "callbacks answer",
  "messages delete",
  "chats members remove",
  "chats moderate",
]

describe("bot mcp tools by permission level", () => {
  it("**offers every read and write the default levels allow**, and nothing marked mcp: false or long-running", async () => {
    const { offered } = await connect()

    expect(offered.sort()).toEqual([...READS, ...WRITES].sort())
  })

  it.each([
    ["bot: readonly hides the writes", { bot: "readonly" }, READS],
    ["bot: deny leaves what no level stops", { bot: "deny" }, ["sends list", "recipients list"]],
    [
      "a key opened under a read-only bot offers that write alone",
      { bot: "readonly", "bot.messages.send": "allow" },
      [...READS, "messages send"],
    ],
    ["deny on one key hides that tool", { "bot.messages": "deny" }, null],
  ])("%s", async (_name, permissions, expected) => {
    configure({ bot: { profiles: { sales: { permissions } } } })
    const { offered } = await connect()

    if (expected) expect(offered.sort()).toEqual([...expected].sort())
    else expect(offered.some((name) => name.startsWith("messages "))).toBe(false)
  })

  it("**lists three tools**: search, read and write, and no write tool on a read-only profile", async () => {
    expect((await (await connect()).raw.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "chat_bot_read",
      "chat_bot_tools_search",
      "chat_bot_write",
    ])
    configure({ bot: { profiles: { sales: { permissions: { bot: "readonly" } } } } })
    expect((await (await connect()).raw.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "chat_bot_read",
      "chat_bot_tools_search",
    ])
  })

  it("**finds a command by its exact name first**, even when the name is part of many others", async () => {
    const { raw } = await connect()
    const result = await raw.callTool({ name: "chat_bot_tools_search", arguments: { query: "me" } })
    const { items } = JSON.parse((result.content as { text: string }[])[0]?.text ?? "null")

    expect(items[0]).toMatchObject({ command: "me" })
  })

  it("**a level made stricter after start-up refuses the next call**", async () => {
    const { client } = await connect()
    configure({ bot: { profiles: { sales: { permissions: { "bot.messages.send": "deny" } } } } })

    const refused = await call(client, "messages send", { chat: "-100", text: "Hi" })

    expect(refused.error?.code).toBe("permission_error")
    expect(calls).toEqual([])
  })

  it("**offers another bot's copy only where read_other_bots allows**", async () => {
    const { client } = await connect()
    expect(Object.keys((await client.describe("search messages"))?.arguments.properties ?? {})).not.toContain(
      "all_bots",
    )
    configure({ bot: { profiles: { sales: { read_other_bots: true } } } })
    const opened = await connect({ settings: config.resolveSettings({ profile: "sales" }, { env, kind: "bot" }) })
    expect(Object.keys((await opened.client.describe("search messages"))?.arguments.properties ?? {})).toContain(
      "all_bots",
    )
  })

  it("**status** says which bot and which writes, through `auth show`", async () => {
    const { client } = await connect()

    const status = await call(client, "status")

    expect(status.body.item).toMatchObject({ profile: "sales", auth: { bot: "Sales", id: "42" } })
    expect((status.body.item as { writes: string[] }).writes).toContain("messages send")
  })
})

describe("bot mcp writes", () => {
  it("**sends through the command**, by the chat's title, with no form at level allow", async () => {
    const { client } = await connect()

    const sent = await call(client, "messages send", { chat: "Team", text: "Hello" })

    expect(sent.isError).toBe(false)
    expect(sent.body).toMatchObject({ item: { message: { id: "100", chat_id: "-100" } } })
    expect(calls).toEqual(["send -100 Hello"])
  })

  it("**deletes with no form**, where the level asks", async () => {
    const { client } = await connect()

    expect((await call(client, "messages delete", { chat: "-100", messages: ["7"] })).isError).toBe(false)
    expect(calls).toEqual(["delete -100 7"])
  })

  it("a value that looks like a flag stays a value, and an argument the command has not is refused", async () => {
    const { client } = await connect()

    const flagLike = await call(client, "messages send", { chat: "-100", text: "--silent" })
    const unknown = await call(client, "messages send", { chat: "-100", text: "x", file: "/etc/passwd" })

    expect(flagLike.isError).toBe(false)
    expect(unknown.error?.code).toBe("validation_error")
    expect(calls).toEqual(["send -100 --silent"])
  })

  it("refuses text that is only -, which would read the MCP transport as stdin", async () => {
    const { client } = await connect()

    expect((await call(client, "messages send", { chat: "-100", text: "-" })).error?.code).toBe("validation_error")
    expect(calls).toEqual([])
  })

  it("**a write at level ask goes ahead**, with no form", async () => {
    configure({ bot: { profiles: { sales: { permissions: { "bot.messages.send": "ask" } } } } })
    const { client } = await connect()

    const sent = await call(client, "messages send", { chat: "-100", text: "Hi" })

    expect(sent.isError).toBe(false)
    expect(calls).toEqual(["send -100 Hi"])
  })
})

describe("chat_bot_chats_moderate", () => {
  const deleting = (consent: "ask" | "allow") => {
    const rules = new ModerationRules(moderationPathFor(app, "sales", env))
    rules.set("-100", null, "invites", "delete")
    rules.set("-100", null, "consent.delete", consent)
  }

  it("**leaves the actions the rules put at ask**, with no form", async () => {
    deleting("ask")
    const { client } = await connect()

    expect((await call(client, "chats moderate", { chat: "Team" })).isError).toBe(false)
    expect(calls).toEqual([])
  })

  it("**acts at level ask for the command itself**, with no form", async () => {
    deleting("allow")
    configure({ bot: { profiles: { sales: { permissions: { "bot.chats.moderate": "ask" } } } } })
    const { client } = await connect()

    const done = await call(client, "chats moderate", { chat: "-100" })

    expect(done.body).toMatchObject({ item: { rows: [{ action: "delete", outcome: "done" }] } })
    expect(calls).toEqual(["delete -100 2"])
  })

  it("acts at level allow", async () => {
    deleting("allow")
    expect((await call((await connect()).client, "chats moderate", { chat: "-100" })).body).toMatchObject({
      item: { rows: [{ outcome: "done" }] },
    })
  })
})

describe("bot mcp config", () => {
  it("**prints the entry for `bot mcp`**", async () => {
    const streams = captureStreams()
    const code = await run(["sales", "bot", "mcp", "config", "--json"], definition, {
      streams,
      tty: false,
      env,
      mcp: { execPath: "/usr/bin/node", scriptPath: "/opt/chat/cli.js" },
    })

    expect(code).toBe(0)
    expect(JSON.parse(streams.stdout[0] ?? "").item.config).toEqual({
      mcpServers: {
        "chat-bot-sales": {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/chat/cli.js", "sales", "bot", "mcp"],
          env: { CHAT_CONFIG_DIR: env.CHAT_CONFIG_DIR, CHAT_STATE_DIR: env.CHAT_STATE_DIR },
        },
      },
    })
  })

  it("is not mounted for a messenger that hands in no run", () => {
    const { mcp: _mcp, ...without } = bot
    expect(botCommand(without).commands.map((one) => one.name())).not.toContain("mcp")
  })
})

it("reads bot identity through MCP under read-only permissions without a write", async () => {
  configure({ bot: { profiles: { sales: { permissions: { bot: "readonly" } } } } })
  const { client } = await connect()
  const result = await call(client, "me")
  expect(result.isError).toBe(false)
  expect(result.body.item).toEqual({ id: "42", name: "Sales", username: "sales_bot" })
  expect(calls).toEqual([])
})

/** What the hand-written bot tools took before they were generated from the commands (cli-core 0.324.0). */
const BEFORE: Record<string, Record<string, string>> = {
  me: {},
  "chats list": {},
  "chats show": { chat: "string" },
  "messages list": { chat: "string", limit: "integer", offline: "boolean" },
  "messages show": { chat: "string", message: "string", offline: "boolean" },
  "search messages": { text: "string", from: "string", limit: "integer" },
  "messages between": { people: "array", limit: "integer" },
  "contacts show": { who: "string", limit: "integer" },
  "chats admins list": { chat: "string" },
  "commands list": {},
  "sends list": {},
  "recipients list": {},
  "messages send": { chat: "string", text: "string", format: "enum", reply_to: "string", silent: "boolean" },
  "messages edit": { chat: "string", message: "string", text: "string", format: "enum" },
  "messages pin": { chat: "string", message: "string" },
  "messages unpin": { chat: "string", message: "string" },
  "chats action": { chat: "string", action: "enum" },
  "callbacks answer": { callback: "string", text: "string", notification: "string" },
  "messages delete": { chat: "string", message: "string" },
  "chats members remove": { chat: "string", user: "string", block: "boolean" },
  "chats moderate": { chat: "string", since_time: "string", dry_run: "boolean" },
}
/** Arguments that now carry the command's own option or argument name. */
const RENAMED: Record<string, readonly string[]> = {
  "search messages.text": ["query"],
  "messages send.format": ["md", "html"],
  "messages edit.format": ["md", "html"],
  "messages delete.message": ["messages"],
  "chats members remove.user": ["person"],
}
/** What the commands take that the hand-written tools did not. */
const ADDED: Record<string, readonly string[]> = {
  "chats list": ["offline"],
  "chats show": ["offline"],
  "chats admins list": ["offline"],
  "commands list": ["offline"],
  me: ["offline"],
  "contacts show": ["offline", "sync_first"],
  "search messages": ["newest", "offline", "page"],
  "messages between": ["offline"],
  "messages pin": ["notify"],
  "chats moderate": ["no_block"],
}

const typeOf = (schema: { type?: string; enum?: unknown[] }) => (schema.enum ? "enum" : schema.type)

describe("the generated bot catalogue", () => {
  const catalogue = async () =>
    Object.fromEntries(
      (await connect()).tools.map((tool) => [
        tool.command,
        toJsonSchema(tool.input) as { properties: Record<string, { type?: string; enum?: unknown[] }> },
      ]),
    )

  it("**offers every command the hand-written tools offered**, each argument under its command's name", async () => {
    const after = await catalogue()
    for (const [command, before] of Object.entries(BEFORE)) {
      const properties = after[command]?.properties
      expect(properties, command).toBeDefined()
      for (const [name, type] of Object.entries(before)) {
        const renamed = RENAMED[`${command}.${name}`]
        if (renamed) for (const now of renamed) expect(properties?.[now], `${command} ${now}`).toBeDefined()
        else expect(typeOf(properties?.[name] ?? {}), `${command} ${name}`).toBe(type)
      }
    }
  })

  it("**adds only the listed arguments and commands**", async () => {
    const after = await catalogue()
    const added = Object.fromEntries(
      Object.entries(after).flatMap(([command, schema]) => {
        const before = Object.keys(BEFORE[command] ?? {}).flatMap((name) => RENAMED[`${command}.${name}`] ?? [name])
        const extra = Object.keys(schema.properties).filter((name) => !before.includes(name))
        return BEFORE[command] && extra.length === 0 ? [] : [[command, extra.sort()]]
      }),
    )

    expect(added).toEqual({ ...ADDED, "chats rules show": ["chat"] })
  })

  it("**is pinned**: a command or an argument agents gain or lose shows up here", async () => {
    await expect(`${JSON.stringify(await catalogue(), null, 2)}\n`).toMatchFileSnapshot(
      "__snapshots__/bot-catalogue.snap",
    )
  })
})
