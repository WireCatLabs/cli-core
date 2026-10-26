import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toJsonSchema } from "@valibot/to-json-schema"
import { annotate, annotateOption, describeProgram } from "@wirecat/cli-base/commands"
import { Argument, Command, Option } from "commander"
import { describe, expect, it, vi } from "vitest"
import {
  changesAuthorityAt,
  grantsAuthority,
  LOCAL_READ,
  LOCAL_WRITE,
  REMOTE_READ,
  REMOTE_WRITE,
} from "../cli/effects.js"
import { rememberAccount } from "../cli/messenger/accounts.js"
import type { Messenger } from "../cli/messenger/context.js"
import { messagesCommand } from "../cli/messenger/messages-command.js"
import { createProgram, run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import type { Message } from "../domain/models.js"
import type { MessengerAdapter, SendOptions } from "../ports/messenger.js"
import { type AgentContext, type AgentProgram, runCommandForAgent, toolsFromCommands } from "./agent.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const chat = { id: "7", title: "Book club", kind: "group" as const, lastMessageAt: null }
const message: Message = {
  id: "11",
  chatId: "7",
  senderId: "500",
  senderName: "Owner",
  timestamp: "2026-10-17T10:00:00.000Z",
  editedAt: null,
  text: "hi",
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

/** The server's one connection, and what reached it. */
const held = () => {
  const sent: string[] = []
  const deleted: { ids: string[]; forEveryone: boolean }[] = []
  const close = vi.fn(async () => {})
  const adapter = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    resolve: async () => chat,
    send: async (_chat: string, text: string, options: SendOptions) => {
      sent.push(text)
      return { message: { ...message, text }, sendId: options.sendId }
    },
    delete: async (_chat: string, ids: string[], options: { forEveryone: boolean }) => {
      deleted.push({ ids, forEveryone: options.forEveryone })
    },
    close,
  } as unknown as MessengerAdapter
  return { adapter, sent, deleted, close }
}

const setup = (messenger: Partial<Messenger> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agent-run-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_REQUESTS_PER_MINUTE: "0",
    MESSAGING_STORE: join(root, "m.db"),
  }
  rememberAccount(app, "default", "500", env)
  const ownConnect = vi.fn(async (): Promise<MessengerAdapter> => {
    throw new Error("the command opened a connection of its own")
  })
  const definition = {
    app,
    commands: () => [
      messagesCommand({
        app,
        provider: "chat",
        resolveSettings: settingsFor(app).resolveSettings,
        connect: ownConnect,
        chatArgument: "a chat",
        ...messenger,
      }),
    ],
  }
  const program: AgentProgram = {
    run: (argv, environment) => run(argv, definition, environment),
    commands: describeProgram(createProgram(definition)),
  }
  const connection = held()
  const open = vi.fn(async () => connection.adapter)
  const ctx: AgentContext = { profile: "default", env, connection: open }
  return { program, ctx, connection, open, ownConnect }
}

