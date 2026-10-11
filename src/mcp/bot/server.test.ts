import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client, type ElicitResult } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import type { Command } from "commander"
import * as v from "valibot"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { botCommand } from "../../cli/bot/command.js"
import { commandLookup } from "../../cli/bot/mcp.js"
import type { BotAdapter, BotMessenger } from "../../cli/bot/port.js"
import { ChatRegistry } from "../../cli/bot/registry.js"
import { BotTokenStore } from "../../cli/bot/token.js"
import { createProgram, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import type { Message } from "../../domain/models.js"
import { ModerationRules, moderationPathFor } from "../../moderation/rules.js"
import { commandsClient } from "../../testing/mcp-commands-client.js"
import { type BotServerOptions, createBotServer, type RunBotCommand } from "./server.js"
import type { BotTool } from "./tools.js"

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

const ECHO: BotTool = {
  words: ["sends", "list"],
  title: "The CLI's own",
  description: "Replaces the shared one.",
  input: v.object({}),
}
const LEAVE: BotTool = {
  words: ["chats", "leave"],
  writes: "bot.chats.leave",
  title: "Leave, as more than one command",
  description: "A tool that is more than one command.",
  input: v.object({ chat: v.string() }),
  handle: async (args, kit) => ({
    left: args.chat,
    seen: await kit.invoke(["chats", "list"], { options: ["--offline"] }),
  }),
}
const PROMOTE: BotTool = {
  words: ["chats", "admins", "add"],
  writes: "bot.chats.admins.add",
  title: "Says which flags answer the command's question",
  description: "A tool that is more than one command.",
  input: v.object({}),
  handle: async (_args, kit) => ({ answerFlags: kit.answerFlags }),
}
const ABSENT: BotTool = { words: ["comments", "list"], title: "None", description: "Not mounted.", input: v.object({}) }

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  identity: true,
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  mcp: { program: async () => runBot, tools: [ECHO, LEAVE, PROMOTE, ABSENT] },
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

const connect = async (
  options: Partial<BotServerOptions> = {},
  { form }: { form?: (message: string) => ElicitResult } = {},
) => {
  const group = createProgram(definition).commands.find((one) => one.name() === "bot") as Command
  const settings = config.resolveSettings({ profile: "sales" }, { env, kind: "bot" })
  const { build, offered } = createBotServer({
    bot,
    commandAt: commandLookup(group),
    settings,
    env,
    run: runBot,
    tools: bot.mcp?.tools ?? [],
    ...options,
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const server = build()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "0" }, form ? { capabilities: { elicitation: {} } } : {})
  const forms: string[] = []
  if (form) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params.message)
      return form(request.params.message)
    })
  }
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return { client: commandsClient(client, "chat_bot"), raw: client, offered, forms }
}

const call = async (client: Pick<Client, "callTool">, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  const body = result.structuredContent as Record<string, unknown>
  return { isError: result.isError === true, body, error: body?.error as { code?: string } | undefined }
}

const READS = [
  "chat_bot_me",
  "chat_bot_chats_list",
  "chat_bot_chats_show",
  "chat_bot_messages_list",
  "chat_bot_messages_show",
  "chat_bot_chats_admins_list",
  "chat_bot_commands_list",
  "chat_bot_sends_list",
  "chat_bot_recipients_list",
  "chat_bot_search_messages",
  "chat_bot_messages_between",
  "chat_bot_contacts_show",
]
const WRITES = [
  "chat_bot_messages_send",
  "chat_bot_messages_edit",
  "chat_bot_messages_pin",
  "chat_bot_messages_unpin",
  "chat_bot_chats_action",
  "chat_bot_callbacks_answer",
  "chat_bot_messages_delete",
  "chat_bot_chats_members_remove",
  "chat_bot_chats_moderate",
]

describe("bot mcp tools by permission level", () => {
  it("**offers every read and write the default levels allow**, and no tool whose command is not mounted", async () => {
    const { offered } = await connect()

    expect(offered.sort()).toEqual([...READS, ...WRITES, "chat_bot_chats_leave", "chat_bot_chats_admins_add"].sort())
  })

  it.each([
    ["bot: readonly hides the writes", { bot: "readonly" }, READS],
    ["bot: deny leaves what no level stops", { bot: "deny" }, ["chat_bot_sends_list", "chat_bot_recipients_list"]],
    [
      "a key opened under a read-only bot offers that write alone",
      { bot: "readonly", "bot.messages.send": "allow" },
      [...READS, "chat_bot_messages_send"],
    ],
    ["deny on one key hides that tool", { "bot.messages": "deny" }, null],
  ])("%s", async (_name, permissions, expected) => {
    configure({ bot: { profiles: { sales: { permissions } } } })
    const { offered } = await connect()

    if (expected) expect(offered.sort()).toEqual([...expected].sort())
    else expect(offered.some((name) => name.startsWith("chat_bot_messages_"))).toBe(false)
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

  it("**the CLI's own tool replaces the shared one with the same words**", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()

    expect(tools.find((one) => one.name === "chat_bot_sends_list")?.title).toBe("The CLI's own")
    expect(tools.map((one) => one.name)).toContain("chat_bot_status")
  })
})

describe("bot mcp writes", () => {
  it("**sends through the command**, by the chat's title, with no form at level allow", async () => {
    const { client } = await connect()

    const sent = await call(client, "chat_bot_messages_send", { chat: "Team", text: "Hello" })

    expect(sent.isError).toBe(false)
    expect(sent.body).toMatchObject({ message: { id: "100", chatId: "-100" } })
    expect(calls).toEqual(["send -100 Hello"])
  })

  it("**deletes with no form**, where the level asks", async () => {
    const { client } = await connect()

    expect((await call(client, "chat_bot_messages_delete", { chat: "-100", message: "7" })).isError).toBe(false)
    expect(calls).toEqual(["delete -100 7"])
  })

  it("refuses a message id that would read as a flag, before running anything", async () => {
    const { client } = await connect()

    const refused = await call(client, "chat_bot_messages_send", { chat: "-100", text: "x", reply_to: "--silent" })

    expect(refused.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it("**a write at level ask answers the command's own question**, with no form", async () => {
    configure({ bot: { profiles: { sales: { permissions: { "bot.messages.send": "ask" } } } } })
    const { client } = await connect()

    const sent = await call(client, "chat_bot_messages_send", { chat: "-100", text: "Hi" })

    expect(sent.isError).toBe(false)
    expect(calls).toEqual(["send -100 Hi"])
  })
})

describe("a tool of the CLI's own that is more than one command", () => {
  it("**answers with what it did**", async () => {
    const { client } = await connect()

    const done = await call(client, "chat_bot_chats_leave", { chat: "Team" })

    expect(done.body).toMatchObject({ left: "Team", seen: { items: [{ id: "-100", title: "Team" }] } })
  })

  it("**is handed the flag that answers its command's question at level ask**, and none otherwise", async () => {
    const flags = async () =>
      (await call((await connect()).client, "chat_bot_chats_admins_add")).body.answerFlags as string[]

    expect(await flags()).toEqual([])
    configure({ bot: { profiles: { sales: { permissions: { "bot.chats.admins": "ask" } } } } })
    expect((await flags()).length).toBeGreaterThan(0)
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

    expect((await call(client, "chat_bot_chats_moderate", { chat: "Team" })).isError).toBe(false)
    expect(calls).toEqual([])
  })

  it("**acts at level ask for the command itself**, with no form", async () => {
    deleting("allow")
    configure({ bot: { profiles: { sales: { permissions: { "bot.chats.moderate": "ask" } } } } })
    const { client } = await connect()

    const done = await call(client, "chat_bot_chats_moderate", { chat: "-100" })

    expect(done.body).toMatchObject({ rows: [{ action: "delete", outcome: "done" }] })
    expect(calls).toEqual(["delete -100 2"])
  })

  it("acts at level allow", async () => {
    deleting("allow")
    expect((await call((await connect()).client, "chat_bot_chats_moderate", { chat: "-100" })).body).toMatchObject({
      rows: [{ outcome: "done" }],
    })
  })
})

describe("bot mcp config", () => {
  it("**prints the entry for `bot mcp`**, and says the old flags decide nothing", async () => {
    const streams = captureStreams()
    const code = await run(["sales", "bot", "mcp", "config", "--allow-send", "--confirm-send", "--json"], definition, {
      streams,
      tty: false,
      env,
      mcp: { execPath: "/usr/bin/node", scriptPath: "/opt/chat/cli.js" },
    })

    expect(code).toBe(0)
    expect(JSON.parse(streams.stdout[0] ?? "")).toEqual({
      mcpServers: {
        "chat-bot-sales": {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/chat/cli.js", "sales", "bot", "mcp"],
          env: { CHAT_CONFIG_DIR: env.CHAT_CONFIG_DIR, CHAT_STATE_DIR: env.CHAT_STATE_DIR },
        },
      },
    })
    expect(streams.stderr.join("\n")).toContain(
      "--allow-send, --confirm-send no longer decide anything: the bot profile's permissions do",
    )
  })

  it("is not mounted for a messenger that hands in no run", () => {
    const { mcp: _mcp, ...without } = bot
    expect(botCommand(without).commands.map((one) => one.name())).not.toContain("mcp")
  })
})

it("reads bot identity through MCP under read-only permissions without a write", async () => {
  configure({ bot: { profiles: { sales: { permissions: { bot: "readonly" } } } } })
  const { client } = await connect()
  const result = await call(client, "chat_bot_me")
  expect(result.isError).toBe(false)
  expect(result.body).toEqual({ id: "42", name: "Sales", username: "sales_bot" })
  expect(calls).toEqual([])
})