describe("runCommandForAgent", () => {
  it("**hands back the command's envelope as an object**", async () => {
    const { program, ctx } = setup()

    const answer = await runCommandForAgent(program, ["messages", "send"], { chat: "Book", text: "hello" }, ctx)

    expect(answer).toMatchObject({ result: { item: { message: { text: "hello", chat_id: "7" } }, meta: {} } })
  })

  it("**takes a list of photos as one album**, and answers with every message it made", async () => {
    const { program, ctx, connection } = setup()
    const root = mkdtempSync(join(tmpdir(), "agent-album-"))
    const photos = ["a.png", "b.png"].map((name) => {
      writeFileSync(join(root, name), "12345")
      return join(root, name)
    })
    const asked: SendOptions[] = []
    connection.adapter.send = async (_chat, text, options) => {
      asked.push(options)
      const messages = (options.attachments ?? []).map((_, at) => ({ ...message, id: String(20 + at), text }))
      return { message: messages[0] ?? message, messages, sendId: options.sendId }
    }
    const send = toolsFromCommands(program.commands).find((tool) => tool.command === "messages send")

    const answer = await runCommandForAgent(
      program,
      ["messages", "send"],
      { chat: "Book", text: "look", photo: photos },
      ctx,
    )
    const one = await runCommandForAgent(program, ["messages", "send"], { chat: "Book", photo: photos[0] }, ctx)

    expect(toJsonSchema(send?.input ?? ({} as never))).toMatchObject({
      properties: { photo: { anyOf: [{ type: "array", minItems: 1 }, { type: "string" }] } },
    })
    expect(asked.map((options) => options.attachments?.map(({ name }) => name))).toEqual([
      ["a.png", "b.png"],
      ["a.png"],
    ])
    expect(answer).toMatchObject({
      result: { item: { message: { id: "20" }, messages: [{ id: "20" }, { id: "21" }] } },
    })
    expect(one).toMatchObject({ result: { item: { message: { id: "20" } } } })
  })

  it("**borrows the server's connection on every call, and never opens or closes one**", async () => {
    const { program, ctx, connection, open, ownConnect } = setup()
    const once = vi.fn(async () => connection.adapter)
    let opened: Promise<MessengerAdapter> | undefined
    const shared: AgentContext = {
      ...ctx,
      connection: () => {
        opened ??= once()
        return opened
      },
    }

    for (const text of ["one", "two", "three"])
      await runCommandForAgent(program, ["messages", "send"], { chat: "Book", text }, shared)

    expect(connection.sent).toEqual(["one", "two", "three"])
    expect(once).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    expect(ownConnect).not.toHaveBeenCalled()
    expect(connection.close).not.toHaveBeenCalled()
  })

  it("**a failure comes back as the CLI's error object**", async () => {
    const { program, ctx } = setup()

    const answer = await runCommandForAgent(program, ["messages", "list"], { chat: "Book", limit: 0 }, ctx)

    expect(answer).toMatchObject({ error: { error: { code: "validation_error", message: expect.any(String) } } })
  })

  it("**a write at level ask goes ahead**, with nobody to answer", async () => {
    const { program, ctx, connection } = setup()

    const answer = await runCommandForAgent(program, ["messages", "delete"], { chat: "Book", message: ["11"] }, ctx)

    expect(answer).toHaveProperty("result")
    expect(connection.deleted).toEqual([{ ids: ["11"], forEveryone: false }])
  })

  it.each([
    ["deny", { "messages.send": "deny" as const }],
    ["readonly", { messages: "readonly" as const }],
  ])("**refuses a write the levels refuse (%s)**, before it runs", async (_name, levels) => {
    const { program, ctx, connection, open } = setup()

    const answer = await runCommandForAgent(
      program,
      ["messages", "send"],
      { chat: "Book", text: "x" },
      {
        ...ctx,
        levels: () => levels,
      },
    )

    expect(answer).toMatchObject({ error: { error: { code: "permission_error" } } })
    expect(connection.sent).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  it("**the server's stricter levels reach the command's own guard**", async () => {
    const { program, ctx, connection } = setup()

    const answer = await runCommandForAgent(
      program,
      ["messages", "send"],
      { chat: "Book", text: "x" },
      {
        ...ctx,
        overrides: ["messages.send=deny"],
      },
    )

    expect(answer).toMatchObject({ error: { error: { code: "permission_error" } } })
    expect(connection.sent).toEqual([])
  })

  it("**never deletes for everyone**: the option is not there, and a messenger that deletes only so refuses", async () => {
    const plain = setup()
    const forEveryone = await runCommandForAgent(
      plain.program,
      ["messages", "delete"],
      { chat: "Book", message: ["11"], for_everyone: true },
      plain.ctx,
    )
    const whatsapp = setup({ name: "WhatsApp", deleteForMe: false })
    const onlyForEveryone = await runCommandForAgent(
      whatsapp.program,
      ["messages", "delete"],
      { chat: "Book", message: ["11"] },
      whatsapp.ctx,
    )

    expect(forEveryone).toMatchObject({ error: { error: { code: "validation_error" } } })
    expect(onlyForEveryone).toMatchObject({
      error: { error: { code: "permission_error", message: expect.stringContaining("WhatsApp deletes only") } },
    })
    expect([...plain.connection.deleted, ...whatsapp.connection.deleted]).toEqual([])
  })

  it("**refuses offline on a command that cannot answer offline**, before it runs", async () => {
    const run = vi.fn(async () => 0)
    const commands = describeProgram(
      new Command("x").addCommand(annotate(new Command("inspect"), { effects: REMOTE_READ, offline: false })),
    )

    const answer = await runCommandForAgent({ run, commands }, ["inspect"], { offline: true }, { profile: "p" })

    expect(answer).toMatchObject({ error: { error: { code: "validation_error" } } })
    expect(run).not.toHaveBeenCalled()
  })

  it("refuses a command that runs until it is stopped", async () => {
    const commands = describeProgram(
      new Command("x").addCommand(annotate(new Command("watch"), { effects: REMOTE_READ, lifetime: "persistent" })),
    )

    const answer = await runCommandForAgent({ run: async () => 0, commands }, ["watch"], {}, { profile: "p" })

    expect(answer).toMatchObject({ error: { error: { code: "validation_error" } } })
  })
})

const tree = () => {
  const root = new Command("x")
  const messages = root.command("messages")
  annotate(messages.command("list"), { effects: REMOTE_READ })
    .argument("<chat>", "a chat")
    .option("--limit <n>", "how many")
    .option("--types <types>", "kinds, by commas")
    .addOption(new Option("--order <order>", "which first").choices(["newest", "oldest"]))
    .option("--offline-only", "a switch")
  annotate(messages.command("delete"), { effects: REMOTE_WRITE })
    .argument("<chat>", "a chat")
    .argument("<messages...>", "ids")
    .addOption(annotateOption(new Option("--for-everyone", "for everyone"), { mcp: false }))
    .requiredOption("--reason <text>", "why")
  const admin = annotate(root.command("admin"), { mcp: false })
  annotate(admin.command("wipe"), { effects: REMOTE_WRITE })
  annotate(root.command("watch"), { effects: REMOTE_READ, lifetime: "persistent" })
  const bot = root.command("bot")
  annotate(bot.command("me"), { effects: REMOTE_READ })
  annotate(bot.command("action"), { effects: REMOTE_WRITE }).addArgument(
    new Argument("<action>", "what").choices(["typing", "photo"]),
  )
  return describeProgram(root)
}

describe("toolsFromCommands", () => {
  it("**offers each leaf command**, without what is marked mcp: false (inherited) or runs until stopped", () => {
    expect(toolsFromCommands(tree(), { exclude: [["bot"]] }).map((tool) => tool.command)).toEqual([
      "messages list",
      "messages delete",
    ])
  })

  it("**a server is a subtree**: commands are named under its root", () => {
    expect(toolsFromCommands(tree(), { root: ["bot"] }).map(({ command, path }) => [command, path.join(" ")])).toEqual([
      ["me", "bot me"],
      ["action", "bot action"],
    ])
  })

  it("**leaves out an option marked mcp: false**, and types the rest from the tree and the shared flags", () => {
    const [list, remove] = toolsFromCommands(tree(), { exclude: [["bot"]] })
    const listed = toJsonSchema(list?.input ?? ({} as never)) as {
      properties: Record<string, Record<string, unknown>>
      required: string[]
    }
    const removing = toJsonSchema(remove?.input ?? ({} as never)) as typeof listed

    expect(listed.properties.limit).toMatchObject({ type: "integer", minimum: 0 })
    expect(listed.properties.types).toMatchObject({ anyOf: [{ type: "array" }, { type: "string" }] })
    expect(listed.properties.order).toMatchObject({ enum: ["newest", "oldest"] })
    expect(listed.properties.offline_only).toMatchObject({ type: "boolean" })
    expect(listed.required).toEqual(["chat"])
    expect(removing.properties.messages).toMatchObject({ anyOf: [{ type: "array", minItems: 1 }, { type: "string" }] })
    expect(removing.properties).not.toHaveProperty("for_everyone")
    expect(removing.required.sort()).toEqual(["chat", "messages", "reason"])
    expect(remove?.writes).toBe(true)
    expect(list?.writes).toBe(false)
  })

  it("preserves the legacy executable-only helper projection for existing callers", () => {
    expect(toolsFromCommands(tree(), { exclude: [["bot"]], levels: { messages: "deny" } })).toEqual([])
  })

  it("keeps denied commands discoverable and marks their current availability", () => {
    const cases: Record<string, "deny" | "readonly">[] = [
      { "messages.delete": "deny" },
      { messages: "readonly" },
      { messages: "deny" },
    ]
    for (const levels of cases) {
      const tools = toolsFromCommands(tree(), { exclude: [["bot"]], levels, includeUnavailable: true })
      expect(tools.map((tool) => tool.command)).toEqual(["messages list", "messages delete"])
      expect(tools.find((tool) => tool.command === "messages delete")?.availability?.()).toMatchObject({
        available: false,
        reason: expect.any(String),
        permission: expect.any(String),
      })
    }
  })

  it("offers offline on a command that reads the messenger, and drops the arguments it is told to", () => {
    const [list] = toolsFromCommands(tree(), { exclude: [["bot"]], offline: true, omit: ["types"] })

    expect(Object.keys(list?.input.entries ?? {})).toContain("offline")
    expect(Object.keys(list?.input.entries ?? {})).not.toContain("types")
  })

  it("**offers no offline where a command or a group above it says it cannot answer offline**", () => {
    const root = new Command("x")
    const chats = root.command("chats")
    annotate(chats.command("list"), { effects: REMOTE_READ })
    annotate(chats.command("inspect"), { effects: REMOTE_READ, offline: false })
    annotate(annotate(chats.command("folders"), { offline: false }).command("list"), { effects: REMOTE_READ })
    const offered = Object.fromEntries(
      toolsFromCommands(describeProgram(root), { offline: true }).map((tool) => [
        tool.command,
        "offline" in tool.input.entries,
      ]),
    )

    expect(offered).toEqual({ "chats list": true, "chats inspect": false, "chats folders list": false })
  })

  it("**offers a group only when it runs on its own**, whatever effects it declares", () => {
    const root = new Command("x")
    const config = annotate(root.command("config"), { effects: LOCAL_READ })
    annotate(config.command("show"), { effects: LOCAL_READ })
    const watch = annotate(root.command("watch"), { effects: REMOTE_READ }).action(() => {})
    annotate(watch.command("status"), { effects: LOCAL_READ })
    const offered = toolsFromCommands(describeProgram(root)).map((tool) => tool.command)

    expect(offered.sort()).toEqual(["config show", "watch", "watch status"])
  })
})

it("rechecks a provider command's authority grant before invoking its runner", async () => {
  const root = new Command("fixture")
  grantsAuthority(annotate(root.command("configure"), { effects: LOCAL_WRITE }))
  const run = vi.fn(async () => 0)
  const answer = await runCommandForAgent(
    { run, commands: describeProgram(root) },
    ["configure"],
    {},
    {
      profile: "invented",
      levels: () => ({ "mcp.authority": "deny" }),
      authority: changesAuthorityAt(root),
    },
  )
  expect(answer).toMatchObject({ error: { error: { code: "permission_error" } } })
  expect(run).not.toHaveBeenCalled()
})

describe("positional and flag alternatives", () => {
  it.each([false, true])("runs one text input once and preserves positional requiredness: %s", async (required) => {
    const root = new Command("example")
    annotate(root.command("add"), { effects: LOCAL_WRITE })
      .argument(required ? "<text>" : "[text]", "the text")
      .option("--text <text>", "the same text as a flag")
      .option("--json")
    const commands = describeProgram(root)
    const tool = toolsFromCommands(commands)[0]
    if (!tool) throw new Error("missing generated command")
    const schema = toJsonSchema(tool.input) as { required?: string[] }
    expect(schema.required ?? []).toEqual(required ? ["text"] : [])
    const result = await runCommandForAgent(
      {
        commands,
        run: async (argv, environment) => {
          const program = new Command("example")
          program
            .command("add")
            .argument(required ? "<text>" : "[text]")
            .option("--text <text>")
            .option("--json")
            .action((text: string | undefined, flags: { text?: string }) => {
              expect(text).toBe("Synthetic text")
              expect(flags.text).toBeUndefined()
              environment.agent?.result({ text })
            })
          await program.parseAsync(argv.slice(1), { from: "user" })
          return 0
        },
      },
      ["add"],
      { text: "Synthetic text" },
      { profile: "" },
    )
    expect(result).toEqual({ result: { text: "Synthetic text" } })
  })
})
