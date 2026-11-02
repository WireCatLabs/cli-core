import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { CliError, captureStreams, type KeyringStore } from "@wirecat/cli-base"
import type { CommandInfo } from "@wirecat/cli-base/commands"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import { parseMarkdown } from "../../domain/markdown.js"
import type { AddressBookEntry, Chat, Message, WindowedMessage } from "../../domain/models.js"
import { conversation, ENTITIES } from "../../entities/index.js"
import { sampleMeeting } from "../../meetings/testing/index.js"
import type { MessengerAdapter, RemoteFile, SendOptions } from "../../ports/messenger.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { MEETINGS_UNNAMED } from "../../services/search-all-meetings.js"
import { modelPath, modelsDirectory, vadPath } from "../../speech/install.js"
import { speechModel, VAD } from "../../speech/models.js"
import { openCache } from "../../store/open.js"
import { historyStartKey, type MessageStore, openStore, registerProvider } from "../../store/store.js"
import { searchRecipes, seedSearchRecipes } from "../../testing/search-recipes.js"
import { commandsCommand } from "../commands-command.js"
import { type RunOptions, run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { accountFileFor, rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import { chatsCommand } from "./chats-command.js"
import { completeCommand } from "./complete-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { conversationsCommand } from "./conversations-command.js"
import { safeName } from "./download-command.js"
import { recipientsCommand, sendsCommand } from "./guard-commands.js"
import { httpTokenFile, type McpEnvironment, mcpCommand } from "./mcp-command.js"
import { messagesCommand } from "./messages-command.js"
import { modelsCommand } from "./models-command.js"
import { pollsCommand } from "./polls-command.js"
import { reactionsCommand } from "./reactions-command.js"
import { searchCommand } from "./search-command.js"
import { statsCommand } from "./stats-command.js"
import { topicsCommand } from "./topics-command.js"

/** JSON lines: each item's data, once the stream is known to end with its end line. */
const jsonlData = (lines: readonly string[]) => {
  const records = lines.map((line) => JSON.parse(line))
  expect(records.at(-1)).toMatchObject({ type: "end" })
  return records.slice(0, -1).map((record) => record.data)
}

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:00:00.000Z",
  participantsCount: 4,
}
const message: Message = {
  id: "1",
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "chapter three",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const thread: Message[] = ["1", "2", "3"].map((id, index) => ({
  ...message,
  id,
  timestamp: `2026-09-27T10:0${index}:00.000Z`,
}))

const people: Chat[] = [
  { ...chat, id: "20", kind: "dialog", title: "Zoe", lastMessageAt: "2026-09-27T09:00:00.000Z" },
  {
    ...chat,
    id: "21",
    kind: "dialog",
    title: "Adam",
    lastMessageAt: "2026-09-26T09:00:00.000Z",
    providerMetadata: { username: "adam_k" },
  },
]

const fake: MessengerAdapter = {
  formatMarkdown: async (text: string) => {
    const parsed = parseMarkdown(text)
    return { text: parsed.text, spans: parsed.markup }
  },
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat, ...people], hasMore: false }),
  history: async () => ({ items: [message], hasMore: false }),
  resolve: async () => chat,
  contact: async () => ({
    id: "21",
    name: "Adam",
    username: "adam_k",
    description: null,
    lastMessagedAt: null,
    chats: [{ id: "7", title: "Book club", kind: "group", lastMessageAt: null }],
  }),
  chat: async () => ({ ...chat, members: [{ id: "9", name: "Olga", username: null }] }),
  around: async (_chat, id, { before, after }) => {
    const index = thread.findIndex((one) => one.id === id)
    return thread
      .slice(Math.max(0, index - before), index + after + 1)
      .map((one) => (one.id === id ? { ...one, anchor: true as const } : one))
  },
  send: async () => ({ message, sendId: "1" }),
  logout: async () => {},
  close: async () => {},
}

/** `meta` differs run to run: its run id and how long it took. */
const withoutMeta = <T extends { stdout: string[] }>(result: T): T => ({
  ...result,
  stdout: result.stdout.map((line) => {
    try {
      const { meta: _, ...rest } = JSON.parse(line)
      return JSON.stringify(rest)
    } catch {
      return line
    }
  }),
})

// One env is one machine: a key set by one call is there for the next call on the same env.
const keyrings = new WeakMap<NodeJS.ProcessEnv, KeyringStore>()
const keyringOf = (env: NodeJS.ProcessEnv): KeyringStore => {
  const known = keyrings.get(env) ?? memoryKeyring()
  keyrings.set(env, known)
  return known
}

const call = async (
  argv: string[],
  connect: Messenger["connect"],
  env: NodeJS.ProcessEnv,
  options: Partial<RunOptions & McpEnvironment> = {},
  own: Partial<Messenger> = {},
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    ...own,
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        accountCommand(messenger),
        chatsCommand(messenger),
        statsCommand(messenger),
        messagesCommand(messenger),
        reactionsCommand(messenger),
        pollsCommand(messenger),
        contactsCommand(messenger),
        recipientsCommand(messenger),
        sendsCommand(messenger),
        commandsCommand(app),
        completeCommand(messenger, settingsFor(app)),
        storeCommand(messenger),
        conversationsCommand(messenger),
        mcpCommand(messenger),
        modelsCommand(messenger),
        topicsCommand(messenger),
        searchCommand(messenger, { topics: true }),
      ],
    },
    { streams, tty: false, env, keyring: keyringOf(env), ...options },
  )
  if (code === 0 && argv[0] === "messages" && argv.includes("--json")) {
    const entity =
      argv[1] === "download" ? ENTITIES.message_download : argv[1] === "context" ? ENTITIES.message_context : undefined
    if (entity) {
      const answer = JSON.parse(streams.stdout[0] ?? "null")
      for (const item of answer.items ?? [answer.item]) v.parse(entity, item)
    }
  }
  if (code === 0 && argv.includes("--json")) {
    const names = {
      "chats inspect": "chat_inspection",
      "chats send-as": "chat_sender",
      "chats mark-read": "chat_read",
      "chats members fetch": "chat_members_fetch",
      "chats members add": "chat_members_change",
      "chats members remove": "chat_members_change",
      "chats create": "chat_group_change",
      "chats join": "chat_group_change",
      "chats leave": "chat_removal",
      "chats update": "chat_group_change",
      "chats links show": "chat_invite",
      "chats links create": "chat_invite_change",
      "chats links remove": "chat_invite_change",
      "chats links update": "chat_invite_change",
      "chats links reset": "chat_group_change",
      "chats requests confirm": "chat_request_change",
      "chats requests reject": "chat_request_change",
      "chats admins add": "chat_admin_change",
      "chats admins remove": "chat_admin_change",
      "chats folders create": "chat_folder_change",
      "chats folders update": "chat_folder_change",
      "chats folders join": "chat_folder_change",
      "chats folders delete": "chat_folder_removal",
      "chats folders order": "chat_folder_order",
      "chats rules": "chat_rules",
      "chats moderate": "chat_moderation",
      "conversations links rebuild": "conversation_build",
      "conversations show": "conversation.details",
      "conversations list": "conversation",
      "conversations related": "conversation_hit",
      "conversations status": "conversation_readiness",
      "conversations batches status": "conversation_batch_status",
      "conversations batches show": "conversation_batch",
      "conversations links add": "conversation_change",
      "conversations links clear": "conversation_change",
      "conversations embed": "conversation_embedding",
      "conversations embeddings status": "conversation_embedding_status",
      "conversations embeddings clear": "conversation_change",
      "conversations rebuild": "conversation_preparation",
      "search conversations": "conversation_hit",
    } as const
    const path = Object.keys(names)
      .sort((a, b) => b.length - a.length)
      .find((key) => argv.slice(0, key.split(" ").length).join(" ") === key)
    if (path) {
      const schema = ENTITIES[names[path as keyof typeof names]] as v.GenericSchema
      const answer = JSON.parse(streams.stdout[0] ?? "null")
      for (const item of answer.items ?? [answer.item]) v.parse(schema, item)
    }
  }
  if (code === 0 && argv[0] === "store" && argv.includes("--json")) {
    const names = { status: "store_chat_status", clear: "store_clear", export: "store_export" } as const
    const entity = names[argv[1] as keyof typeof names]
    if (entity) {
      const answer = JSON.parse(streams.stdout[0] ?? "null")
      for (const item of answer.items ?? [answer.item]) v.parse(ENTITIES[entity] as v.GenericSchema, item)
    }
  }
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("forum setup commands", () => {
  it("upgrades explicitly, enables on the new chat and creates a topic through guarded CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "forum-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const state = (id = "7", forum = false, needsUpgrade = true) => ({
      chat: { ...chat, id },
      forum,
      needsUpgrade,
      owner: true,
      linkedDiscussion: false,
      canCreate: true,
    })
    const upgradeForum = vi.fn(async () => state("8", false, false))
    const enableForum = vi.fn(async () => state("8", true, false))
    const createTopic = vi.fn(async () => ({
      id: "12",
      title: "synthetic",
      closed: false,
      pinned: false,
      unreadCount: 0,
      lastMessageAt: null,
      createdAt: "2026-10-03T00:00:00Z",
    }))
    let ready = false
    const connection = {
      ...fake,
      resolve: async (reference: string) => ({ ...chat, id: reference === "Book" ? "7" : reference }),
      forumState: async (id: string) => (id === "7" ? state() : state("8", ready, false)),
      upgradeForum,
      enableForum,
      createTopic,
    }
    const missingFlag = await call(["topics", "enable", "Book", "--yes"], async () => connection, env)
    expect(missingFlag.stderr.join("")).toContain("--upgrade")
    const enabled = await call(
      ["topics", "enable", "Book", "--upgrade", "--yes", "--json"],
      async () => connection,
      env,
    )
    expect(enabled.code).toBe(0)
    expect(enabled.stdout).toHaveLength(1)
    expect(JSON.parse(enabled.stdout[0] ?? "").item).toMatchObject({
      previous_chat_id: "7",
      chat: { id: "8" },
      upgraded: true,
      forum: true,
    })
    expect(upgradeForum).toHaveBeenCalledTimes(1)
    expect(enableForum).toHaveBeenCalledTimes(1)
    ready = true
    const made = await call(
      ["topics", "create", "8", "synthetic", "--operation-id", "42", "--json"],
      async () => connection,
      env,
    )
    expect(made.code).toBe(0)
    expect(createTopic).toHaveBeenCalledWith("8", "synthetic", { sendId: "42" })
    const withIcon = await call(
      ["topics", "create", "8", "synthetic", "--operation-id", "43", "--emoji", "🤖", "--json"],
      async () => connection,
      env,
    )
    expect(withIcon.code).toBe(0)
    expect(createTopic).toHaveBeenLastCalledWith("8", "synthetic", { sendId: "43", icon: "🤖" })
    expect(JSON.parse(made.stdout[0] ?? "").item).toMatchObject({ operation_id: "42", topic: { id: "12" } })
  })
})

describe("explicit topic addressing", () => {
  it("passes message and poll topics through the CLI and journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "topic-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const validateThread = vi.fn(async (_chat: string, _thread: string, _options: { replyTo?: string }) => {})
    const send = vi.fn(async (_chat: string, _text: string, options: SendOptions) => ({
      message,
      sendId: options.sendId,
    }))
    const createPoll = vi.fn(async (_chatId: string, _poll: unknown, options: { sendId: string }) => ({
      message,
      sendId: options.sendId,
    }))
    const connection = { ...fake, validateThread, send, createPoll }
    const sent = await call(
      ["messages", "send", "Book", "hello", "--topic", "12", "--reply-to", "14", "--operation-id", "42", "--json"],
      async () => connection,
      env,
    )
    const poll = await call(
      ["polls", "create", "Book", "Friday?", "yes", "no", "--topic", "12", "--operation-id", "43", "--json"],
      async () => connection,
      env,
    )
    expect(sent.code).toBe(0)
    expect(poll.code).toBe(0)
    expect(sent.stdout).toHaveLength(1)
    expect(JSON.parse(sent.stdout[0] ?? "").item).toMatchObject({ operation_id: "42" })
    expect(validateThread.mock.calls).toEqual([
      ["7", "12", { replyTo: "14" }],
      ["7", "12", {}],
    ])
    expect(send).toHaveBeenCalledWith(
      "7",
      "hello",
      expect.objectContaining({ threadId: "12", replyTo: "14", sendId: "42" }),
    )
    expect(createPoll).toHaveBeenCalledWith("7", expect.anything(), { threadId: "12", sendId: "43" })
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries().map(({ threadId }) => threadId)).toEqual([
      "12",
      "12",
    ])
    const unreadable = { ...message, attachments: null } as unknown as Message
    const sentUnreadable = vi.fn(async (_chat: string, _text: string, options: SendOptions) => ({
      message: unreadable,
      sendId: options.sendId,
    }))
    const lost = await call(
      ["messages", "send", "Book", "hello", "--operation-id", "44", "--json"],
      async () => ({ ...connection, send: sentUnreadable }),
      env,
    )
    expect(sentUnreadable).toHaveBeenCalledTimes(1)
    expect(lost.code).not.toBe(0)
    expect(JSON.parse(lost.stderr.at(-1) ?? "").error.details).toMatchObject({
      operation_id: "44",
    })
    expect((await call(["messages", "send", "Book", "hi", "--topic", " "], async () => connection, env)).code).not.toBe(
      0,
    )
    expect(
      (await call(["polls", "create", "Book", "Friday?", "yes", "no", "--topic", " "], async () => connection, env))
        .code,
    ).not.toBe(0)
    const unsupported = await call(["messages", "send", "Book", "hi", "--topic", "12"], async () => fake, env)
    expect(unsupported.stderr.join("")).toContain("cannot send to a forum topic")
    expect(send).toHaveBeenCalledTimes(1)
  })
})

it("names in a recorded answer's meta.run_id the run that was kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "messenger-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const { stdout } = await call(["chats", "list", "--json", "--record"], async () => fake, env)
  const runId = JSON.parse(stdout.join("")).meta.run_id

  expect(runId).toMatch(/-chats-list-/)
  expect(readdirSync(join(root, "state", "runs"), { recursive: true })).toContainEqual(expect.stringMatching(runId))
})

describe("the shared read commands", () => {
  it("**messages list --offline says how much of the chat the store holds**: incomplete, with the sync that fills it", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }
    const held = { provider: "chat", account: "500" }
    const offline = async () =>
      JSON.parse((await call(["messages", "list", "Book", "--offline", "--json"], never, env)).stdout[0] ?? "")
    const keep = async (work: (store: MessageStore) => Promise<unknown>) => {
      const store = await openStore({ path: env.MESSAGING_STORE })
      try {
        await work(store)
      } finally {
        await store.close()
      }
    }
    await call(["chats", "list", "--json"], async () => fake, env)
    await call(["messages", "list", "Book", "--json"], async () => fake, env)
    await keep((store) => store.sync.markRange(held, "7", 1, 1))

    const partial = await offline()
    expect(partial.meta.complete).toBe(false)
    expect(partial.missing).toEqual([
      {
        field: "history",
        why: "1 of 1 chats hold only part of their history; the first is held from 2026-09-27 only",
        step: "messages.sync",
      },
    ])
    expect(partial.next).toMatchObject([{ step: "messages.sync", args: { chat: "7" } }])

    await keep((store) => store.sync.setSyncState(held, historyStartKey("7"), "1"))
    const whole = await offline()
    expect(whole.missing).toBeUndefined()
    expect(whole.meta.complete).toBe(true)
  })

  it("**answer offline exactly what the messenger answered**, without connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const online = async () => fake
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }

    for (const argv of [
      ["chats", "list", "--json"],
      ["messages", "list", "Book", "--json"],
      ["messages", "context", "Book", "2", "--before-n", "1", "--after-n", "1", "--json"],
      ["messages", "show", "msg:chat/500/7/3", "--json"],
      ["contacts", "list", "--json"],
    ]) {
      const live = withoutMeta(await call(argv, online, env))
      const offline = withoutMeta(await call([...argv, "--offline"], never, env))
      expect(live.code).toBe(0)
      // What the store holds of the chat is told offline only: online the messenger is the answer.
      const stored = {
        ...offline,
        stdout: offline.stdout.map((line) => {
          const { next: _, missing: __, ...rest } = JSON.parse(line)
          return JSON.stringify(rest)
        }),
      }
      expect(stored).toEqual({ ...live, stderr: [] })
    }
  })

  it("**answer a shared contact card with its name and whole phone**, live and from the store", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const contact = { name: "Ana Ruiz", firstName: "Ana", lastName: "Ruiz", phone: "+34600123456", userId: "42" }
    const holding: MessengerAdapter = {
      ...fake,
      history: async () => ({
        items: [{ ...message, attachments: [{ kind: "contact", contact }] }],
        hasMore: false,
      }),
    }
    const argv = ["messages", "list", "7", "--json"]
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }

    const live = await call(argv, async () => holding, env)
    const stored = await call([...argv, "--offline"], never, env)

    for (const run of [live, stored]) {
      expect(run.stderr).toEqual([])
      const [item] = JSON.parse(run.stdout[0] ?? "").items
      expect(v.safeParse(ENTITIES.message, item).success).toBe(true)
      expect(item.attachments).toEqual([
        {
          kind: "contact",
          contact: { name: "Ana Ruiz", first_name: "Ana", last_name: "Ruiz", phone: "+34600123456", user_id: "42" },
        },
      ])
    }
  })

  it("mark the message asked for, and name one by its locator", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const context = await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const shown = await call(["messages", "show", "msg:chat/500/7/3", "--json"], async () => fake, env)
    const foreign = await call(["messages", "show", "msg:max/1/7/3"], async () => fake, env)

    expect(JSON.parse(context.stdout[0] ?? "").items.map((one: WindowedMessage) => [one.id, one.anchor])).toEqual([
      ["1", undefined],
      ["2", true],
      ["3", undefined],
    ])
    expect(JSON.parse(shown.stdout[0] ?? "").item).toMatchObject({ id: "3", anchor: true, ref: "msg:chat/500/7/3" })
    expect(foreign.code).toBe(2)
  })

  it("**take a chat: or msg: reference wherever a chat is named**, and refuse one of another account or messenger", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const online = async () => fake
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }
    await call(["chats", "list", "--json"], online, env)
    await call(["messages", "list", "Book", "--json"], online, env)

    for (const [bare, named] of [
      [
        ["messages", "list", "7"],
        ["messages", "list", "chat:chat/500/7"],
      ],
      [
        ["messages", "context", "7", "2"],
        ["messages", "context", "chat:chat/500/7", "2"],
      ],
      [
        ["messages", "context", "7", "2"],
        ["messages", "context", "msg:chat/500/7/2"],
      ],
    ] as const)
      for (const [mode, connect] of [
        [["--json"], online],
        [["--offline", "--json"], never],
      ] as const) {
        const asId = withoutMeta(await call([...bare, ...mode], connect, env))
        const asRef = withoutMeta(await call([...named, ...mode], connect, env))
        expect(asId.code).toBe(0)
        expect(asRef.stdout.map((line) => ({ ...JSON.parse(line), args: undefined }))).toEqual(
          asId.stdout.map((line) => ({ ...JSON.parse(line), args: undefined })),
        )
      }

    const refused = async (argv: string[]) => {
      const { code, stderr } = await call([...argv, "--json"], online, env)
      expect(code).toBe(2)
      return JSON.parse(stderr.at(-1) ?? "").error
    }
    for (const argv of [
      ["messages", "list", "chat:chat/501/7"],
      ["messages", "list", "chat:chat/501/7", "--offline"],
      ["messages", "show", "msg:chat/501/7/3"],
      ["messages", "context", "chat:chat/501/7", "2"],
    ])
      expect(await refused(argv)).toMatchObject({
        reason: "ref.wrong-account",
        message: expect.stringMatching(/^(chat:chat\/501\/7|msg:chat\/501\/7\/3) belongs to account 501; /),
      })
    expect(await refused(["messages", "list", "chat:chat/501/7", "--offline"])).toMatchObject({
      message:
        "chat:chat/501/7 belongs to account 501; this profile is account 500. Profiles signed in to 501: none here",
    })
    expect(await refused(["messages", "list", "chat:telegram/1/2"])).toMatchObject({
      reason: "ref.wrong-provider",
      message: "chat:telegram/1/2 is a Telegram chat; open it with tg <profile> messages list chat:telegram/1/2",
    })
    expect(await refused(["messages", "list", "document:4", "--offline"])).toMatchObject({ reason: "ref.wrong-kind" })
  })

  it("read a negative chat id as the chat, with no -- before it", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    for (const argv of [
      ["messages", "list", "-1001", "--json"],
      ["messages", "list", "--json", "-1001"],
      ["messages", "show", "-1001", "2", "--json"],
    ]) {
      const { stderr } = await call(argv, async () => fake, env)
      expect(stderr.join("\n")).not.toMatch(/unknown option|too many arguments/)
    }
  })

  it("refuse a --limit that is not a whole number, quoting what was typed", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }

    for (const typed of ["abc", "12abc", "0"]) {
      const { code, stderr } = await call(["chats", "list", "--limit", typed, "--json"], async () => fake, env)
      expect(code).toBe(2)
      expect(stderr.join("\n")).toContain(`--limit takes a whole number from 1 upwards, not \\"${typed}\\"`)
    }
  })

  it("show a chat with who is in it, and explain differing member counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const { code, stdout, stderr } = await call(["chats", "show", "Book", "--json"], async () => fake, env)

    expect(code).toBe(0)
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      item: { id: "7", members: [{ id: "9" }] },
      missing: [
        { field: "members", why: "1 listed; the chat reports 4 — the list may omit your account or be partial" },
      ],
    })
    expect(stderr).toEqual([])
    const offline = await call(["chats", "show", "Book", "--offline"], async () => fake, env)
    expect(JSON.parse(offline.stderr[0] ?? "").error).toMatchObject({ code: "not_found" })

    await call(["chats", "list", "--json"], async () => fake, env)
    const stored = await call(["chats", "show", "Book", "--offline", "--json"], async () => fake, env)
    expect(JSON.parse(stored.stdout[0] ?? "").item).toMatchObject({ id: "7" })
    expect(JSON.parse(stored.stdout[0] ?? "").item).not.toHaveProperty("members")
  })

  it.each([
    [2, 3, true],
    [1, 4, true],
    [2, 2, false],
    [2, null, false],
    [0, 3, true],
  ])(
    "explain %s listed members and %s reported participants without inventing membership",
    async (count, total, note) => {
      const root = mkdtempSync(join(tmpdir(), "messenger-"))
      const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
      const members = Array.from({ length: count }, (_, index) => ({
        id: String(9 + index),
        name: "Member",
        username: null,
      }))
      const adapter: MessengerAdapter = {
        ...fake,
        chat: async () => ({ ...chat, participantsCount: total, members }),
      }
      const { code, stdout, stderr } = await call(["chats", "show", "Book", "--json"], async () => adapter, env)

      expect(code).toBe(0)
      const body = JSON.parse(stdout[0] ?? "")
      expect(body.item).toMatchObject({ participants_count: total, members })
      expect(stderr).toEqual([])
      expect(body.missing ?? []).toEqual(
        note
          ? [
              expect.objectContaining({
                why: `${count} listed; the chat reports ${total} — the list may omit your account or be partial`,
              }),
            ]
          : [],
      )
    },
  )

  it("list as contacts only the one-to-one chats, in the order asked for, and filter only stored contacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const names = async (...argv: string[]) =>
      JSON.parse(
        (await call(["contacts", "list", "--json", ...argv], async () => fake, env)).stdout[0] ?? "",
      ).items.map((one: { name: string }) => one.name)

    expect(await names()).toEqual(["Zoe", "Adam"])
    expect(await names("--order", "name")).toEqual(["Adam", "Zoe"])
    const unstored = await call(["contacts", "list", "--json", "name:ADAM_"], async () => fake, env)
    expect(JSON.parse(unstored.stderr.at(-1) ?? "").error).toMatchObject({ reason: "query.unsupported-field" })
    const shown = await call(["contacts", "show", "adam", "--json"], async () => fake, env)
    expect(JSON.parse(shown.stdout[0] ?? "").item).toMatchObject({
      ref: "contact:chat/21",
      id: "21",
      chats: [{ ref: "chat:chat/500/7", id: "7" }],
    })
  })

  it("**list a dialog under its person's id where the messenger names one**, and leave out the dialogs it cannot", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const partnerOf = (one: Chat) => (one.id === "20" ? "320" : undefined)

    const listed = await call(["contacts", "list", "--json"], async () => fake, env, {}, { partnerOf })

    expect(JSON.parse(listed.stdout[0] ?? "").items).toEqual([expect.objectContaining({ id: "320", name: "Zoe" })])
  })

  it("**send --reply-to answers the message named, with every send option, recorded without the text**", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const sent: { chatId: string; text: string; replyTo?: string; silent?: boolean }[] = []
    const replying: MessengerAdapter = {
      ...fake,
      send: async (chatId, text, { sendId, replyTo, silent }) => {
        sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}), ...(silent ? { silent } : {}) })
        return { message: { ...message, text }, sendId }
      },
    }

    const answer = (argv: string[]) => call(["messages", "send", "Book", ...argv], async () => replying, env)
    expect((await answer(["see you there", "--reply-to", "2"])).code).toBe(0)
    expect((await answer(["and bring it", "--reply-to", "3", "--silent"])).code).toBe(0)
    expect((await answer(["hello"])).code).toBe(0)
    expect((await answer(["nothing", "--reply-to", " "])).code).not.toBe(0)
    expect((await call(["messages", "reply", "Book", "2", "hi"], async () => replying, env)).code).not.toBe(0)

    expect(sent).toEqual([
      { chatId: "7", text: "see you there", replyTo: "2" },
      { chatId: "7", text: "and bring it", replyTo: "3", silent: true },
      { chatId: "7", text: "hello" },
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.map((entry) => [entry.outcome, entry.replyTo])).toEqual([
      ["sent", "2"],
      ["sent", "3"],
      ["sent", undefined],
    ])
    expect(JSON.stringify(journal)).not.toContain("see you there")
  })

  it("**send silently, without a preview, as Markdown** — and journal neither the text nor the marks", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const sent: SendOptions[] = []
    const texts: string[] = []
    const recording: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        texts.push(text)
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }

    const argv = ["messages", "send", "Book", "**secret** plan", "--silent", "--no-preview", "--md"]
    expect((await call(argv, async () => recording, env)).code).toBe(0)
    expect((await call(["messages", "send", "Book", "**as typed**"], async () => recording, env)).code).toBe(0)

    expect(texts).toEqual(["secret plan", "**as typed**"])
    expect(sent[0]).toMatchObject({ silent: true, noPreview: true, formatting: [{ type: "bold", from: 0, length: 6 }] })
    expect(sent[1]).not.toHaveProperty("silent")
    expect(sent[1]).not.toHaveProperty("noPreview")
    expect(sent[1]).not.toHaveProperty("formatting")
    const journal = JSON.stringify(new SendJournal(sendsPathFor(app, "default", env)).entries())
    expect(journal).not.toContain("secret")
    expect(journal).not.toContain("bold")
  })

  it("**a send answers its receipt in the envelope**: the message entity, and the ids to repeat it by even under --json message", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const sending: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, { sendId }) => ({ message: { ...message, text }, sendId }),
    }

    const whole = await call(
      ["messages", "send", "Book", "hi", "--operation-id", "77", "--json"],
      async () => sending,
      env,
    )
    const cut = await call(
      ["messages", "send", "Book", "hi", "--operation-id", "78", "--json=message"],
      async () => sending,
      env,
    )

    const answer = v.parse(itemEnvelopeSchema(v.unknown()), JSON.parse(whole.stdout[0] ?? ""))
    expect(answer.item).toMatchObject({ operation_id: "77" })
    expect(() => v.parse(ENTITIES.message, (answer.item as { message: unknown }).message)).not.toThrow()
    expect(JSON.parse(cut.stdout[0] ?? "").item).toEqual({
      operation_id: "78",
      message: expect.objectContaining({ ref: expect.stringMatching(/^msg:/), text: "hi" }),
    })
  })

  it("**schedule a send with --at-time**, answer scheduled_for with the queue as the next step, journal it for that hour, and never repeat one", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const sent: SendOptions[] = []
    const later: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        sent.push(options)
        return { message: { ...message, text, scheduledFor: options.at }, sendId: options.sendId }
      },
      scheduled: async () => [{ ...message, scheduledFor: "2030-01-01T09:00:00.000Z" }],
    }

    const scheduled = await call(
      ["messages", "send", "Book", "later", "--at-time", "30m", "--json"],
      async () => later,
      env,
    )
    const repeated = await call(
      ["messages", "send", "Book", "x", "--at-time", "1h", "--operation-id", "5"],
      async () => later,
      env,
    )
    const listed = await call(["messages", "scheduled", "Book", "--json"], async () => later, env)

    expect(scheduled.code).toBe(0)
    const answer = JSON.parse(scheduled.stdout[0] ?? "")
    const scheduledFor = answer.item.scheduled_for
    expect(sent.map((one) => one.at)).toEqual([scheduledFor])
    expect(Date.parse(scheduledFor) - Date.now()).toBeGreaterThan(28 * 60_000)
    expect(answer.next).toMatchObject([{ command: "messages scheduled", args: { chat: "7" } }])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { outcome: "sent", scheduledFor },
    ])
    expect(repeated.code).toBe(2)
    expect(JSON.parse(listed.stdout[0] ?? "").items[0].scheduled_for).toBe("2030-01-01T09:00:00.000Z")
  })

  it("**send nothing when --at-time is not a time**, and point at the queue when a scheduled send is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    let opened = false
    const lost: MessengerAdapter = {
      ...fake,
      send: async () => {
        throw new CliError("outcome_unknown", "no answer — repeat with --operation-id 1", { sendId: "1" })
      },
    }

    const bad = await call(
      ["messages", "send", "Book", "x", "--at-time", "tomorrow"],
      async () => {
        opened = true
        return lost
      },
      env,
    )
    const unknown = await call(["messages", "send", "Book", "x", "--at-time", "1h"], async () => lost, env)

    expect(bad.code).toBe(2)
    expect(opened).toBe(false)
    const error = JSON.parse(unknown.stderr[0] ?? "").error
    expect(error.code).toBe("outcome_unknown")
    expect(error.message).toContain("messages scheduled")
    expect(error.sendId).toBeUndefined()
  })

  it("**send a photo with a caption**, journal its kind and size — never its name — and refuse a hidden file", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    writeFileSync(join(root, "holiday.png"), "12345")
    mkdirSync(join(root, ".secrets"))
    writeFileSync(join(root, ".secrets", "token"), "t")
    const sent: SendOptions[] = []
    const texts: string[] = []
    const withFiles: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        texts.push(text)
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }

    const photo = await call(
      ["messages", "send", "Book", "look", "--photo", join(root, "holiday.png")],
      async () => withFiles,
      env,
    )
    const hidden = await call(
      ["messages", "send", "Book", "--file", join(root, ".secrets", "token")],
      async () => withFiles,
      env,
    )

    expect(photo.code).toBe(0)
    expect(texts).toEqual(["look"])
    expect(sent[0]?.attachments).toMatchObject([{ kind: "photo", name: "holiday.png" }])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal).toMatchObject([{ outcome: "sent", attachments: [{ kind: "photo", bytes: 5 }] }])
    expect(JSON.stringify(journal)).not.toContain("holiday")
    expect(hidden.code).toBe(2)
    expect(sent).toHaveLength(1)
  })

  it("**a sticker file counts toward the hourly limit like a message**, journalled by kind and size, never its name", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 1 } } }),
    )
    writeFileSync(join(root, "cat.webp"), "RIFF\0\0\0\0WEBP")
    const sent: SendOptions[] = []
    const withStickers: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }
    const send = () =>
      call(
        ["messages", "send", "Book", "--sticker-file", join(root, "cat.webp")],
        async () => withStickers,
        env,
        {},
        {
          stickerFileBytes: 1024,
        },
      )

    const first = await send()
    const second = await send()

    expect([first.code, second.code]).toEqual([0, 8])
    expect(sent).toHaveLength(1)
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal).toMatchObject([
      { kind: "message", outcome: "sent", attachments: [{ kind: "sticker", bytes: 12 }] },
      { kind: "message", outcome: "refused" },
    ])
    expect(JSON.stringify(journal)).not.toContain("cat")
  })

  it("saves --draft only when opted in, never sends, and refuses send-only flags before connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "draft-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const send = vi.fn(fake.send)
    const saveDraft = vi.fn(async () => {})
    const connect = vi.fn(async () => ({ ...fake, send, saveDraft }))
    const saved = await call(
      ["messages", "send", "Book", "Review this", "--draft", "--json"],
      connect,
      env,
      {},
      { drafts: true },
    )
    expect(saved.code).toBe(0)
    const item = JSON.parse(saved.stdout[0] ?? "").item
    expect(item).toMatchObject({ chat_id: "7", saved: true, operation_id: expect.any(String) })
    expect(v.safeParse(ENTITIES.message_send, item).success).toBe(true)
    expect(saveDraft).toHaveBeenCalledWith("7", "Review this", {})
    expect(send).not.toHaveBeenCalled()
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { drafts: "deny" } } } }),
    )
    const denied = await call(["messages", "send", "Book", "draft", "--draft"], connect, env, {}, { drafts: true })
    expect(denied.code).not.toBe(0)
    expect(denied.stderr.join("")).toContain("drafts")
    expect(saveDraft).toHaveBeenCalledOnce()
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { drafts: "readonly" } } } }),
    )
    const readonly = await call(["messages", "send", "Book", "draft", "--draft"], connect, env, {}, { drafts: true })
    expect(readonly.code).not.toBe(0)
    expect(readonly.stderr.join("")).toContain("drafts")
    expect(saveDraft).toHaveBeenCalledOnce()
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { default: {} } }))
    connect.mockClear()
    const incompatible = await call(
      ["messages", "send", "Book", "draft", "--draft", "--file", "/missing"],
      connect,
      env,
      {},
      { drafts: true },
    )
    expect(incompatible.code).toBe(2)
    expect(incompatible.stderr.join("")).toContain("--draft cannot be combined with --file")
    const empty = await call(["messages", "send", "Book", " ", "--draft"], connect, env, {}, { drafts: true })
    expect(empty.code).toBe(2)
    expect(connect).not.toHaveBeenCalled()
    const disabled = await call(["messages", "send", "Book", "draft", "--draft"], connect, env)
    expect(disabled.code).toBe(2)
    expect(connect).not.toHaveBeenCalled()
    const missing = await call(
      ["messages", "send", "Book", "draft", "--draft"],
      async () => ({ ...fake, send }),
      env,
      {},
      { drafts: true },
    )
    expect(missing.code).toBe(2)
    expect(send).not.toHaveBeenCalled()
  })

  it("**an album counts each photo and file toward the hourly limit** (NEED-1660) and answers with every message", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 3 } } }),
    )
    for (const name of ["a.png", "b.png", "c.pdf", "d.pdf"]) writeFileSync(join(root, name), "12345")
    const sent: SendOptions[] = []
    const albums: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        sent.push(options)
        const messages = (options.attachments ?? [{}]).map((_, at) => ({
          ...message,
          id: String(20 + at),
          text: at === 0 ? text : "",
        }))
        return {
          message: messages[0] ?? message,
          ...(messages.length > 1 ? { messages } : {}),
          sendId: options.sendId,
        }
      },
    }
    const send = (...argv: string[]) => call(["messages", "send", "Book", ...argv], async () => albums, env)

    const tooMany = await send(
      "look",
      ...["a.png", "b.png", "a.png", "b.png"].flatMap((name) => ["--photo", join(root, name)]),
    )
    const named = await send("--file", join(root, "c.pdf"), "--file", join(root, "d.pdf"), "--filename", "x.pdf")
    const album = await send(
      "look",
      "--file",
      join(root, "c.pdf"),
      "--photo",
      join(root, "a.png"),
      "--photo",
      join(root, "b.png"),
      "--json",
    )
    const after = await send("one more")

    expect(tooMany.code).toBe(8)
    expect(tooMany.stderr.join("")).toContain("4 at once")
    expect(named.code).toBe(2)
    expect([album.code, after.code]).toEqual([0, 8])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.attachments?.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "photo:a.png",
      "photo:b.png",
      "file:c.pdf",
    ])
    const item = JSON.parse(album.stdout[0] ?? "").item
    expect(item.message).toMatchObject({ id: "20", text: "look" })
    expect(item.messages.map((one: { id: string }) => one.id)).toEqual(["20", "21", "22"])
    expect(v.safeParse(ENTITIES.message_write, item).success).toBe(true)
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { outcome: "refused", count: 4 },
      { outcome: "sent", count: 3, messageId: "20" },
      { outcome: "refused" },
    ])
  })

  it("**a messenger that cannot send an album refuses it**, and the refused album does not count", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    for (const name of ["a.png", "b.png"]) writeFileSync(join(root, name), "12345")
    const single: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        if ((options.attachments ?? []).length > 1)
          throw new CliError("validation_error", "this messenger sends one file per message")
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }

    const album = await call(
      ["messages", "send", "Book", "--photo", join(root, "a.png"), "--photo", join(root, "b.png")],
      async () => single,
      env,
    )
    const one = await call(
      ["messages", "send", "Book", "--photo", join(root, "a.png"), "--json"],
      async () => single,
      env,
    )

    expect(album.code).toBe(2)
    expect(album.stderr.join("")).toContain("one file per message")
    expect(one.code).toBe(0)
    expect(JSON.parse(one.stdout[0] ?? "").item).not.toHaveProperty("messages")
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { outcome: "failed", errorCode: "validation_error", count: 2 },
      { outcome: "sent" },
    ])
  })

  it("**send a voice message alone, and a video as a file only with --as-file**", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    writeFileSync(join(root, "note.ogg"), "ogg")
    writeFileSync(join(root, "note.mp3"), "mp3")
    writeFileSync(join(root, "trip.mp4"), "mp4")
    const sent: SendOptions[] = []
    const recording: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }
    const send = (...argv: string[]) => call(["messages", "send", "Book", ...argv], async () => recording, env)

    const voice = await send("--voice", join(root, "note.ogg"))
    const video = await send("--file", join(root, "trip.mp4"))
    const asFile = await send("--file", join(root, "trip.mp4"), "--as-file")
    const withText = await send("hello", "--voice", join(root, "note.ogg"))
    const notOpus = await send("--voice", join(root, "note.mp3"))
    const nothingToKeep = await send("hi", "--as-file")

    expect([voice.code, video.code, asFile.code]).toEqual([0, 0, 0])
    expect(sent.map((options) => options.attachments)).toMatchObject([
      [{ kind: "voice", name: "note.ogg" }],
      [{ kind: "file", name: "trip.mp4" }],
      [{ kind: "file", name: "trip.mp4", asFile: true }],
    ])
    expect(sent[1]?.attachments?.[0]).not.toHaveProperty("asFile")
    expect([withText.code, notOpus.code, nothingToKeep.code]).toEqual([2, 2, 2])
    expect(withText.stderr.join("\n")).toContain("goes alone")
  })

  it("**edit the owner's message through the guard**, record it without the text, and answer the edited message", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const edits: string[][] = []
    const editing: MessengerAdapter = {
      ...fake,
      edit: async (chatId, messageId, text) => {
        edits.push([chatId, messageId, text])
        return { ...message, id: messageId, text, editedAt: "2026-09-29T10:00:00.000Z" }
      },
    }

    const done = await call(["messages", "edit", "Book", "3", "new plan", "--json"], async () => editing, env)
    const unable = await call(["messages", "edit", "Book", "3", "again"], async () => fake, env)

    expect(done.code).toBe(0)
    expect(JSON.parse(done.stdout[0] ?? "").item.message).toMatchObject({ id: "3", text: "new plan" })
    expect(edits).toEqual([["7", "3", "new plan"]])
    expect(unable.stderr.join("\n")).toContain("cannot edit a message")
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome !== "reserved")).toMatchObject([
      { kind: "edit", outcome: "sent", chatId: "7", messageId: "3", length: 8 },
    ])
    expect(JSON.stringify(journal)).not.toContain("new plan")
  })

  it("**edit with --md takes the marks out and sends them as markup**, as a send does", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const edits: unknown[] = []
    const editing: MessengerAdapter = {
      ...fake,
      edit: async (_chatId, messageId, text, options) => {
        edits.push([text, options])
        return { ...message, id: messageId, text }
      },
    }

    const marked = await call(
      ["messages", "edit", "Book", "3", "**new** plan", "--md", "--json"],
      async () => editing,
      env,
    )
    const plain = await call(["messages", "edit", "Book", "3", "**new** plan", "--json"], async () => editing, env)

    expect(marked.code).toBe(0)
    expect(plain.code).toBe(0)
    expect(edits).toEqual([
      ["new plan", { formatting: [{ type: "bold", from: 0, length: 3 }] }],
      ["**new** plan", {}],
    ])
  })

  it("**forward into the chat named by --to**, guarded against that chat, and answer the copy there", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const forwards: unknown[] = []
    const forwarding: MessengerAdapter = {
      ...fake,
      resolve: async (reference) => (reference === "Zoe" ? { ...chat, id: "20", title: "Zoe" } : chat),
      forward: async (from, id, to, options) => {
        forwards.push([from, id, to, options])
        return { ...message, id: "50", chatId: to }
      },
    }

    const done = await call(
      ["messages", "forward", "Book", "3", "--to", "Zoe", "--silent", "--json"],
      async () => forwarding,
      env,
    )

    expect(done.code).toBe(0)
    expect(JSON.parse(done.stdout[0] ?? "").item.message).toMatchObject({ id: "50", chat_id: "20" })
    expect(forwards).toEqual([["7", "3", "20", { sendId: expect.any(String), silent: true }]])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.at(-1)).toMatchObject({ kind: "forward", outcome: "sent", chatId: "20", messageId: "50" })
  })

  it("**forward into a forum topic of the --to chat**, checked there before the write; no --topic without topics", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const steps: unknown[] = []
    const forwarding: MessengerAdapter = {
      ...fake,
      resolve: async (reference) => (reference === "Zoe" ? { ...chat, id: "20", title: "Zoe" } : chat),
      validateThread: async (chatId, threadId) => {
        steps.push(["check", chatId, threadId])
        if (threadId === "6") throw new CliError("permission_error", "that forum topic is closed")
      },
      forward: async (_from, _id, to, options) => {
        steps.push(["forward", to, options.threadId])
        return { ...message, id: "50", chatId: to }
      },
    }
    const forward = (topic: string, own: Partial<Messenger> = { forwardTopic: true }) =>
      call(["messages", "forward", "Book", "3", "--to", "Zoe", "--topic", topic], async () => forwarding, env, {}, own)

    expect((await forward("5")).code).toBe(0)
    expect((await forward("6")).code).not.toBe(0)
    expect((await forward("5", {})).code).not.toBe(0)

    expect(steps).toEqual([
      ["check", "20", "5"],
      ["forward", "20", "5"],
      ["check", "20", "6"],
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.find((entry) => entry.outcome === "sent")).toMatchObject({ kind: "forward", threadId: "5" })
  })

  it("**a forward repeated with its --operation-id after an unknown outcome leaves one copy**", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const copies = new Map<string, Message>()
    let answered = false
    const deduplicating: MessengerAdapter = {
      ...fake,
      resolve: async (reference) => (reference === "Zoe" ? { ...chat, id: "20", title: "Zoe" } : chat),
      forward: async (_from, _id, to, { sendId }) => {
        const copy = copies.get(sendId) ?? { ...message, id: String(50 + copies.size), chatId: to }
        copies.set(sendId, copy)
        if (!answered) {
          answered = true
          throw new CliError("outcome_unknown", "no answer", { sendId })
        }
        return copy
      },
    }
    const forward = ["messages", "forward", "Book", "3", "--to", "Zoe", "--operation-id", "9001", "--json"]

    expect((await call(forward, async () => deduplicating, env)).code).toBe(14)
    const repeated = await call(forward, async () => deduplicating, env)

    expect(repeated.code).toBe(0)
    expect(JSON.parse(repeated.stdout[0] ?? "").item).toMatchObject({ operation_id: "9001", message: { id: "50" } })
    expect(copies.size).toBe(1)
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome !== "reserved")).toMatchObject([
      { kind: "forward", sendId: "9001", outcome: "outcome_unknown" },
      { kind: "forward", sendId: "9001", outcome: "sent", messageId: "50" },
    ])
  })

  it("**pin quietly without counting toward the hourly limit**; a pin that notifies counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 1 } } }),
    )
    const pins: unknown[] = []
    const pinning: MessengerAdapter = {
      ...fake,
      pin: async (chatId, messageId, options) => {
        pins.push(["pin", chatId, messageId, options])
      },
      unpin: async (chatId, messageId) => {
        pins.push(["unpin", chatId, messageId])
      },
    }

    const quiet = await call(["messages", "pin", "Book", "3", "--json"], async () => pinning, env)
    const loud = await call(["messages", "pin", "Book", "4", "--notify"], async () => pinning, env)
    const over = await call(["messages", "pin", "Book", "5", "--notify"], async () => pinning, env)
    const off = await call(["messages", "unpin", "Book", "3", "--json"], async () => pinning, env)

    expect(v.safeParse(ENTITIES.message_pin, JSON.parse(quiet.stdout[0] ?? "").item).success).toBe(true)
    expect(v.safeParse(ENTITIES.message_pin, JSON.parse(off.stdout[0] ?? "").item).success).toBe(true)
    expect(JSON.parse(quiet.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      message_id: "3",
      pinned: true,
    })
    expect([loud.code, over.code]).toEqual([0, 8])
    expect(JSON.parse(off.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      message_id: "3",
      pinned: false,
    })
    expect(pins).toEqual([
      ["pin", "7", "3", { notify: false }],
      ["pin", "7", "4", { notify: true }],
      ["unpin", "7", "3"],
    ])
  })

  it("**every pin notifies and counts where the messenger has no quiet pin**, an unpin does not, and a pin lasts as offered", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 1 } } }),
    )
    const pins: unknown[] = []
    const pinning: MessengerAdapter = {
      ...fake,
      pin: async (chatId, messageId, options) => {
        pins.push([chatId, messageId, options])
      },
      unpin: async (chatId, messageId) => {
        pins.push(["unpin", chatId, messageId])
      },
    }
    const loud = { quietPins: false, pinDurations: [86_400, 604_800, 2_592_000], pinDefaultDuration: 604_800 }

    const pinned = await call(["messages", "pin", "Book", "3"], async () => pinning, env, {}, loud)
    const odd = await call(["messages", "pin", "Book", "3", "--expire-time", "1h"], async () => pinning, env, {}, loud)
    const notify = await call(["messages", "pin", "Book", "3", "--notify"], async () => pinning, env, {}, loud)
    const over = await call(
      ["messages", "pin", "Book", "4", "--expire-time", "24h"],
      async () => pinning,
      env,
      {},
      loud,
    )
    const unpinned = await call(["messages", "unpin", "Book", "3"], async () => pinning, env, {}, loud)
    const help = (await call(["messages", "pin", "--help"], async () => pinning, env, {}, loud)).stdout.join("")
    const telegram = await call(["messages", "pin", "Book", "5", "--expire-time", "24h"], async () => pinning, env)

    expect([pinned.code, odd.code, notify.code, over.code, unpinned.code, telegram.code]).toEqual([0, 2, 2, 8, 0, 2])
    expect(odd.stderr.join("")).toContain("--expire-time takes 24h, 7d or 30d from now")
    expect(notify.stderr.join("")).toContain("--notify")
    expect(help).toContain("its members are told")
    expect(help).not.toContain("--notify")
    expect(help).toContain("--expire-time <time>  how long the pin lasts: 24h, 7d or 30d; 7d by default")
    expect(pins).toEqual([
      ["7", "3", { notify: true, duration: 604_800 }],
      ["unpin", "7", "3"],
    ])
  })

  it("**star a message and take the star off**, journaled as the owner's own mark that never counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 1 } } }),
    )
    const stars: unknown[] = []
    const starring: MessengerAdapter = {
      ...fake,
      star: async (chatId, messageId, starred) => {
        stars.push([chatId, messageId, starred])
      },
    }

    const on = await call(
      ["messages", "star", "Book", "3", "--json"],
      async () => starring,
      env,
      {},
      { messageStars: true },
    )
    const again = await call(["messages", "star", "Book", "4"], async () => starring, env, {}, { messageStars: true })
    const off = await call(["messages", "unstar", "Book", "3"], async () => starring, env, {}, { messageStars: true })
    const elsewhere = await call(["messages", "star", "Book", "3"], async () => starring, env)

    expect(JSON.parse(on.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      message_id: "3",
      starred: true,
    })
    expect([again.code, off.code, elsewhere.code]).toEqual([0, 0, 2])
    expect(stars).toEqual([
      ["7", "3", true],
      ["7", "4", true],
      ["7", "3", false],
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome === "sent")).toMatchObject([
      { kind: "account", action: "message-star", messageId: "3" },
      { kind: "account", action: "message-star", messageId: "4" },
      { kind: "account", action: "message-unstar", messageId: "3" },
    ])

    const locked = { ...env, CHAT_CONFIG_DIR: join(root, "locked") }
    mkdirSync(locked.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(locked.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ defaults: { permissions: { "messages.unstar": "readonly" } }, profiles: {} }),
    )
    const codes = await Promise.all(
      ["star", "unstar"].map(
        async (verb) =>
          (await call(["messages", verb, "Book", "5"], async () => starring, locked, {}, { messageStars: true })).code,
      ),
    )
    expect(codes).toEqual([0, 5])
  })

  it("**react with one emoji and take it off**, journaled as reactions that do not count toward the limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 1 } } }),
    )
    const reactions: unknown[] = []
    const reacting: MessengerAdapter = {
      ...fake,
      react: async (chatId, messageId, emoji) => {
        reactions.push([chatId, messageId, emoji])
      },
    }

    await call(["messages", "send", "Book", "spends the hour"], async () => reacting, env)
    const added = await call(["reactions", "add", "Book", "3", "👍", "--json"], async () => reacting, env)
    const removed = await call(["reactions", "remove", "Book", "3", "--json"], async () => reacting, env)

    expect(JSON.parse(added.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      message_id: "3",
      reaction: "👍",
    })
    expect(JSON.parse(removed.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      message_id: "3",
      reaction: null,
    })
    expect(v.safeParse(ENTITIES.reaction_change, JSON.parse(added.stdout[0] ?? "").item).success).toBe(true)
    expect(v.safeParse(ENTITIES.reaction_change, JSON.parse(removed.stdout[0] ?? "").item).success).toBe(true)
    const projected = await call(["reactions", "add", "Book", "3", "👍", "--json=reaction"], async () => reacting, env)
    expect(JSON.parse(projected.stdout[0] ?? "").item).toEqual({ operation_id: expect.any(String), reaction: "👍" })
    const invalid = await call(["reactions", "remove", "Book", "3", "--json=missing"], async () => reacting, env)
    expect(invalid.code).toBe(2)
    expect(reactions).toEqual([
      ["7", "3", "👍"],
      ["7", "3", null],
      ["7", "3", "👍"],
    ])
  })

  it("**lists who reacted** by cursor, refuses where the list is hidden, and stays off a messenger without it", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const reactor = {
      person: { id: "91", name: "Ana", username: null },
      reaction: "🔥",
      reactedAt: "2026-10-08T09:00:00.000Z",
    }
    const asked: unknown[] = []
    let hidden = false
    const reacting: MessengerAdapter = {
      ...fake,
      reactors: async (_chatId, _messageId, window) => {
        asked.push(window)
        if (hidden) throw new CliError("permission_error", "the chat hides it", { reason: "reactions.list-hidden" })
        return { items: [reactor], hasMore: true, cursor: "next" }
      },
    }
    const list = (...extra: string[]) =>
      call(["reactions", "list", "Book", "3", ...extra], async () => reacting, env, {}, { reactionsList: true })

    const listed = await list("reaction:🔥", "--limit", "1", "--cursor", "first", "--json")
    hidden = true
    const refused = await list("--json")
    const unlisted = await call(["reactions", "list", "Book", "3"], async () => reacting, env)

    const body = JSON.parse(listed.stdout[0] ?? "")
    expect(body.items).toEqual([
      { person: { id: "91", name: "Ana", username: null }, reaction: "🔥", reacted_at: reactor.reactedAt },
    ])
    expect(v.safeParse(ENTITIES.reaction, body.items[0]).success).toBe(true)
    expect(body.page).toMatchObject({ mode: "cursor", has_more: true, next_cursor: "next" })
    expect(body.next[0].args).toMatchObject({ chat: "Book", message: "3", query: "reaction:🔥", cursor: "next" })
    expect(asked[0]).toEqual({ limit: 1, emoji: "🔥", cursor: "first" })
    expect(refused.code).toBe(5)
    expect(refused.stderr.join("\n")).toContain("reactions.list-hidden")
    expect(unlisted.code).not.toBe(0)
    expect(body.missing).toBeUndefined()
  })

  it("says in `reactions list` what it covers when the messenger names a scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const reactor = {
      person: { id: "91", name: "Ana", username: null },
      reaction: "🔥",
      reactedAt: "2026-10-08T09:00:00.000Z",
    }
    const scope = "reactions received while this computer was syncing"
    const reacting: MessengerAdapter = { ...fake, reactors: async () => ({ items: [reactor], hasMore: false }) }
    const list = (options: Partial<RunOptions & McpEnvironment>, ...extra: string[]) =>
      call(["reactions", "list", "Book", "3", ...extra], async () => reacting, env, options, {
        reactionsList: true,
        reactionsListScope: scope,
      })

    const json = await list({}, "--json")
    const human = await list({ tty: true })

    expect(JSON.parse(json.stdout[0] ?? "").missing).toEqual([{ field: "reactions", why: `shows only ${scope}` }])
    expect(json.stderr.join("\n")).not.toContain("shows only")
    expect(human.stderr.join("\n")).toContain(`shows only ${scope}`)
  })

  it("**messages list never marks the chat read and refuses --mark-read**", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const marks: unknown[] = []
    const reading: MessengerAdapter = {
      ...fake,
      markRead: async (chatId, until) => {
        marks.push([chatId, until])
      },
    }

    await call(["messages", "list", "Book", "--json"], async () => reading, env)
    await call(["messages", "list", "Book", "--transcribe", "--json"], async () => reading, env)
    expect(marks).toEqual([])

    const marked = await call(["messages", "list", "Book", "--mark-read", "--json"], async () => reading, env)
    const offline = await call(["messages", "list", "Book", "--mark-read", "--offline"], async () => reading, env)
    const lonelyModel = await call(["messages", "list", "Book", "--model", "gigaam-v3"], async () => reading, env)

    expect(marked.code).toBe(2)
    expect(marks).toEqual([])
    expect(offline.code).toBe(2)
    expect(lonelyModel.code).toBe(2)
    expect(lonelyModel.stderr.join("\n")).toContain("add --transcribe")
  })

  it("**mark a chat read, to its newest message or --until-id one**, journaled as a read", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const marks: unknown[] = []
    const reading: MessengerAdapter = {
      ...fake,
      markRead: async (chatId, until) => {
        marks.push([chatId, until])
      },
    }

    const all = await call(["chats", "mark-read", "Book", "--json"], async () => reading, env)
    const some = await call(["chats", "mark-read", "Book", "--until-id", "3", "--json"], async () => reading, env)

    expect(JSON.parse(all.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      until: null,
    })
    expect(JSON.parse(some.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      until: "3",
    })
    expect(marks).toEqual([
      ["7", undefined],
      ["7", "3"],
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.map((entry) => [entry.kind, entry.messageId])).toEqual([
      ["read", undefined],
      ["read", "3"],
    ])
    expect((await call(["chats", "read", "Book"], async () => reading, env)).code).not.toBe(0)
  })

  it("guards with the messenger's own guard when it has one", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const asked: unknown[] = []
    const refusing = {
      guard: () => ({
        check: (request: unknown) => {
          asked.push(request)
          throw new CliError("permission_error", "the messenger's own guard said no")
        },
        record: () => {},
      }),
    }

    const refused = await call(
      ["reactions", "add", "Book", "3", "👍"],
      async () => ({ ...fake, react: async () => {} }),
      env,
      {},
      refusing,
    )

    expect(refused.code).toBe(5)
    expect(refused.stderr.join("\n")).toContain("the messenger's own guard said no")
    expect(asked).toMatchObject([{ chatId: "7", kind: "reaction", messageId: "3" }])
  })

  it("hands the run's diagnostics to connect, so a messenger can report its own wire", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const traced = await call(
      ["reactions", "add", "Book", "3", "👍", "--json", "--trace"],
      async (_command, _context, options) => {
        options?.events?.({ event: "request", operation: "wire.frame", opcode: 178, seq: 1 })
        return { ...fake, react: async () => {} }
      },
      env,
    )

    expect(traced.stderr.join("\n")).toContain('"operation":"wire.frame","opcode":178')
  })

  it("refuses a delete under the read-only lock before it would ask, with exit 5", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_READ_ONLY: "1" }
    const deletions: unknown[] = []
    const deleting: MessengerAdapter = {
      ...fake,
      delete: async (chatId, ids) => {
        deletions.push([chatId, ids])
      },
    }

    const locked = await call(["messages", "delete", "Book", "3", "--json"], async () => deleting, env)

    expect(locked.code).toBe(5)
    expect(JSON.parse(locked.stderr.join("")).error).toMatchObject({
      code: "permission_error",
      message: expect.stringContaining("this process is read-only (CHAT_READ_ONLY)"),
    })
    expect(deletions).toEqual([])
  })

  it.each([
    ["messages send", ["messages", "send", "Book", "hi"]],
    ["messages send --dry-run", ["messages", "send", "Book", "hi", "--dry-run"]],
    ["messages edit", ["messages", "edit", "Book", "3", "hi"]],
    ["messages delete --for-everyone", ["messages", "delete", "Book", "3", "--for-everyone", "--allow-dangerous"]],
    ["reactions add", ["reactions", "add", "Book", "3", "👍"]],
  ])("refuses %s under the read-only lock before it connects", async (_name, argv) => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_READ_ONLY: "1" }
    let connected = 0

    const locked = await call(
      [...argv, "--json"],
      async () => {
        connected += 1
        return fake
      },
      env,
    )

    expect([locked.code, connected]).toEqual([5, 0])
    expect(JSON.parse(locked.stderr.join("")).error.message).toBe(
      "this process is read-only (CHAT_READ_ONLY) — it cannot send, react, change chats or change the account",
    )
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.map(({ outcome }) => outcome)).toEqual(argv.includes("--dry-run") ? [] : ["refused"])
  })

  it("refuses a write on a readonly profile before it connects, and journals what it knows", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "readonly", reactions: "readonly" } } } }),
    )
    let connected = 0
    const write = (argv: string[]) => call([...argv, "--json"], async () => (connected++, fake), env)

    const sent = await write(["messages", "send", "Book", "hi"])
    const unpinned = await write(["messages", "unpin", "7", "3"])
    const reacted = await write(["reactions", "add", "7", "3", "👍"])

    expect([sent.code, unpinned.code, reacted.code, connected]).toEqual([5, 5, 5, 0])
    expect(JSON.parse(sent.stderr.join("")).error.message).toContain("permissions.messages is readonly")
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { chatId: null, kind: "message", key: "messages.send", outcome: "refused", errorCode: "permission_error" },
      { chatId: "7", kind: "pin", key: "messages.unpin", outcome: "refused" },
      { chatId: "7", kind: "reaction", key: "reactions.add", outcome: "refused" },
    ])
  })

  it("**delete only with --allow-dangerous**, each message counted toward the hourly limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sends_per_hour: 3 } } }),
    )
    const deletions: unknown[] = []
    const deleting: MessengerAdapter = {
      ...fake,
      delete: async (chatId, ids, options) => {
        deletions.push([chatId, ids, options])
      },
    }
    const eleven = Array.from({ length: 11 }, (_, index) => String(index + 1))

    const unasked = await call(["messages", "delete", "Book", "3"], async () => deleting, env)
    const tooMany = await call(
      ["messages", "delete", "Book", ...eleven, "--allow-dangerous"],
      async () => deleting,
      env,
    )
    const done = await call(
      ["messages", "delete", "Book", "3", "4", "--for-everyone", "--allow-dangerous", "--json", "--trace"],
      async () => deleting,
      env,
    )
    const over = await call(["messages", "delete", "Book", "5", "6", "--allow-dangerous"], async () => deleting, env)

    expect(unasked.stderr.join("\n")).toContain("--allow-dangerous")
    expect(tooMany.stderr.join("\n")).toContain("at most 10")
    const answer = JSON.parse(done.stdout[0] ?? "").item
    expect(v.safeParse(ENTITIES.message_deletion, answer).success).toBe(true)
    expect(answer).toEqual({ operation_id: expect.any(String), chat_id: "7", deleted: ["3", "4"], for_everyone: true })
    expect(over.code).toBe(8)
    expect(deletions).toEqual([["7", ["3", "4"], { forEveryone: true }]])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome === "sent")).toMatchObject([
      { kind: "delete", count: 2, forEveryone: true, operationId: answer.operation_id },
    ])
    expect(done.stderr.join("\n")).toContain(`"ids":{"operation":"${answer.operation_id}"}`)
  })

  it("**asks before a write whose level is ask**, refuses one that is readonly, and never asks at allow", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const config = (permissions: Record<string, string>) => {
      mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
      writeFileSync(
        join(env.CHAT_CONFIG_DIR, "config.json"),
        JSON.stringify({ profiles: { default: { permissions } } }),
      )
    }
    const deletions: unknown[] = []
    const reactions: unknown[] = []
    const adapter: MessengerAdapter = {
      ...fake,
      delete: async (chatId, ids) => {
        deletions.push([chatId, ids])
      },
      react: async (chatId, id, emoji) => {
        reactions.push([chatId, id, emoji])
      },
    }
    const questions: string[] = []
    const answering = (answer: string | null) => ({
      answer: (question: string) => {
        questions.push(question)
        return answer
      },
    })

    const declined = await call(["messages", "delete", "Book", "3"], async () => adapter, env, answering("n"))
    const agreed = await call(["messages", "delete", "Book", "4"], async () => adapter, env, answering("y"))
    const unattended = await call(["messages", "delete", "Book", "5"], async () => adapter, env, answering(null))
    config({ reactions: "ask", "messages.delete": "allow" })
    const reacted = await call(
      ["reactions", "add", "Book", "6", "👍", "--yes"],
      async () => adapter,
      env,
      answering(null),
    )
    const allowed = await call(["messages", "delete", "Book", "7"], async () => adapter, env, answering(null))
    config({ messages: "readonly" })
    const readonly = await call(["messages", "delete", "Book", "8", "--allow-dangerous"], async () => adapter, env)

    expect(declined.code).toBe(130)
    expect(unattended.code).toBe(7)
    expect(unattended.stderr.join("\n")).toContain("--allow-dangerous")
    expect(questions).toEqual([
      "messages.delete, 1 item, in chat 7 — go ahead? [y/N] ",
      "messages.delete, 1 item, in chat 7 — go ahead? [y/N] ",
      "messages.delete, 1 item, in chat 7 — go ahead? [y/N] ",
    ])
    expect([agreed.code, reacted.code, allowed.code]).toEqual([0, 0, 0])
    expect(deletions).toEqual([
      ["7", ["4"]],
      ["7", ["7"]],
    ])
    expect(reactions).toHaveLength(1)
    expect(readonly.code).toBe(5)
    expect(readonly.stderr.join("\n")).toContain("permissions.messages is readonly")
  })

  it("**refuses a denied read before connecting**, and leaves the rest readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "deny" } } } }),
    )
    let connected = 0
    const counting = async () => {
      connected += 1
      return fake
    }

    const listed = await call(["messages", "list", "Book"], counting, env)
    const exported = await call(["store", "export", "Book"], counting, env)
    const linked = await call(["messages", "link", "7", "1"], counting, env)
    const chats = await call(["chats", "list", "--json"], counting, env)

    expect([listed.code, exported.code, linked.code]).toEqual([5, 5, 5])
    expect(listed.stderr.join("\n")).toContain("permissions.messages is deny")
    expect(chats.code).toBe(0)
    expect(connected).toBe(1)
  })

  it("**show a poll with its answer ids, vote by id and take it back**, close it as an edit, create one as a message", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const poll = {
      chatId: "7",
      messageId: "3",
      question: "Friday?",
      answers: [
        { id: "MA", text: "yes", voters: null, chosen: false },
        { id: "MQ", text: "no", voters: null, chosen: false },
      ],
      closed: false,
      multiple: false,
      anonymous: false,
      voters: null,
    }
    const calls: unknown[] = []
    const polling: MessengerAdapter = {
      ...fake,
      poll: async () => poll,
      vote: async (chatId, messageId, ids) => {
        calls.push(["vote", chatId, messageId, ids])
        return poll
      },
      closePoll: async (chatId, messageId) => {
        calls.push(["close", chatId, messageId])
        return { ...poll, closed: true }
      },
      createPoll: async (chatId, created, { sendId }) => {
        calls.push(["create", chatId, created, sendId])
        return { message: { ...message, id: "9" }, sendId }
      },
    }

    const shown = await call(["polls", "show", "Book", "3", "--json"], async () => polling, env)
    const none = await call(["polls", "vote", "Book", "3"], async () => polling, env)
    const voted = await call(["polls", "vote", "Book", "3", "MQ", "--json"], async () => polling, env)
    await call(["polls", "vote", "Book", "3", "--retract"], async () => polling, env)
    const closed = await call(["polls", "close", "Book", "3", "--json"], async () => polling, env)
    const created = await call(
      [
        "polls",
        "create",
        "Book",
        "Where?",
        "here",
        "there",
        "--multiple",
        "--revote",
        "--operation-id",
        "42",
        "--json",
      ],
      async () => polling,
      env,
    )

    expect(v.safeParse(ENTITIES.poll, JSON.parse(shown.stdout[0] ?? "").item).success).toBe(true)
    for (const result of [voted, closed]) {
      expect(v.safeParse(ENTITIES.poll_change, JSON.parse(result.stdout[0] ?? "").item).success).toBe(true)
    }
    expect(v.safeParse(ENTITIES.message_write, JSON.parse(created.stdout[0] ?? "").item).success).toBe(true)
    const projected = await call(["polls", "show", "Book", "3", "--json=question"], async () => polling, env)
    expect(JSON.parse(projected.stdout[0] ?? "").item).toEqual({ question: "Friday?" })
    expect(JSON.parse(shown.stdout[0] ?? "").item.answers.map((one: { id: string }) => one.id)).toEqual(["MA", "MQ"])
    expect(none.stderr.join("\n")).toContain("polls show")
    expect(JSON.parse(closed.stdout[0] ?? "").item.poll.closed).toBe(true)
    expect(JSON.parse(created.stdout[0] ?? "").item).toMatchObject({
      operation_id: "42",
      message: { id: "9" },
    })
    expect(calls).toEqual([
      ["vote", "7", "3", ["MQ"]],
      ["vote", "7", "3", []],
      ["close", "7", "3"],
      [
        "create",
        "7",
        { question: "Where?", answers: ["here", "there"], multiple: true, anonymous: false, revote: true },
        "42",
      ],
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries().filter((one) => one.outcome === "sent")
    expect(journal.map((one) => [one.kind, one.messageId])).toEqual([
      ["reaction", "3"],
      ["reaction", "3"],
      ["edit", "3"],
      ["message", "9"],
    ])
  })

  it("**presses a bot's callback button by number or text**, refuses the ones that hand over data, and journals it", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const pressed: unknown[] = []
    const keyboard: MessengerAdapter = {
      ...fake,
      buttons: async () => [
        [
          { kind: "callback", text: "Yes" },
          { kind: "callback", text: "No" },
        ],
        [
          { kind: "contact", text: "Share phone" },
          { kind: "link", text: "Site", url: "https://example.org" },
        ],
      ],
      pressButton: async (chatId, messageId, row, column) => {
        pressed.push([chatId, messageId, row, column])
      },
    }

    const bots = { personalBots: true }
    const hidden = await call(["messages", "press", "Book", "3", "1"], async () => keyboard, env)
    const byNumber = await call(["messages", "press", "Book", "3", "2", "--json"], async () => keyboard, env, {}, bots)
    const byText = await call(["messages", "press", "Book", "3", "Yes", "--json"], async () => keyboard, env, {}, bots)
    const phone = await call(["messages", "press", "Book", "3", "3"], async () => keyboard, env, {}, bots)
    const link = await call(["messages", "press", "Book", "3", "Site"], async () => keyboard, env, {}, bots)
    const missing = await call(["messages", "press", "Book", "3", "9"], async () => keyboard, env, {}, bots)
    const unsupported = await call(["messages", "press", "Book", "3", "1"], async () => fake, env, {}, bots)

    expect(JSON.parse(byNumber.stdout[0] ?? "").item).toMatchObject({
      chat_id: "7",
      message_id: "3",
      button: { kind: "callback", text: "No" },
    })
    expect(byText.code).toBe(0)
    expect(pressed).toEqual([
      ["7", "3", 0, 1],
      ["7", "3", 0, 0],
    ])
    expect(phone.stderr.join("\n")).toContain("hand your phone number to the bot")
    expect(link.stderr.join("\n")).toContain("only opens its link")
    expect(missing.stderr.join("\n")).toContain("there are 4 buttons")
    expect(unsupported.code).not.toBe(0)
    expect(hidden.stderr.join("\n")).toContain("unknown command")
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries().filter((one) => one.outcome === "sent")
    expect(journal.map((one) => [one.kind, one.messageId])).toEqual([
      ["reaction", "3"],
      ["reaction", "3"],
    ])
  })

  it("**starts a bot like a message, and prints its mini app's address** only where the messenger has bots", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const calls: unknown[] = []
    const bot: MessengerAdapter = {
      ...fake,
      startBot: async (chatId, options) => {
        calls.push(["start", chatId, options])
      },
      botApp: async (chatId, options) => {
        calls.push(["app", chatId, options])
        return { url: "https://app.example/#signed" }
      },
    }
    const bots = { personalBots: true }

    const started = await call(["chats", "start", "Book", "--start", "ref1", "--json"], async () => bot, env, {}, bots)
    const opened = await call(["chats", "app", "Book", "--start", "p", "--json"], async () => bot, env, {}, bots)
    const hidden = await call(["chats", "start", "Book"], async () => bot, env)

    expect(JSON.parse(started.stdout[0] ?? "").item).toMatchObject({ chat_id: "7", started: true })
    expect(JSON.parse(opened.stdout[0] ?? "").item).toMatchObject({ chat_id: "7", url: "https://app.example/#signed" })
    expect(calls).toEqual([
      ["start", "7", { sendId: expect.any(String), payload: "ref1" }],
      ["app", "7", { startParam: "p" }],
    ])
    expect(hidden.code).not.toBe(0)
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries().filter((one) => one.outcome === "sent")
    expect(journal.map((one) => one.kind)).toEqual(["message", "reaction"])
    expect(JSON.stringify(journal)).not.toContain("signed")
  })

  it("**starts a bot by its link**, taking the link's start parameter unless --start is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const starts: unknown[] = []
    const bot: MessengerAdapter = {
      ...fake,
      botByLink: async (reference) =>
        reference.startsWith("https://") ? { chatId: "42", payload: "from-link" } : undefined,
      startBot: async (chatId, options) => {
        starts.push([chatId, options.payload])
      },
    }
    const bots = { personalBots: true }

    await call(["chats", "start", "https://bot.example/b?start=from-link"], async () => bot, env, {}, bots)
    await call(["chats", "start", "https://bot.example/b", "--start", "typed"], async () => bot, env, {}, bots)
    await call(["chats", "start", "Book"], async () => bot, env, {}, bots)

    expect(starts).toEqual([
      ["42", "from-link"],
      ["42", "typed"],
      ["7", undefined],
    ])
  })

  it("**lists who voted for what**, after reading the poll, and refuses an anonymous one or an unknown answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const poll = {
      chatId: "7",
      messageId: "3",
      question: "Friday?",
      answers: [
        { id: "MA", text: "yes", voters: 1, chosen: false },
        { id: "MQ", text: "no", voters: 0, chosen: false },
      ],
      closed: false,
      multiple: false,
      anonymous: false,
      voters: 1,
    }
    const vote = {
      person: { id: "91", name: "Ana", username: null },
      answers: ["MA"],
      votedAt: "2026-10-08T09:00:00.000Z",
    }
    const asked: unknown[] = []
    let anonymous = false
    const polling: MessengerAdapter = {
      ...fake,
      poll: async () => ({ ...poll, anonymous }),
      pollVoters: async (_chatId, _messageId, window) => {
        asked.push(window)
        return { items: [vote], hasMore: false, total: 1 }
      },
    }
    const voters = (...extra: string[]) =>
      call(["polls", "voters", "Book", "3", ...extra], async () => polling, env, {}, { pollVoters: true })

    const listed = await voters("answers:MA", "--limit", "5", "--json")
    const unknown = await voters("answers:ZZ")
    anonymous = true
    const hidden = await voters()
    const unlisted = await call(["polls", "voters", "Book", "3"], async () => polling, env)

    expect(JSON.parse(listed.stdout[0] ?? "").items).toEqual([
      { person_id: "91", name: "Ana", username: null, answers: ["MA"], voted_at: vote.votedAt },
    ])
    expect(asked).toEqual([{ limit: 5, answerId: "MA" }])
    expect([unknown.code, hidden.code]).toEqual([2, 2])
    expect(hidden.stderr.join("\n")).toContain("anonymous")
    expect(unlisted.code).not.toBe(0)
  })

  it("**closes a poll by itself after a delay** inside the messenger's range, refused outside it or where it cannot", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const created: unknown[] = []
    const polling: MessengerAdapter = {
      ...fake,
      createPoll: async (_chatId, poll, { sendId }) => {
        created.push(poll)
        return { message: { ...message, id: "9" }, sendId }
      },
    }
    const create = (...extra: string[]) =>
      call(
        ["polls", "create", "Book", "Now?", "yes", "no", ...extra],
        async () => polling,
        env,
        {},
        {
          pollCloseSeconds: [5, 600],
        },
      )

    const seconds = await create("--close-time", "90s", "--json")
    const minutes = await create("--close-time", "10m", "--json")
    const tooLong = await create("--close-time", "11m")
    const tooShort = await create("--close-time", "4s")
    const clock = await create("--close-time", "2026-10-09T09:00")
    const unlisted = await call(
      ["polls", "create", "Book", "Now?", "yes", "no", "--close-time", "5m"],
      async () => polling,
      env,
    )

    expect([seconds.code, minutes.code]).toEqual([0, 0])
    expect(created).toEqual([expect.objectContaining({ closeAfter: 90 }), expect.objectContaining({ closeAfter: 600 })])
    expect([tooLong.code, tooShort.code, clock.code]).toEqual([2, 2, 2])
    expect(tooLong.stderr.join("\n")).toContain("5s to 10m")
    expect(unlisted.code).not.toBe(0)
  })

  it("**a messenger whose polls stay open, public, loud and the account's own** offers none of the flags it refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const created: unknown[] = []
    const polling: MessengerAdapter = {
      ...fake,
      createPoll: async (_chatId, poll, { sendId }) => {
        created.push(poll)
        return { message: { ...message, id: "9" }, sendId }
      },
    }
    const open = { pollClose: false, pollRevote: false, pollAnonymous: false, silentSends: false, sendAs: false }

    const close = await call(["polls", "close", "Book", "9"], async () => polling, env, {}, open)
    const revote = await call(
      ["polls", "create", "Book", "When?", "Tue", "Fri", "--revote"],
      async () => polling,
      env,
      {},
      open,
    )
    const made = await call(["polls", "create", "Book", "When?", "Tue", "Fri"], async () => polling, env, {}, open)
    const help = await call(["polls", "--help"], async () => polling, env, {}, open)
    const refused = []
    for (const flag of [["--anonymous"], ["--silent"], ["--send-as", "500"]])
      refused.push(
        await call(["polls", "create", "Book", "When?", "Tue", "Fri", ...flag], async () => polling, env, {}, open),
      )
    const createHelp = (await call(["polls", "create", "--help"], async () => polling, env, {}, open)).stdout.join("\n")

    expect([close.code, revote.code, made.code]).toEqual([2, 2, 0])
    expect(refused.map((one) => one.code)).toEqual([2, 2, 2])
    expect(help.stdout.join("\n")).not.toContain("close")
    expect(help.stdout.join("\n")).not.toContain("anonymous")
    expect(createHelp).not.toMatch(/--anonymous|--silent|--send-as/)
    expect(createHelp).toContain("everyone sees who voted for what")
    expect(created).toEqual([expect.objectContaining({ revote: false })])
  })

  it("**messages send and forward offer no --silent, --send-as or --at-time** where the messenger refuses them", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const plain = { silentSends: false, sendAs: false, scheduledSends: false }
    const help = async (argv: string[]) =>
      (await call([...argv, "--help"], async () => fake, env, {}, plain)).stdout.join("\n")

    const send = await help(["messages", "send"])
    const forward = await help(["messages", "forward"])
    const refused = await call(["messages", "send", "Book", "hi", "--silent"], async () => fake, env, {}, plain)

    expect(send).not.toMatch(/--silent|--send-as|--at-time/)
    expect(forward).not.toMatch(/--silent|--send-as/)
    expect(send).toContain("--reply-to")
    expect(refused.code).toBe(2)
    expect(await help(["messages"])).not.toMatch(/^\s+scheduled/m)
    expect(await help(["chats"])).not.toMatch(/^\s+send-as/m)
  })

  it("**creates a quiz where the messenger makes them**, and refuses quiz options that do not go together", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const created: unknown[] = []
    const quizzing: MessengerAdapter = {
      ...fake,
      createPoll: async (_chatId, poll, { sendId }) => {
        created.push(poll)
        return { message: { ...message, id: "9" }, sendId }
      },
    }
    const quiz = { pollQuiz: true }
    const create = (...extra: string[]) =>
      call(["polls", "create", "Book", "2+2?", "3", "4", "5", ...extra], async () => quizzing, env, {}, quiz)

    const made = await create("--quiz", "--correct", "2", "--solution", "it is 4", "--json")
    const outOfRange = await create("--quiz", "--correct", "4")
    const noCorrect = await create("--quiz")
    const stray = await create("--correct", "2")
    const final = await create("--quiz", "--correct", "2", "--revote")
    const elsewhere = await call(
      ["polls", "create", "Book", "2+2?", "3", "4", "--quiz", "--correct", "2"],
      async () => quizzing,
      env,
    )

    expect(made.code).toBe(0)
    expect(created).toEqual([
      {
        question: "2+2?",
        answers: ["3", "4", "5"],
        multiple: false,
        anonymous: false,
        revote: false,
        quiz: { correct: 1, solution: "it is 4" },
      },
    ])
    expect(outOfRange.stderr.join("\n")).toContain("1 to 3")
    expect(noCorrect.stderr.join("\n")).toContain("needs --correct")
    expect(stray.stderr.join("\n")).toContain("go with --quiz")
    expect(final.stderr.join("\n")).toContain("one final answer")
    expect(elsewhere.stderr.join("\n")).toContain("unknown option '--quiz'")
  })

  it("describe themselves for an agent, with the contract version and which ones write", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const { stdout } = await call(["commands", "--json"], async () => fake, {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: root,
    })
    const described = JSON.parse(stdout[0] ?? "")
    const flat = (list: CommandInfo[]): CommandInfo[] => list.flatMap((one) => [one, ...flat([...one.commands])])
    const find = (path: string[]) => flat(described.commands).find((one) => one.path.join(" ") === path.join(" "))

    expect(described).toMatchObject({ cli: "chat", contract: 3 })
    expect(find(["messages", "send"])?.effects?.remote).toBe("write")
    expect(find(["messages", "edit"])?.effects?.remote).toBe("write")
    expect(find(["messages", "forward"])?.effects?.remote).toBe("write")
    expect(find(["messages", "pin"])?.effects?.remote).toBe("write")
    expect(find(["messages", "unpin"])?.effects?.remote).toBe("write")
    expect(find(["reactions", "add"])?.effects?.remote).toBe("write")
    expect(find(["messages", "delete"])?.effects?.remote).toBe("write")
    expect(find(["polls", "vote"])?.effects?.remote).toBe("write")
    expect(find(["polls", "show"])?.effects?.remote).toBe("read")
    expect(find(["recipients", "add"])?.effects).toEqual({ remote: "read", local: "write" })
    expect(find(["messages", "list"])?.effects?.remote).toBe("read")
  })

  it("**complete a chat from the store** — its id as the word, its title as the description", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["chats", "list"], async () => fake, env)

    const { stdout } = await call(["complete", "--", "chats", "show", ""], async () => fake, env)

    expect(stdout.join("\n")).toContain("7\tBook club")
  })

  it("never creates the store on a Tab", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }

    const { code } = await call(["complete", "--", "chats", "show", ""], async () => fake, env)

    expect(code).toBe(0)
    expect(existsSync(join(root, "m.db"))).toBe(false)
  })

  it("**sync-first refresh failures** keep a single JSON value and close the connection without mark-read", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const close = vi.fn(async () => {})
    const markRead = vi.fn(async () => {})
    const broken = {
      ...fake,
      close,
      markRead,
      history: async () => {
        throw new Error("private detail")
      },
    }
    for (const path of [
      ["search", "messages", "chapter", "chat:7"],
      ["stats", "messages", "show", "chapter", "--chat", "7"],
      ["search", "conversations", "chapter", "--chat", "7"],
    ]) {
      const result = await call(
        [...path, "--sync-first", "--sync-time", "1s", "--max-messages", "10", "--json"],
        async () => broken,
        env,
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toHaveLength(1)
      expect(JSON.parse(result.stdout[0] ?? "")).toMatchObject(
        path[0] === "search" && path[1] === "messages"
          ? {
              missing: [{ field: "coverage", step: "messages.sync" }],
              next: [{ step: "messages.sync", args: { chat: "7" } }],
            }
          : path[0] === "stats"
            ? { missing: [{ field: "coverage", step: "messages.sync" }] }
            : {
                missing: expect.arrayContaining([
                  expect.objectContaining({ field: "coverage", step: "messages.sync" }),
                ]),
              },
      )
      expect(result.stderr.join("\n")).toContain("refresh incomplete")
      expect(result.stderr.join("\n")).not.toContain("private detail")
    }
    expect(close).toHaveBeenCalledTimes(3)
    expect(markRead).not.toHaveBeenCalled()
  })

  it("**sync-first permission** denies network before connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "readonly" } } } }),
    )
    const never = vi.fn(async () => fake)
    const result = await call(["search", "messages", "chapter", "--sync-first", "--json"], never, env)
    expect(result.code).toBe(5)
    expect(never).not.toHaveBeenCalled()
  })

  it("**--backend both** adds the server's hits with their source, and is offered only where the server searches", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const searchMessages = vi.fn(async () => ({
      items: [{ ...message, id: "40", text: "chapter four", chatTitle: "Book club" }],
      hasMore: false,
      chats: [],
    }))
    const result = await call(
      ["search", "messages", "chapter", "--backend", "both", "--server-time", "2s", "--json"],
      async () => ({ ...fake, searchMessages }),
      env,
      {},
      { serverSearch: true },
    )
    expect(result.code).toBe(0)
    const answer = JSON.parse(result.stdout[0] ?? "")
    expect(answer.items.find(({ ref }: { ref: string }) => ref.endsWith("/40"))).toMatchObject({ found_in: "server" })
    expect(searchMessages).toHaveBeenCalledWith({ text: "chapter" }, expect.objectContaining({ limit: 100 }))
    const without = await call(["search", "messages", "chapter", "--backend", "both"], async () => fake, env)
    expect(without.code).not.toBe(0)
    expect(without.stderr.join("\n")).toContain("--backend")
  })

  it("**an empty search that asked the server** says both were searched", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const searchMessages = vi.fn(async () => ({ items: [], hasMore: false, chats: [] }))
    const answer = await call(
      ["search", "messages", "zqxwnothing"],
      async () => ({ ...fake, searchMessages }),
      env,
      { tty: true },
      { serverSearch: true },
    )
    expect(answer.stderr.join("\n")).toContain("nothing found in the local store or on the messenger's server")
  })

  it("**--backend both** on a read-only profile answers from the archive and never asks the server", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "readonly" } } } }),
    )
    const searchMessages = vi.fn()
    const connection = { ...fake, searchMessages }
    const both = await call(
      ["search", "messages", "chapter", "--backend", "both", "--json"],
      async () => connection,
      env,
      {},
      { serverSearch: true },
    )
    expect(both.code).toBe(0)
    expect(
      JSON.parse(both.stdout[0] ?? "").items.every(({ found_in }: { found_in?: string }) => found_in !== "server"),
    ).toBe(true)
    expect(both.stderr.join("\n")).toContain("server search skipped: not_allowed")
    const server = await call(
      ["search", "messages", "chapter", "--backend", "server", "--json"],
      async () => connection,
      env,
      {},
      { serverSearch: true },
    )
    expect(server.code).toBe(5)
    expect(searchMessages).not.toHaveBeenCalled()
  })

  it("**thread context** follows stored replies by locator and keeps JSON/JSONL data pure", async () => {
    const root = mkdtempSync(join(tmpdir(), "thread-cli-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const records = thread.map((item, i) => ({
      ...item,
      senderId: String(10 + i),
      ...(i ? { replyToId: String(i) } : {}),
    }))
    const backend = { ...fake, history: async () => ({ items: records, hasMore: false }) }
    await call(["messages", "list", "7", "--json"], async () => backend, env)
    await call(["conversations", "links", "rebuild", "--chat", "7", "--json"], async () => backend, env)
    const never = vi.fn(async () => {
      throw new Error("thread must stay local")
    })
    const context = await call(["messages", "context", "msg:chat/500/7/3", "--thread", "--json"], never, env)
    expect(context.code, context.stderr.join(" ")).toBe(0)
    expect(v.parse(ENTITIES.message_context, JSON.parse(context.stdout[0] ?? "null").item)).toBeDefined()
    const threadProjection = await call(
      ["messages", "context", "msg:chat/500/7/3", "--thread", "--json=items.ref"],
      never,
      env,
    )
    expect(threadProjection.code, threadProjection.stderr.join(" ")).toBe(0)
    expect(JSON.parse(threadProjection.stdout[0] ?? "null").item.items[0]).toHaveProperty("ref")
    const windowProjection = await call(
      ["messages", "context", "msg:chat/500/7/3", "--json=items.ref"],
      async () => backend,
      env,
    )
    expect(windowProjection.code, windowProjection.stderr.join(" ")).toBe(0)
    expect(JSON.parse(windowProjection.stdout[0] ?? "null").items[0]).toHaveProperty("ref")
    expect(context.code).toBe(0)
    expect(context.stdout).toHaveLength(1)
    const found = JSON.parse(context.stdout[0] ?? "").item
    expect(found).toMatchObject({ mode: "thread", chain: ["2", "1"], stale: false, stopped: [] })
    expect(found.items.map((item: { id: string }) => item.id)).toEqual(["1", "2", "3"])
    const search = await call(["search", "messages", "chapter", "--thread", "--json"], never, env)
    const hit = JSON.parse(search.stdout[0] ?? "").items.find((one: { ref: string }) => one.ref === "msg:chat/500/7/3")
    expect(hit.context.map(({ ref }: { ref: string }) => ref)).toEqual(
      found.items.map(({ id }: { id: string }) => `msg:chat/500/7/${id}`),
    )
    const capped = await call(
      ["messages", "context", "7", "3", "--thread", "--thread-hops", "0", "--jsonl"],
      never,
      env,
    )
    expect(capped.code).toBe(0)
    expect(jsonlData(capped.stdout)).toMatchObject([{ items: [{ id: "3" }], stopped: ["hops"] }])
    expect(capped.stderr.join("\n")).toContain("thread context stopped")
    const pretty = await call(["messages", "context", "7", "3", "--thread"], never, env, { tty: true })
    expect(pretty.stdout.join("\n")).toContain("provider/reply")
    const wrong = await call(["messages", "context", "msg:chat/600/7/3", "--thread", "--json"], never, env)
    expect(wrong.code).toBe(2)
    expect(never).not.toHaveBeenCalled()
  })

  it("**thread time fallback** names the missing graph on stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "thread-cli-"))
    const env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = vi.fn(async () => {
      throw new Error("never connects")
    })
    const found = await call(
      [
        "messages",
        "context",
        "7",
        "2",
        "--thread",
        "--thread-messages",
        "1",
        "--thread-within",
        "1d",
        "--thread-bytes",
        "65536",
        "--json",
      ],
      never,
      env,
    )
    expect(found.code).toBe(0)
    expect(found.stdout).toHaveLength(1)
    expect(JSON.parse(found.stdout[0] ?? "").item).toMatchObject({
      mode: "time",
      fallback: "not_built",
      items: [{ id: "2" }],
      stopped: ["messages"],
    })
    expect(found.stderr.join("\n")).toContain("thread context uses time neighbours: not_built")
    const invalid = await call(
      ["messages", "context", "7", "2", "--thread", "--thread-hops", "bad", "--json"],
      never,
      env,
    )
    expect(invalid.code).toBe(2)
    expect(never).not.toHaveBeenCalled()
  })

  it("**search the store without connecting**, and name each hit by its locator", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    }

    const found = await call(["search", "messages", "chapter", "--json"], never, env)
    const hits = JSON.parse(found.stdout[0] ?? "").items
    expect(found.code).toBe(0)
    expect(hits.map((hit: { ref: string }) => hit.ref)).toEqual([
      "msg:chat/500/7/3",
      "msg:chat/500/7/2",
      "msg:chat/500/7/1",
    ])
    const elsewhere = await call(["search", "messages", "chapter", "chat:999", "--json"], never, env)
    expect(JSON.parse(elsewhere.stdout[0] ?? "").items).toEqual([])
    const pattern = await call(["search", "messages", "body:/.*ch.pt.*/", "--limit", "1", "--json"], never, env)
    expect(JSON.parse(pattern.stdout[0] ?? "")).toMatchObject({ items: [{}], page: { limit: 1, has_more: true } })
    expect((await call(["search", "messages", "--regex", "ch.pt", "--json"], never, env)).code).toBe(2)
  })

  it("**search mail is not a command here**, and search messages never returns mail", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-search-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const email = { provider: "email", account: "owner@example.test" }
    for (const id of ["9001", "9002"]) {
      await store.chats.saveChats(email, [{ ...chat, id, title: "Synthetic mail" }])
      await store.messages.saveMessages(
        email,
        id,
        [{ ...thread[0], id, chatId: id, text: "chapter in mail" } as Message],
        {
          via: "himalaya",
        },
      )
    }
    await store.searchIndex.fillSearchIndex()
    await store.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const mail = await call(["search", "mail", "chapter", "--json"], never, env)
    expect(mail.code).toBe(2)
    expect(mail.stderr.join("\n")).toContain("unknown command")
    expect(mail.stderr.join("\n")).not.toContain("memo")

    const args = ["search", "messages", "chapter", "--json"]
    const all = await call([...args, "--source", "all"], never, env)
    expect(all.code).toBe(0)
    const items = JSON.parse(all.stdout[0] ?? "").items as { ref: string }[]
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(({ ref }) => ref.startsWith("msg:email/"))).toBe(false)
    expect(all.stderr.join("\n")).not.toContain("mail search")
    const asked = await call([...args, "--source", "email"], never, env)
    expect(asked.code).toBe(2)
    expect(asked.stderr.join("\n")).toContain("memo search mail")
    expect(never).not.toHaveBeenCalled()
  })

  it("**search all** finds messages in a store of two accounts with no notes or mail", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-only-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const other = { provider: "chat", account: "999" }
    await store.chats.saveChats(other, [{ ...chat, id: "70", title: "Other" }])
    await store.messages.saveMessages(
      other,
      "70",
      [{ ...thread[0], id: "70", chatId: "70", text: "nothing here" } as Message],
      {
        via: "test",
      },
    )
    await store.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })

    const messages = JSON.parse((await call(["search", "messages", "chapter", "--json"], never, env)).stdout[0] ?? "")
    const all = await call(["search", "all", "chapter", "--json"], never, env)
    expect(all.code).toBe(0)
    const answer = JSON.parse(all.stdout[0] ?? "")
    expect(answer.meta.accounts).toContain("chat:500")
    expect(answer.items.filter(({ kind }: { kind: string }) => kind === "message")).toHaveLength(messages.items.length)
  })

  it("**search all** leaves the mail in the store out: mail is memo's", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-mail-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const accountId = await store.accounts.saveAccount(
      { provider: "email", account: "owner@example.test" },
      { name: null },
    )
    const sent = (externalId: string, day: number, bodyText: string) => ({
      externalId,
      subject: "Reading group",
      from: { address: "alice@example.test", name: "Alice Example" },
      sentAt: Date.UTC(2026, 0, day),
      receivedAt: Date.UTC(2026, 0, day),
      bodyText,
    })
    await store.mail.saveThread({
      accountId,
      externalId: "thread-7",
      now: Date.UTC(2026, 0, 9),
      emails: [sent("<a@example.test>", 1, "Which chapter next?"), sent("<b@example.test>", 2, "The third one.")],
    })
    await store.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })

    const all = JSON.parse((await call(["search", "all", "chapter", "--json"], never, env)).stdout[0] ?? "")
    expect(all.items.some(({ kind }: { kind: string }) => kind === "mail")).toBe(false)
    expect(all.meta.accounts).not.toContain("email:owner@example.test")
    const only = await call(["search", "all", "chapter", "--only", "mail", "--json"], never, env)
    expect(only.code).toBe(2)
    expect(only.stderr.join("\n")).toContain("memo search mail")
  })

  it("**messages show** and **messages context** open an email by its locator, whole, with its thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-show-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const accountId = await store.accounts.saveAccount(
      { provider: "email", account: "owner@example.test" },
      { name: null },
    )
    const body = `${"A long note about the reading group. ".repeat(20)}End.`
    const sent = (externalId: string, day: number, bodyText: string) => ({
      externalId,
      subject: "Reading group",
      from: { address: "alice@example.test", name: "Alice Example" },
      to: [{ address: "owner@example.test", name: null }],
      sentAt: Date.UTC(2026, 0, day),
      receivedAt: Date.UTC(2026, 0, day),
      bodyText,
    })
    await store.mail.saveThread({
      accountId,
      externalId: "thread-9",
      now: Date.UTC(2026, 0, 9),
      emails: [sent("<a@example.test>", 1, body), sent("<b@example.test>", 2, "The third one.")],
    })
    await store.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("reading mail must never connect")
    })
    const locator = "msg:email/owner%40example.test/thread-9/%3Ca%40example.test%3E"

    const shown = await call(["messages", "show", locator, "--json"], never, env)
    expect(shown.code).toBe(0)
    const email = JSON.parse(shown.stdout[0] ?? "").item
    expect(email).toMatchObject({ id: "<a@example.test>", ref: locator, provider: "email", anchor: true })
    expect(email.text).toContain(body)
    expect(email.email.from).toMatchObject({ address: "alice@example.test", ref: expect.stringMatching(/^person:/) })

    const around = await call(["messages", "context", locator, "--after-n", "1", "--json"], never, env)
    expect(JSON.parse(around.stdout[0] ?? "").items.map(({ id }: { id: string }) => id)).toEqual([
      "<a@example.test>",
      "<b@example.test>",
    ])
    const missing = await call(["messages", "show", locator.replace("%3Ca", "%3Cz"), "--json"], never, env)
    expect(missing.code).not.toBe(0)
    expect(missing.stderr.join("\n")).toContain("no stored email")
  })

  it("**search all** pages with --page and says where the next page starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-offset-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    for (const day of [1, 2, 3]) await store.notes.addNote({ text: "Lighthouse notes", title: `Lighthouse ${day}` })
    await store.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const page = async (...args: string[]) =>
      JSON.parse((await call([...args, "--limit", "1", "--json"], never, env)).stdout[0] ?? "")

    const second = await page("search", "all", "lighthouse", "--only", "notes", "--page", "2", "--exact")
    const pageStep = (answer: { next?: { step: string; args: object }[] }) =>
      answer.next?.find(({ step }) => step === "page.next")
    expect(second.page).toMatchObject({ has_more: true })
    expect(pageStep(second)).toMatchObject({
      command: "search all",
      args: { query: "lighthouse", only: "notes", page: 3 },
    })
    expect(second.items).toHaveLength(1)
    const last = await page("search", "all", "lighthouse", "--only", "notes", "--page", "3", "--exact")
    expect(pageStep(last)).toBeUndefined()
  })

  it("**search all** finds a message and a note with one query, each typed, never the mail, and says what it skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const email = { provider: "email", account: "owner@example.test" }
    await store.chats.saveChats(email, [{ ...chat, id: "9001", title: "Synthetic mail" }])
    await store.messages.saveMessages(
      email,
      "9001",
      [{ ...thread[0], id: "9001", chatId: "9001", text: "chapter in mail" } as Message],
      {
        via: "himalaya",
      },
    )
    await store.notes.addNote({ title: "Reading list", text: "the chapter to read next" })
    await store.searchIndex.fillSearchIndex()
    await store.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })

    const all = await call(["search", "all", "chapter", "--json"], never, env)
    expect(all.code).toBe(0)
    const answer = JSON.parse(all.stdout[0] ?? "")
    expect(new Set(answer.items.map(({ kind }: { kind: string }) => kind))).toEqual(new Set(["message", "note"]))
    expect(answer.items.find(({ kind }: { kind: string }) => kind === "note").ref).toMatch(/^note:/)
    expect(answer.meta.accounts).toEqual(expect.arrayContaining(["chat:500", "notes:internal"]))
    expect(answer.meta.accounts).not.toContain("email:owner@example.test")
    expect(answer.items.find(({ kind }: { kind: string }) => kind === "note").found_by).toEqual(["words"])

    const notesOnly = JSON.parse(
      (await call(["search", "all", "chapter", "--only", "notes", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(notesOnly.items.map(({ kind }: { kind: string }) => kind)).toEqual(["note"])

    const fromField = JSON.parse(
      (await call(["search", "all", "from:me AND chapter", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(fromField.meta.issues.map(({ source }: { source: string }) => source)).toContain("notes")

    const notes = JSON.parse(
      (await call(["search", "notes", "chapter source:internal", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(notes.items).toHaveLength(1)
    expect(notes.items[0].found_by).toEqual(["words"])
    const files = JSON.parse(
      (await call(["search", "notes", "chapter AND source:file", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(files.items).toHaveLength(0)
    const written = JSON.parse(
      (await call(["search", "notes", "chapter", "--source", "notes:internal,email", "--json"], never, env))
        .stdout[0] ?? "",
    )
    expect(written.items).toHaveLength(1)
    expect(written.meta.accounts).toEqual(["notes:internal"])
    expect(written.meta.issues).toEqual([{ code: "validation_error", source: "email" }])
    expect(never).not.toHaveBeenCalled()
  })

  it("**search all --backend** asks the server for messages only: archive never connects, server keeps its hits", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-backend-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.notes.addNote({ title: "Reading list", text: "the chapter to read next" })
    const other = { provider: "chat", account: "999" }
    await store.chats.saveChats(other, [{ ...chat, id: "7", title: "Other" }])
    await store.messages.saveMessages(other, "7", [{ ...message, id: "40", text: "chapter forty elsewhere" }], {
      via: "test",
    })
    await store.searchIndex.fillSearchIndex()
    await store.close()
    const searchMessages = vi.fn(async () => ({
      items: [{ ...message, id: "40", text: "chapter four", chatTitle: "Book club" }],
      hasMore: false,
      chats: [],
    }))
    const server = vi.fn(async () => ({ ...fake, searchMessages }))
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("--backend archive must never connect")
    })
    const search = async (connect: Messenger["connect"], ...extra: string[]) => {
      const result = await call(
        ["search", "all", "chapter", ...extra, "--json"],
        connect,
        env,
        {},
        { serverSearch: true },
      )
      expect(result.code).toBe(0)
      return JSON.parse(result.stdout[0] ?? "")
    }
    const messageIds = (answer: { items: { kind: string; ref: string; account: string }[] }) =>
      answer.items
        .filter(({ kind, account }) => kind === "message" && account !== "999")
        .map(({ ref }) => ref.split("/").at(-1))

    const archive = await search(never, "--backend", "archive")
    expect(never).not.toHaveBeenCalled()
    expect(messageIds(archive)).not.toContain("40")
    expect(archive.items.map(({ kind }: { kind: string }) => kind)).toContain("note")

    const onlyServer = await search(server, "--backend", "server", "--server-time", "2s")
    expect(searchMessages).toHaveBeenCalledTimes(1)
    expect(messageIds(onlyServer)).toEqual(["40"])
    expect(onlyServer.items.filter(({ kind }: { kind: string }) => kind === "message")).toHaveLength(1)
    expect(onlyServer.items.map(({ kind }: { kind: string }) => kind)).toContain("note")

    const both = await search(server, "--backend", "both")
    expect(messageIds(both)).toContain("40")
    expect(messageIds(both).length).toBeGreaterThan(1)

    searchMessages.mockClear()
    const unasked = await search(server)
    expect(searchMessages).toHaveBeenCalledTimes(1)
    expect(messageIds(unasked)).toContain("40")

    const offline = await search(never, "--backend", "server", "--offline")
    expect(offline.meta.issues).toContainEqual({ code: "validation_error", source: "messages" })
    expect(never).not.toHaveBeenCalled()

    const plain = await call(["search", "all", "chapter", "--backend", "archive"], never, env)
    expect(plain.code).not.toBe(0)
    expect(plain.stderr.join("\n")).toContain("--backend")
  })

  it("**search all** reads meetings only when --source names a meeting account, and refuses to guess between several", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-meetings-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const meetingIn = async (account: string) => {
      const store = await openStore({ path: env.MESSAGING_STORE })
      try {
        const accountId = await store.accounts.saveAccount({ provider: "zoom", account }, { name: "Invented" })
        const sample = sampleMeeting()
        await store.meetings.saveMeeting({
          ...sample,
          meeting: { ...sample.meeting, accountId, title: "Reading circle" },
          transcripts: [
            {
              ...sample.transcripts[0],
              rows: [{ ...sample.transcripts[0].rows[0], text: "Bob Sample reads the chapter aloud" }],
            },
          ],
        })
      } finally {
        await store.close()
      }
    }
    await meetingIn("zm-profile:alice")
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const kinds = (answer: { items: { kind: string }[] }) => new Set(answer.items.map(({ kind }) => kind))

    const plain = JSON.parse((await call(["search", "all", "chapter", "--json"], never, env)).stdout[0] ?? "")
    expect(kinds(plain)).toEqual(new Set(["message"]))
    expect(plain.missing?.map(({ field }: { field: string }) => field) ?? []).not.toContain("items")
    expect(plain.meta.issues).toContainEqual({ code: "validation_error", source: "meetings" })

    const named = await call(["search", "all", "chapter", "--source", "all", "--json"], never, env)
    expect(named.code).toBe(0)
    const answer = JSON.parse(named.stdout[0] ?? "")
    expect(kinds(answer)).toEqual(new Set(["message", "meeting"]))
    expect(answer.meta.accounts).toContain("zoom:zm-profile:alice")
    expect(answer.items.find(({ kind }: { kind: string }) => kind === "meeting")).toMatchObject({
      provider: "zoom",
      account: "zm-profile:alice",
      title: "Reading circle",
      excerpt: "Bob Sample reads the chapter aloud",
    })

    const only = JSON.parse(
      (await call(["search", "all", "chapter", "--source", "zoom:zm-profile:alice", "--json"], never, env)).stdout[0] ??
        "",
    )
    expect(kinds(only)).toEqual(new Set(["meeting"]))

    const pretty = await call(["search", "all", "chapter", "--source", "all"], never, env, { tty: true })
    expect(pretty.stdout.join("")).toMatch(/meeting · zoom · Reading circle {2}meeting:\d+\/\d+/)

    const unasked = await call(["search", "all", "chapter", "--only", "meetings", "--json"], never, env)
    expect(unasked.code).toBe(2)
    expect(unasked.stderr.join("\n")).toContain(`--only meetings: ${MEETINGS_UNNAMED}`)

    await meetingIn("zm-profile:bob")
    const several = await call(["search", "all", "chapter", "--source", "meetings", "--json"], never, env)
    expect(several.code).toBe(2)
    expect(several.stderr.join("\n")).toContain("zoom:zm-profile:alice, zoom:zm-profile:bob")
    expect(never).not.toHaveBeenCalled()
  })

  it("**search all --max-meetings** bounds the meetings looked through; all looks through every one", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-max-meetings-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    try {
      const accountId = await store.accounts.saveAccount(
        { provider: "zoom", account: "zm-profile:carol" },
        { name: "Invented" },
      )
      const sample = sampleMeeting()
      for (const [externalId, startedAt, text] of [
        ["older", 1000, "Bob Sample reads the chapter aloud"],
        ["newer", 5000, "Alice Example plans the garden"],
      ] as const)
        await store.meetings.saveMeeting({
          ...sample,
          meeting: { ...sample.meeting, accountId, externalId, startedAt, endedAt: startedAt + 1000 },
          transcripts: [{ ...sample.transcripts[0], rows: [{ ...sample.transcripts[0].rows[0], text }] }],
        })
    } finally {
      await store.close()
    }
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const search = async (...extra: string[]) =>
      call(["search", "all", "chapter", "--source", "meetings", ...extra, "--json"], never, env)

    const one = JSON.parse((await search("--max-meetings", "1")).stdout[0] ?? "")
    expect(one.items).toEqual([])
    expect(one).toMatchObject({
      missing: [{ field: "items", why: "stopped after 1 meetings; more may match", step: "search.meetings" }],
      next: [{ step: "search.meetings", command: "search all", args: { query: "chapter", max_meetings: "all" } }],
    })
    const every = JSON.parse((await search("--max-meetings", "all")).stdout[0] ?? "")
    expect(every.items.map(({ excerpt }: { excerpt: string }) => excerpt)).toEqual([
      "Bob Sample reads the chapter aloud",
    ])
    expect(every).not.toHaveProperty("missing")

    const zero = await search("--max-meetings", "0")
    expect(zero.code).toBe(2)
    expect(zero.stderr.join("\n")).toContain("--max-meetings takes a whole number from 1, or all")
    const alone = await call(["search", "all", "chapter", "--max-meetings", "5", "--json"], never, env)
    expect(alone.code).toBe(2)
    expect(alone.stderr.join("\n")).toContain(`--max-meetings: ${MEETINGS_UNNAMED}`)
  })

  it("**search all** skips meetings with a reason when --source names no meeting account", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-no-meetings-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const found = await call(["search", "all", "chapter", "--source", "all", "--json"], never, env)
    expect(found.code).toBe(0)
    const answer = JSON.parse(found.stdout[0] ?? "")
    expect(answer.items.length).toBeGreaterThan(0)
    expect(answer.meta.issues).toContainEqual({ code: "not_found", source: "meetings" })
    const alone = await call(["search", "all", "chapter", "--source", "meetings", "--json"], never, env)
    expect(alone.code).toBe(2)
    expect(alone.stderr.join("\n")).toContain("--source names nothing search all reads: meetings")
  })

  it("**search all --source** reads the accounts it names and says which, pretty on stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-all-source-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const answer = JSON.parse(
      (await call(["search", "all", "chapter", "--source", "chat:500", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(answer.meta.accounts).toEqual(["chat:500"])
    expect(answer.meta.issues).toContainEqual({ code: "not_found", source: "notes" })
    const pretty = await call(["search", "all", "chapter", "--source", "chat:500"], never, env, { tty: true })
    expect(pretty.stderr.join("\n")).toContain("searched: chat:500")
    expect(pretty.stdout.join("\n")).not.toContain("searched:")
    const both = await call(["search", "all", "chapter", "--source", "chat:500", "--meetings", "zoom:z1"], never, env)
    expect(both.code).toBe(2)
  })

  it("**the old search paths are gone**, with no alias, and has: narrows search messages as --type did", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-paths-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    for (const old of [
      ["messages", "search"],
      ["conversations", "search"],
      ["topics", "search", "7"],
    ]) {
      const answer = await call([...old, "chapter"], never, env)
      expect(answer.code).not.toBe(0)
      expect(answer.stderr.join("\n")).toMatch(/unknown command|too many arguments/)
    }
    const text = JSON.parse(
      (await call(["search", "messages", "chapter", "NOT has:attachment", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(text.items.length).toBeGreaterThan(0)
    const voice = JSON.parse(
      (await call(["search", "messages", "chapter", "has:voice", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(voice.items).toHaveLength(0)
    for (const gone of [
      ["--type", "text"],
      ["--chat", "7"],
    ])
      expect((await call(["search", "messages", "chapter", ...gone], never, env)).code).toBe(2)
  })

  it("**search messages keeps the messenger accounts of a --source list** and names the rest in skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-skipped-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const held = await openStore({ path: join(root, "m.db") })
    await held.accounts.saveAccount({ provider: "zoom", account: "z1" }, { name: null })
    await held.close()
    const never = vi.fn(async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    })
    const answer = JSON.parse(
      (await call(["search", "messages", "chapter", "--source", "chat:500,zoom:z1", "--json"], never, env)).stdout[0] ??
        "",
    )
    expect(answer.items.length).toBeGreaterThan(0)
    expect(answer.meta.accounts).toEqual(["chat:500"])
    expect(answer.meta.issues).toEqual([{ code: "validation_error", source: "zoom:z1" }])
    const pretty = await call(["search", "messages", "chapter", "--source", "chat:500,zoom:z1"], never, env, {
      tty: true,
    })
    expect(pretty.stderr.join("\n")).toContain("zoom:z1 not searched: meetings — search all reads them")
    const refused = await call(["search", "messages", "chapter", "--source", "zoom:z1", "--json"], never, env)
    expect(refused.code).toBe(2)
  })

  it("**searches other accounts and messengers** held in the file only when asked, naming each hit's messenger", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const other = await openStore({ path: join(root, "m.db") })
    await registerProvider(other, { name: "other", kind: "messages", aliases: [], command: "other" })
    const elsewhere = { provider: "other", account: "600" }
    await other.chats.saveChats(elsewhere, [{ ...chat, title: "Reading circle" }])
    await other.messages.saveMessages(
      elsewhere,
      "7",
      [{ ...thread[0], id: "40", text: "chapter four", timestamp: "2026-09-27T11:00:00.000Z" } as Message],
      {
        via: "history",
      },
    )
    await other.close()
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    }
    const search = (...argv: string[]) => call(["search", "messages", ...argv], never, env)
    const locators = async (...argv: string[]) =>
      JSON.parse((await search(...argv, "--json")).stdout[0] ?? "").items.map((hit: { ref: string }) => hit.ref)

    expect(await locators("chapter")).not.toContain("msg:other/600/7/40")
    expect(await locators("chapter", "in:other")).toEqual(["msg:other/600/7/40"])
    expect(await locators("chapter", "--source", "all", "--newest")).toEqual([
      "msg:other/600/7/40",
      "msg:chat/500/7/3",
      "msg:chat/500/7/2",
      "msg:chat/500/7/1",
    ])
    const wide = JSON.parse((await search("chapter", "in:all", "--context", "1", "--json")).stdout[0] ?? "")
    expect(wide.meta.accounts).toEqual(expect.arrayContaining(["chat:500", "other:600"]))
    expect(
      wide.items
        .find((hit: { ref: string }) => hit.ref.startsWith("msg:other"))
        .context.map((one: { ref: string }) => one.ref),
    ).toEqual(["msg:other/600/7/40"])

    const pretty = await call(["search", "messages", "chapter", "in:all"], never, env, { tty: true })
    expect(pretty.stdout.join("\n")).toContain("other · Reading circle  msg:other/600/7/40")
    expect(pretty.stdout.join("\n")).toContain("chat · 7  msg:chat/500/7/3")
    expect(pretty.stderr.join("\n")).toContain("hits in other open in that messenger's own CLI")
    const own = await call(["search", "messages", "chapter"], never, env, { tty: true })
    expect(own.stdout.join("\n")).toMatch(/^7 {2}msg:chat\/500\/7\/3$/m)
    expect(own.stdout.join("\n")).not.toContain("chat · ")

    const failed = async (...argv: string[]) =>
      (await search(...argv, "--json")).stderr
        .filter((line) => line.startsWith("{"))
        .map((line) => String(JSON.parse(line).error?.message))
        .join("\n")
    expect(await failed("chapter", "--source", "nowhere")).toContain(
      '--source takes chat, other, personal, bots, all, messages, mail — not "nowhere"',
    )
    expect(await failed("from:Olga", "chapter", "in:all")).toContain('"Olga" matches 2 people in different accounts')
    expect(await failed("chapter", "chat:7", "in:all")).toContain('"7" matches 2 chats in different accounts')
    expect(await locators("chapter", "chat:Reading", "in:all")).toEqual(["msg:other/600/7/40"])
  })

  it.each(["max", "telegram"])(
    "executes every documented Lucene recipe through the real CLI (%s)",
    async (provider) => {
      const root = mkdtempSync(join(tmpdir(), "search-recipes-"))
      const env = {
        CHAT_PROFILE: "default",
        CHAT_STATE_DIR: join(root, "state"),
        CHAT_CONFIG_DIR: join(root, "config"),
        MESSAGING_STORE: join(root, "m.db"),
      }
      rememberAccount(app, "default", "500", env)
      const store = await openStore({ path: env.MESSAGING_STORE })
      await seedSearchRecipes(store, { provider, account: "500" })
      await store.close()
      const never = async (): Promise<MessengerAdapter> => {
        throw new Error("search must never connect")
      }
      for (const recipe of searchRecipes.recipes) {
        const result = await call(
          ["search", "messages", recipe.query, "--timezone", "UTC", "--json"],
          never,
          env,
          {},
          { provider },
        )
        expect(result.code, recipe.title).toBe(0)
        const answer = JSON.parse(result.stdout[0] ?? "null")
        expect(answer.items.map((item: { ref: string }) => item.ref.split("/").at(-1)).sort(), recipe.title).toEqual(
          recipe.ids,
        )
        expect(answer).toMatchObject({ page: { limit: 20, has_more: false }, meta: { accounts: [`${provider}:500`] } })
        expect(result.stdout).toHaveLength(1)
      }
      const stats = await call(["stats", "messages", "show", "invoice", "--json"], never, env, {}, { provider })
      expect(stats.code).toBe(0)
      expect(stats.stdout).toHaveLength(1)
      expect(JSON.parse(stats.stdout[0] ?? "null")).toMatchObject({
        item: {
          by: "chat",
          total: 4,
          rows: [{ key: "7", ref: `chat:${provider}/500/7`, name: "Work fixture", count: 4 }],
        },
      })
      const badGrouping = await call(
        ["stats", "messages", "show", "--by", "week", "--json"],
        never,
        env,
        {},
        { provider },
      )
      expect(badGrouping.code).toBe(2)
      expect(badGrouping.stdout).toEqual([])
      const chatStats = await call(
        [
          "stats",
          "chats",
          "show",
          "7",
          "--offline",
          "--since-time",
          "2000-01-01",
          "--timezone",
          "Asia/Vladivostok",
          "--json",
        ],
        never,
        env,
        {},
        { provider },
      )
      expect(chatStats.code).toBe(0)
      expect(chatStats.stdout).toHaveLength(1)
      expect(JSON.parse(chatStats.stdout[0] ?? "null")).toMatchObject({
        item: { chat: expect.stringMatching(/\/7$/), complete: false },
        meta: { timezone: "Asia/Vladivostok", window: { since: "1999-12-31T14:00:00.000Z" } },
      })
      expect(chatStats.stderr.join("\n")).toContain("joins and leaves were not asked of the messenger")
      const asked: string[] = []
      const joins = async () =>
        ({
          self: () => "500",
          chatEvents: async (chatId: string) => {
            asked.push("chatEvents")
            return { chatId, since: "2000-01-01T00:00:00.000Z", more: false, events: [] }
          },
          admins: async () => null,
          close: async () => {},
        }) as unknown as MessengerAdapter
      const online = await call(
        ["stats", "chats", "show", "7", "--since-time", "2000-01-01", "--json"],
        joins,
        env,
        {},
        { provider },
      )
      expect(online.code).toBe(0)
      expect(online.stdout).toHaveLength(1)
      expect(JSON.parse(online.stdout[0] ?? "null")).toMatchObject({
        item: { members: { joined: 0, left: 0 } },
        next: [{ step: "messages.sync", args: { chat: "7" } }],
      })
      expect(asked).toEqual(["chatEvents"])
      const roster = async () =>
        ({
          self: () => "500",
          members: async () => {
            asked.push("members")
            return { chatId: "7", hasMore: false, items: [{ id: "40", name: "", username: null, isBot: true }] }
          },
          close: async () => {},
        }) as unknown as MessengerAdapter
      const audit = await call(["chats", "members", "check", "7", "--json"], roster, env, {}, { provider })
      expect(audit.code).toBe(0)
      expect(audit.stdout).toHaveLength(1)
      expect(JSON.parse(audit.stdout[0] ?? "null")).toMatchObject({
        items: [{ id: "40", reasons: ["bot", "odd_name", "never_wrote"] }],
      })
      expect(asked).toEqual(["chatEvents", "members"])
      const fetched = await call(["chats", "members", "fetch", "7", "--track", "--json"], roster, env, {}, { provider })
      expect(fetched.code).toBe(0)
      expect(fetched.stdout).toHaveLength(1)
      expect(JSON.parse(fetched.stdout[0] ?? "null").item).toMatchObject({
        chat_id: "7",
        read: 1,
        joined: ["40"],
        tracked: true,
      })
      const tracked = await call(["chats", "tracking", "list", "--offline", "--json"], never, env, {}, { provider })
      expect(JSON.parse(tracked.stdout[0] ?? "null").items.map((one: { chat_id: string }) => one.chat_id)).toEqual([
        "7",
      ])
      const trackedItem = JSON.parse(tracked.stdout[0] ?? "null").items[0]
      expect(v.safeParse(ENTITIES.tracked_chat, trackedItem).success).toBe(true)
      for (const [query, expected] of [
        ["chat_id:7", ["7"]],
        ["chat_id:missing", []],
      ] as const) {
        const filtered = await call(
          ["chats", "tracking", "list", query, "--offline", "--json"],
          never,
          env,
          {},
          { provider },
        )
        expect(filtered.code).toBe(0)
        expect(JSON.parse(filtered.stdout[0] ?? "null").items.map((one: { chat_id: string }) => one.chat_id)).toEqual(
          expected,
        )
      }
      const invalidTracking = await call(
        ["chats", "tracking", "list", "missing:true", "--offline", "--json"],
        never,
        env,
        {},
        { provider },
      )
      expect(invalidTracking.code).toBe(2)
      expect(invalidTracking.stderr.join("\n")).toContain("query.unknown-field")
      const trackingHistory = await call(
        ["chats", "tracking", "show", "7", "--offline", "--json"],
        never,
        env,
        {},
        { provider },
      )
      expect(
        v.safeParse(ENTITIES.tracked_chat_history, JSON.parse(trackingHistory.stdout[0] ?? "null").item).success,
      ).toBe(true)
      const trackingChange = await call(
        ["chats", "tracking", "add", "7", "--offline", "--json=chat_id,tracked"],
        never,
        env,
        {},
        { provider },
      )
      expect(trackingChange.code).toBe(0)
      expect(v.parse(ENTITIES.chat_tracking, JSON.parse(trackingChange.stdout[0] ?? "null").item)).toEqual({
        chat_id: "7",
        tracked: true,
      })
      for (const recipe of searchRecipes.negative) {
        const result = await call(["search", "messages", recipe.query, "--json"], never, env, {}, { provider })
        expect(result.code).toBe(2)
        expect(result.stdout).toEqual([])
        expect(result.stderr.join("\n")).toContain(recipe.reason)
        expect(result.stderr.join("\n")).toContain(recipe.code)
      }
      const cancelled = new AbortController()
      cancelled.abort()
      const aborted = await call(
        ["search", "messages", "invoice", "--json"],
        never,
        env,
        { signal: cancelled.signal },
        { provider },
      )
      expect(aborted.code).toBe(130)
      expect(aborted.stdout).toEqual([])
      const deadline = await call(
        ["search", "messages", "invoice", "--timeout", "1ms", "--json"],
        never,
        env,
        {},
        { provider },
      )
      expect(deadline.code).toBe(9)
      expect(deadline.stdout).toEqual([])
      for (const flags of [["--regex"], ["--timezone", "Imaginary/Zone"]]) {
        const result = await call(["search", "messages", "invoice", ...flags, "--json"], never, env, {}, { provider })
        expect(result.code).toBe(2)
      }
    },
  )

  it("contacts context answers from the store alone, and link joins a MAX identity to it", async () => {
    const root = mkdtempSync(join(tmpdir(), "person-context-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    rememberAccount(app, "default", "500", env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const tg = { provider: "telegram", account: "500" }
    const max = { provider: "max", account: "900" }
    const at = "2026-09-02T10:00:00.000Z"
    const dialog = { kind: "dialog" as const, unreadCount: 0, lastMessageAt: at, participantsCount: null }
    const said = (chatId: string, senderId: string) => ({
      id: "1",
      chatId,
      senderId,
      senderName: null,
      timestamp: at,
      editedAt: null,
      text: "hello",
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    await store.chats.saveChats(tg, [{ ...dialog, id: "11", title: "Ana" }])
    await store.messages.saveMessages(tg, "11", [said("11", "11")], { via: "test" })
    await store.roster.saveMembers(tg, "11", ["11", "500"])
    await store.chats.saveChats(max, [{ ...dialog, id: "m1", title: "Ana" }])
    await store.messages.saveMessages(max, "m1", [said("m1", "m5")], { via: "test" })
    await store.roster.saveMembers(max, "m1", ["m5", "900"])
    await store.close()
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("contacts context must never connect")
    }

    const linked = await call(
      ["contacts", "link", "11", "max:m5", "--offline", "--json"],
      never,
      env,
      {},
      {
        provider: "telegram",
      },
    )
    expect(linked.code).toBe(0)
    expect(v.safeParse(ENTITIES.linked_person, JSON.parse(linked.stdout[0] ?? "null").item).success).toBe(true)
    const found = await call(
      ["contacts", "context", "11", "--offline", "--json"],
      never,
      env,
      {},
      {
        provider: "telegram",
      },
    )
    expect(found.code).toBe(0)
    expect(found.stdout).toHaveLength(1)
    const answer = JSON.parse(found.stdout[0] ?? "null").item
    expect(v.safeParse(ENTITIES.contact_context, answer).success).toBe(true)
    expect(answer.person.identities.map((one: { provider: string }) => one.provider)).toEqual(["max", "telegram"])
    expect(answer.recent.direct).toHaveLength(2)

    const prepared = await call(
      ["contacts", "prepare", "11", "--offline", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(prepared.code).toBe(0)
    const brief = JSON.parse(prepared.stdout[0] ?? "null").item
    expect(v.safeParse(ENTITIES.contact_preparation, brief).success).toBe(true)
    expect(brief.recent.direct).toHaveLength(2)
    expect(brief.prepare.waiting.map((one: { provider: string }) => one.provider).sort()).toEqual(["max", "telegram"])
    expect(brief.prepare.coverage.notes).not.toHaveProperty("withheld")

    const inChat = await call(
      ["contacts", "context", "11", "--chat", "11", "--offline", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(v.safeParse(ENTITIES.contact_context, JSON.parse(inChat.stdout[0] ?? "null").item).success).toBe(true)
    expect(JSON.parse(inChat.stdout[0] ?? "null").item.chats).toEqual([
      expect.objectContaining({ chat: { id: "11", title: "Ana", kind: "dialog" }, messages: [{ at, text: "hello" }] }),
    ])
    const detailed = await call(
      ["contacts", "context", "11", "--chat", "11", "-v", "--offline", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(v.safeParse(ENTITIES.contact_context, JSON.parse(detailed.stdout[0] ?? "null").item).success).toBe(true)
    expect(JSON.parse(detailed.stdout[0] ?? "null").item.chats[0].messages[0].locator).toBe("msg:telegram/500/11/1")
    const completeDetail = await call(
      ["contacts", "context", "11", "--chat", "11", "-vv", "--offline", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(completeDetail.code).toBe(0)
    const fullAnswer = JSON.parse(completeDetail.stdout[0] ?? "null").item
    const fullParsed = v.safeParse(ENTITIES.contact_context, fullAnswer)
    expect(fullParsed.success, JSON.stringify(fullParsed.issues?.map((issue) => issue.message))).toBe(true)
    const projectedContext = await call(
      ["contacts", "context", "11", "--chat", "11", "--offline", "--json=chats"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(projectedContext.code).toBe(0)
    expect(Object.keys(JSON.parse(projectedContext.stdout[0] ?? "null").item)).toEqual(["chats"])
    const unknownField = await call(
      ["contacts", "context", "11", "--offline", "--json=unknown"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(unknownField.code).toBe(2)
    expect(unknownField.stdout).toEqual([])
    expect(unknownField.stderr.join(" ")).toContain("output.unknown-field")
    const lonely = await call(
      ["contacts", "context", "11", "--sync-first", "--offline", "--json"],
      never,
      env,
      {},
      {
        provider: "telegram",
      },
    )
    expect(lonely.code).toBe(2)
    const mine = await call(
      ["contacts", "link", "max:900", "me", "--offline", "--json"],
      never,
      env,
      {},
      {
        provider: "telegram",
      },
    )
    expect(mine.code).toBe(0)
    expect(v.safeParse(ENTITIES.linked_person, JSON.parse(mine.stdout[0] ?? "null").item).success).toBe(true)
    const unlinked = await call(
      ["contacts", "unlink", "max:m5", "--offline", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(unlinked.code).toBe(0)
    expect(v.safeParse(ENTITIES.linked_person, JSON.parse(unlinked.stdout[0] ?? "null").item).success).toBe(true)
    const projected = await call(
      ["contacts", "link", "11", "max:m5", "--offline", "--json=uid"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(projected.code).toBe(0)
    expect(Object.keys(JSON.parse(projected.stdout[0] ?? "null").item)).toEqual(["uid"])
  })

  it("contacts events lists what a person took part in, newest first, within a time range and scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "person-timeline-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    rememberAccount(app, "default", "500", env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const tg = { provider: "telegram", account: "500" }
    const said = (id: string, timestamp: string) => ({
      id,
      chatId: "31",
      senderId: "21",
      senderName: "Alice Example",
      timestamp,
      editedAt: null,
      text: "synthetic",
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    await store.chats.saveChats(tg, [
      { id: "31", title: "Example group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    await store.messages.saveMessages(
      tg,
      "31",
      [said("1", "2026-09-01T10:00:00.000Z"), said("2", "2026-09-03T10:00:00.000Z")],
      {
        via: "test",
      },
    )
    const other = { provider: "telegram", account: "600" }
    await store.chats.saveChats(other, [
      { id: "31", title: "Example group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    await store.messages.saveMessages(other, "31", [said("3", "2026-09-04T10:00:00.000Z")], { via: "test" })
    await store.close()
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("contacts events must never connect")
    }
    const timeline = async (...flags: string[]) => {
      const result = await call(
        ["contacts", "events", "21", ...flags, "--offline", "--json"],
        never,
        env,
        {},
        {
          provider: "telegram",
        },
      )
      expect(result.code).toBe(0)
      const answer = JSON.parse(result.stdout[0] ?? "null")
      for (const item of answer.items) expect(v.safeParse(ENTITIES.contact_activity, item).success).toBe(true)
      return answer
    }

    const all = await timeline()
    expect(all.items.map((item: { at: string }) => item.at)).toEqual([
      "2026-09-03T10:00:00.000Z",
      "2026-09-01T10:00:00.000Z",
    ])
    expect(all.items[0]).toMatchObject({
      subject: "message",
      role: "sender",
      scope: "personal",
      chat_id: "31",
      locator: "msg:telegram/500/31/2",
    })
    const ranged = await timeline("at:[2026-09-02T00:00:00Z TO 2026-09-30T00:00:00Z]")
    expect(ranged.items.map((item: { locator: string }) => item.locator)).toEqual(["msg:telegram/500/31/2"])
    const cut = await timeline("--limit", "1")
    expect(cut).toMatchObject({
      page: { mode: "cursor", limit: 1, has_more: true, next_cursor: expect.stringMatching(/^before:\d+:\d+$/) },
    })
    expect(cut.meta?.truncated).toBeUndefined()
    expect(cut.next[0]).toMatchObject({ step: "page.next", command: "contacts events", args: { person: "21" } })
    const rest = await timeline("--limit", "1", "--cursor", cut.page.next_cursor)
    expect(rest.items.map((item: { locator: string }) => item.locator)).toEqual(["msg:telegram/500/31/1"])
    expect(rest.page.has_more).toBe(false)
    expect((await timeline("scope:work")).items).toEqual([])
  })

  it("contacts show adds the messenger's profile and their stored activity per shared chat, the phone whole unless --hide-phone", async () => {
    const root = mkdtempSync(join(tmpdir(), "person-profile-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    rememberAccount(app, "default", "500", env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const tg = { provider: "telegram", account: "500" }
    const said = (id: string, chatId: string, timestamp: string) => ({
      id,
      chatId,
      senderId: "11",
      senderName: null,
      timestamp,
      editedAt: null,
      text: "hello",
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    const chat = { unreadCount: 0, lastMessageAt: "2026-09-03T10:00:00.000Z", participantsCount: null }
    await store.chats.saveChats(tg, [
      { ...chat, id: "11", title: "Ana", kind: "dialog" },
      { ...chat, id: "-70", title: "Club", kind: "group" },
    ])
    await store.messages.saveMessages(tg, "11", [said("1", "11", "2026-09-01T10:00:00.000Z")], { via: "test" })
    await store.messages.saveMessages(
      tg,
      "-70",
      [said("5", "-70", "2026-09-02T10:00:00.000Z"), said("6", "-70", "2026-09-03T10:00:00.000Z")],
      { via: "test" },
    )
    await store.close()
    const described: MessengerAdapter = {
      ...fake,
      contact: async () => ({
        id: "11",
        name: "Ana",
        username: "ana",
        description: null,
        lastMessagedAt: "2026-09-01T10:00:00.000Z",
        chats: [{ id: "11", title: "Ana", kind: "dialog", lastMessageAt: "2026-09-01T10:00:00.000Z" }],
      }),
      profile: async () => ({
        id: "11",
        name: "Ana",
        usernames: ["ana"],
        bio: null,
        phone: "+34600000123",
        flags: { bot: false },
        seen: "recently",
        registered: { at: "2020-05-01T00:00:00.000Z", source: "estimate", precision: "month" },
        chats: [{ id: "11", title: "Ana", kind: "dialog", lastMessageAt: "2026-09-01T10:00:00.000Z" }],
      }),
    }

    const shown = await call(
      ["contacts", "show", "11", "--json"],
      async () => described,
      env,
      {},
      { provider: "telegram" },
    )
    const hidden = await call(
      ["contacts", "show", "11", "--hide-phone", "--json"],
      async () => described,
      env,
      {},
      { provider: "telegram" },
    )

    expect(shown.code).toBe(0)
    const answer = JSON.parse(shown.stdout[0] ?? "null").item
    expect(v.safeParse(ENTITIES.contact, answer).success).toBe(true)
    expect(v.safeParse(ENTITIES.contact, JSON.parse(hidden.stdout[0] ?? "null").item).success).toBe(true)
    expect(answer).toMatchObject({ seen: "recently", phone: "+34600000123", registered: { source: "estimate" } })
    expect(JSON.parse(hidden.stdout[0] ?? "null").item).not.toHaveProperty("phone")
    expect(answer.chats).toMatchObject([
      {
        ref: "chat:telegram/500/11",
        id: "11",
        title: "Ana",
        kind: "dialog",
        last_message_at: "2026-09-01T10:00:00.000Z",
        their_messages: 1,
        first_at: "2026-09-01T10:00:00.000Z",
        last_at: "2026-09-01T10:00:00.000Z",
        complete: false,
      },
      {
        id: "-70",
        title: "Club",
        kind: "group",
        their_messages: 2,
        first_at: "2026-09-02T10:00:00.000Z",
        last_at: "2026-09-03T10:00:00.000Z",
        complete: false,
      },
    ])
  })

  it("contacts show --offline describes them from the store and never connects", async () => {
    const root = mkdtempSync(join(tmpdir(), "person-profile-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    rememberAccount(app, "default", "500", env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const tg = { provider: "telegram", account: "500" }
    await store.chats.saveChats(tg, [
      { id: "11", title: "Ana", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.roster.saveMembers(tg, "11", ["11", "500"])
    await store.close()
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }

    const found = await call(
      ["contacts", "show", "11", "--offline", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )

    expect(found.code).toBe(0)
    expect(JSON.parse(found.stdout[0] ?? "null").item).toMatchObject({ id: "11", flags: {}, chats: [{ id: "11" }] })
  })

  it("contacts show saves the phone the messenger shows, so --offline has it", async () => {
    const root = mkdtempSync(join(tmpdir(), "person-profile-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    rememberAccount(app, "default", "500", env)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const tg = { provider: "telegram", account: "500" }
    await store.chats.saveChats(tg, [
      { id: "11", title: "Ana", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.roster.saveMembers(tg, "11", ["11", "500"])
    await store.close()
    const described: MessengerAdapter = {
      ...fake,
      contact: async () => ({
        id: "11",
        name: "Ana",
        username: null,
        description: null,
        lastMessagedAt: null,
        chats: [],
      }),
      profile: async () => ({
        id: "11",
        name: "Ana",
        usernames: [],
        bio: null,
        phone: "+34600000123",
        flags: {},
        chats: [],
      }),
    }
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }
    const offline = () =>
      call(["contacts", "show", "11", "--offline", "--json"], never, env, {}, { provider: "telegram" })

    expect(JSON.parse((await offline()).stdout[0] ?? "null").item).not.toHaveProperty("phone")
    await call(["contacts", "show", "11", "--json"], async () => described, env, {}, { provider: "telegram" })

    expect(JSON.parse((await offline()).stdout[0] ?? "null").item).toMatchObject({ phone: "+34600000123" })
    const hidden = await call(
      ["contacts", "show", "11", "--offline", "--hide-phone", "--json"],
      never,
      env,
      {},
      { provider: "telegram" },
    )
    expect(JSON.parse(hidden.stdout[0] ?? "null").item).not.toHaveProperty("phone")
  })

  it("contacts check scores a person, asks the ban lists only when it may, and --deep checks the audit's top", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-check-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    rememberAccount(app, "default", "500", env)
    const asked: string[] = []
    vi.stubGlobal("fetch", async (input: string | URL) => {
      asked.push(new URL(String(input)).hostname)
      return new Response(
        String(input).includes("lols")
          ? JSON.stringify({ ok: true, user_id: 40, banned: true, scammer: false, offenses: 3 })
          : JSON.stringify({ ok: false, description: "Record not found." }),
        { status: 200 },
      )
    })
    try {
      const person = async () =>
        ({
          self: () => "500",
          contact: async () => ({
            id: "40",
            name: "",
            username: null,
            description: null,
            lastMessagedAt: null,
            chats: [],
          }),
          photos: async () => ({ count: 1, oldestAt: new Date().toISOString() }),
          members: async () => ({
            chatId: "7",
            hasMore: false,
            items: [{ id: "40", name: "", username: null, isBot: true }],
          }),
          close: async () => {},
        }) as unknown as MessengerAdapter

      const checked = await call(["contacts", "check", "40", "--json"], person, env, {}, { provider: "telegram" })
      expect(checked.code).toBe(0)
      expect(checked.stdout).toHaveLength(1)
      const answer = JSON.parse(checked.stdout[0] ?? "null").item
      expect(v.safeParse(ENTITIES.contact_check, answer).success).toBe(true)
      expect(answer.reasons.map((one: { reason: string }) => one.reason)).toEqual(
        expect.arrayContaining(["lols_banned", "no_bio", "photo_recent", "odd_name", "no_username"]),
      )
      expect(answer.registries.map((one: { name: string; answer: string }) => [one.name, one.answer])).toEqual([
        ["cas", "clean"],
        ["lols", "listed"],
      ])
      expect(asked.sort()).toEqual(["api.cas.chat", "api.lols.bot"])

      asked.length = 0
      const quiet = await call(
        ["contacts", "check", "40", "--no-registries", "--json"],
        person,
        env,
        {},
        { provider: "telegram" },
      )
      expect(JSON.parse(quiet.stdout[0] ?? "null").item.registries).toEqual([])
      expect(quiet.stderr.join("\n")).toContain("the ban lists were not asked")
      expect(asked).toEqual([])

      const other = await call(["contacts", "check", "40", "--json"], person, env, {}, { provider: "max" })
      expect(
        JSON.parse(other.stdout[0] ?? "null").item.registries.map((one: { answer: string }) => one.answer),
      ).toEqual(["unknown", "unknown"])
      expect(asked).toEqual([])

      const profiled = async () =>
        ({
          ...(await person()),
          profile: async () => ({
            id: "41",
            name: "Ana",
            usernames: ["ana"],
            bio: "teacher",
            flags: { bot: false, scam: true },
            hasPhoto: true,
            registered: { at: new Date().toISOString(), source: "estimate", precision: "month" },
            chats: [],
          }),
        }) as unknown as MessengerAdapter
      const marked = await call(["contacts", "check", "41", "--json"], profiled, env, {}, { provider: "telegram" })
      const read = JSON.parse(marked.stdout[0] ?? "null").item
      expect(read.reasons.map((one: { reason: string; source: string }) => [one.reason, one.source])).toEqual(
        expect.arrayContaining([
          ["scam", "messenger"],
          ["new_account", "estimate"],
        ]),
      )
      expect(read.unknown).toEqual(expect.arrayContaining(["fake", "deleted"]))

      const deep = await call(
        ["chats", "members", "check", "7", "--deep", "1", "--json"],
        person,
        env,
        {},
        { provider: "telegram" },
      )
      expect(deep.code).toBe(0)
      expect(JSON.parse(deep.stdout[0] ?? "null").items[0].check.registries).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("**builds a chat's conversations** and explains a message's place in one, without connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      MESSAGING_STORE: join(root, "m.db"),
      WIRECAT_STATE_DIR: join(root, "cache"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("conversations come from the store alone")
    }

    expect((await call(["conversations", "list", "7"], never, env)).stderr.join("\n")).toContain(
      "conversations links rebuild --chat 7",
    )
    const built = await call(["conversations", "links", "rebuild", "--chat", "7", "--json"], never, env)
    expect(JSON.parse(built.stdout[0] ?? "").item).toMatchObject({ chat: "7", messages: 3, conversations: 1 })
    const listed = v.parse(
      listEnvelopeSchema(conversation),
      JSON.parse((await call(["conversations", "list", "7", "--json"], never, env)).stdout[0] ?? ""),
    )
    expect(listed.items).toMatchObject([{ first_message: "msg:chat/500/7/1", messages_count: 3, senders_count: 1 }])
    const none = await call(["conversations", "list", "7", "messages_count>3", "--json"], never, env)
    expect(JSON.parse(none.stdout[0] ?? "").items).toEqual([])
    const ranged = await call(
      ["conversations", "list", "7", "started_at>=2020-01-01 senders_count:1", "--json"],
      never,
      env,
    )
    expect(JSON.parse(ranged.stdout[0] ?? "").items).toHaveLength(1)
    const shown = await call(["conversations", "show", listed.items[0]?.id ?? "", "--jsonl"], never, env)
    expect(shown.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    const links = JSON.parse((await call(["messages", "links", "7", "3", "--json"], never, env)).stdout[0] ?? "")
    expect(v.safeParse(ENTITIES.message_links, links.item).success).toBe(true)
    expect(links.item).toMatchObject({
      links: [{ parent_id: "2", kind: "same_sender", chosen: true }],
      chain: ["2", "1"],
    })
    const whole = JSON.parse(
      (await call(["conversations", "show", listed.items[0]?.id ?? "", "--json"], never, env)).stdout[0] ?? "",
    )
    expect(whole.item).toMatchObject({
      first_message: "msg:chat/500/7/1",
      messages: [{ ref: "msg:chat/500/7/1" }, {}, {}],
    })
    expect((await call(["conversations", "show", "Book"], never, env)).code).toBe(2)

    const status = await call(["conversations", "embeddings", "status", "--chat", "7", "--json"], never, env)
    expect(status.stderr.join("\n")).toBe("")
    expect(JSON.parse(status.stdout[0] ?? "").item).toMatchObject({ embedded: 0 })
    const cleared = await call(
      ["conversations", "embeddings", "clear", "--chat", "7", "--model", "e5-small", "--json"],
      never,
      env,
    )
    expect(JSON.parse(cleared.stdout[0] ?? "").item).toMatchObject({ cleared: 0 })
    expect((await call(["conversations", "embeddings", "status"], never, env)).code).toBe(2)

    const readiness = await call(["conversations", "status", "--json"], never, env)
    expect(readiness.stderr).toEqual([])
    expect(JSON.parse(readiness.stdout[0] ?? "")).toMatchObject({
      items: [
        {
          chat: "7",
          state: "words-only",
          graph: { outdated_rules: false },
          vectors: { current: 0 },
          model: "e5-small",
        },
      ],
      page: { has_more: false },
    })
    const pretty = await call(["conversations", "status", "--chat", "7"], never, env, { tty: true })
    expect(pretty.stdout.join("")).toContain("7  words-only  built ")

    const words = await call(["search", "conversations", "message", "--json"], never, env)
    expect([words.code, words.stdout.length]).toEqual([0, 1])
    expect(JSON.parse(words.stdout[0] ?? "")).toMatchObject({
      next: [{ step: "models.download", args: { model: "e5-small" } }],
      missing: [{ field: "by", step: "models.download" }],
    })

    const related = await call(["conversations", "related", "7", "3", "--json"], never, env)
    expect([related.code, related.stdout]).toEqual([6, []])
    expect(related.stderr.join("\n")).toContain("conversations embed --chat 7")
  })

  it("**catches up every changed chat** with build, embed and search --catch-up, on this machine only", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
      WIRECAT_STATE_DIR: join(root, "cache"),
      CHAT_OPENAI_API_KEY: "sk-test",
    }
    await call(["chats", "list", "--json"], async () => fake, env)
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("catching up reads the store alone")
    }
    const sent: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(url)
      return new Response("{}")
    })
    try {
      const built = await call(["conversations", "links", "rebuild", "--max-chats", "5", "--json"], never, env)
      expect(built.stdout).toHaveLength(1)
      expect(JSON.parse(built.stdout[0] ?? "").item).toMatchObject({
        built: [{ chat: "7", messages: 3 }],
        embedded: [],
        left: [],
      })
      expect(built.stderr.join("\n")).toContain("chat 7: 3 messages → 1 conversations")

      for (const remote of [
        ["--embedding-provider", "openai"],
        ["--base-url", "https://api.example.com/v1", "--dims", "8"],
      ]) {
        const embed = await call(["conversations", "embed", ...remote, "--yes", "--json"], never, env)
        expect([embed.code, embed.stdout]).toEqual([2, []])
        expect(embed.stderr.join("\n")).toContain("on this machine only")
        const search = await call(["search", "conversations", "chapter", "--catch-up", ...remote, "--json"], never, env)
        expect([search.code, search.stdout]).toEqual([2, []])
      }
      expect(sent).toEqual([])

      const embed = await call(["conversations", "embed", "--json"], never, env)
      expect([embed.code, embed.stdout]).toEqual([6, []])
      expect(embed.stderr.join("\n")).toContain("models download e5-small")

      const found = await call(
        ["search", "conversations", "chapter", "--catch-up", "--max-chunks", "10", "--json"],
        never,
        env,
      )
      expect([found.code, found.stdout.length]).toEqual([0, 1])
      expect(JSON.parse(found.stdout[0] ?? "")).toMatchObject({
        missing: [{ field: "by", step: "models.download" }],
      })
      expect(found.stderr.join("\n")).toContain("nothing embedded: e5-small is not downloaded")
      expect(sent).toEqual([])

      mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
      writeFileSync(
        join(env.CHAT_CONFIG_DIR, "config.json"),
        JSON.stringify({ profiles: { default: { permissions: { "conversations.embeddings": "readonly" } } } }),
      )
      const refused = await call(["search", "conversations", "chapter", "--catch-up", "--json"], never, env)
      expect([refused.code, refused.stdout]).toEqual([5, []])
      expect((await call(["search", "conversations", "chapter", "--json"], never, env)).code).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("**hands the agent a batch**, keeps its text out of the run record, and refuses it to a profile denying messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("batches come from the store alone")
    }

    const status = await call(["conversations", "batches", "status", "--chat", "7", "--json"], never, env)
    expect(JSON.parse(status.stdout[0] ?? "").item).toMatchObject({ chat: "7", messages: 3, batches: 1 })
    const next = await call(
      ["conversations", "batches", "show", "--chat", "7", "--size", "10", "--json", "--record"],
      never,
      env,
    )
    const batch = JSON.parse(next.stdout[0] ?? "").item
    expect(batch.messages.map((one: { id: string; answer: boolean }) => [one.id, one.answer])).toEqual([
      ["1", true],
      ["2", true],
      ["3", true],
    ])
    expect(batch.remaining).toEqual({ messages: 0, characters: 0 })
    const kept = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? kept(join(dir, entry.name)) : [readFileSync(join(dir, entry.name), "utf8")],
      )
    const records = kept(env.CHAT_STATE_DIR)
    expect(records.join("\n")).toContain("conversations batches show")
    expect(records.join("\n")).not.toContain("chapter three")
    expect((await call(["conversations", "batches", "show", "--chat", "7", "--size", "5"], never, env)).code).toBe(2)

    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "deny" } } } }),
    )
    expect((await call(["conversations", "batches", "show", "--chat", "7"], never, env)).code).toBe(5)
  })

  it("**asks before chat text leaves the machine**: --yes in machine mode, --max-tokens, never under the read-only lock, none for a local server; a query to a remote embedder is held by the lock too", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
      CHAT_OPENAI_API_KEY: "sk-test",
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("embedding reads the store alone")
    }
    expect((await call(["conversations", "links", "rebuild", "--chat", "7"], never, env)).code).toBe(0)
    const sent: { url: string; auth: string | undefined }[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).authorization })
      const { input, dimensions } = JSON.parse(String(init.body)) as { input: string[]; dimensions?: number }
      const dims = dimensions ?? (url.startsWith("https://api.openai.com") ? 1536 : 8)
      return new Response(
        JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, ...new Array(dims - 1).fill(0)] })) }),
      )
    })
    try {
      const unasked = await call(
        ["conversations", "embed", "--chat", "7", "--embedding-provider", "openai", "--json"],
        never,
        env,
      )
      expect(unasked.code).not.toBe(0)
      expect(unasked.stderr.join("\n")).toContain("add --yes to send them")
      expect(sent).toEqual([])

      const capped = await call(
        [
          "conversations",
          "embed",
          "--chat",
          "7",
          "--embedding-provider",
          "openai",
          "--max-tokens",
          "1",
          "--yes",
          "--json",
        ],
        never,
        env,
      )
      expect(capped.stderr.join("\n")).toContain("above --max-tokens 1 — nothing was sent")
      expect(sent).toEqual([])

      const locked = await call(
        ["conversations", "embed", "--chat", "7", "--embedding-provider", "openai", "--yes", "--json"],
        never,
        { ...env, CHAT_READ_ONLY: "1" },
      )
      expect(locked.code).toBe(5)
      expect(JSON.parse(locked.stderr.find((line) => line.startsWith("{")) ?? "{}").error.message).toBe(
        "this process is read-only (CHAT_READ_ONLY) — it cannot send chat text to api.openai.com",
      )
      expect(sent).toEqual([])

      const agreed = await call(
        ["conversations", "embed", "--chat", "7", "--embedding-provider", "openai", "--yes", "--json"],
        never,
        env,
      )
      expect(agreed.code).toBe(0)
      expect(JSON.parse(agreed.stdout[0] ?? "").item).toMatchObject({
        model: "openai:text-embedding-3-small",
        skipped: 0,
      })
      expect(sent[0]).toEqual({ url: "https://api.openai.com/v1/embeddings", auth: "Bearer sk-test" })
      expect(agreed.stderr.join("\n")).not.toContain("sk-test")

      sent.length = 0
      const query = await call(
        ["search", "conversations", "anything", "--embedding-provider", "openai", "--json"],
        never,
        {
          ...env,
          CHAT_READ_ONLY: "1",
        },
      )
      expect(query.code).toBe(5)
      expect(JSON.parse(query.stderr.find((line) => line.startsWith("{")) ?? "{}").error.message).toBe(
        "this process is read-only (CHAT_READ_ONLY) — it cannot send the query to api.openai.com",
      )
      expect(sent).toEqual([])

      sent.length = 0
      const local = ["--base-url", "http://127.0.0.1:11434/v1", "--model", "m", "--dims", "8"]
      const onThisMachine = { ...env, CHAT_READ_ONLY: "1" }
      expect(
        (await call(["conversations", "embed", "--chat", "7", ...local, "--json"], never, onThisMachine)).code,
      ).toBe(0)
      expect(sent[0]?.url).toBe("http://127.0.0.1:11434/v1/embeddings")
      const status = await call(
        ["conversations", "embeddings", "status", "--chat", "7", ...local, "--json"],
        never,
        env,
      )
      expect(JSON.parse(status.stdout[0] ?? "").item).toMatchObject({ model: "url:127.0.0.1:11434:m", left: 0 })
      const found = await call(["search", "conversations", "anything", ...local, "--json"], never, onThisMachine)
      expect(JSON.parse(found.stdout[0] ?? "").items.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("**stores the agent's answer from stdin** with messages read-only, and not with conversations.links read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("answers go to the store alone")
    }
    const permissions = (levels: Record<string, string>) => {
      mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
      writeFileSync(
        join(env.CHAT_CONFIG_DIR, "config.json"),
        JSON.stringify({ profiles: { default: { permissions: levels } } }),
      )
    }
    const piped = (text: string) => ({ stdin: Object.assign(Readable.from([text]), { isTTY: false }) })
    const answer = (batch: string) =>
      call(
        ["conversations", "links", "add", "--batch", batch, "--json"],
        never,
        env,
        piped(JSON.stringify({ model: "m", answers: [{ message: "2", parent: "1", confidence: 0.9 }] })),
      )
    const batch = JSON.parse(
      (await call(["conversations", "batches", "show", "--chat", "7", "--json"], never, env)).stdout[0] ?? "",
    ).item.batch

    permissions({ messages: "readonly" })
    expect(JSON.parse((await answer(batch)).stdout[0] ?? "").item).toEqual({ chat: "7", stored: 1 })
    expect((await call(["conversations", "links", "add", "--batch", batch], never, env, piped("not json"))).code).toBe(
      2,
    )

    permissions({ "conversations.links": "readonly" })
    const refused = await answer(batch)
    expect(refused.code).toBe(5)
    expect(refused.stderr.join("\n")).toContain("permissions.conversations.links is readonly")

    permissions({})
    const cleared = await call(["conversations", "links", "clear", "--chat", "7", "--json"], never, env)
    expect(JSON.parse(cleared.stdout[0] ?? "").item).toEqual({ chat: "7", cleared: 1 })
  })

  it("**report and export what the store holds**, without connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }

    const status = await call(["store", "status", "--json"], never, env)
    expect(JSON.parse(status.stdout[0] ?? "")).toMatchObject({
      items: [{ chat_id: "7", title: null, messages: 3, held: [] }],
      page: { has_more: false },
    })
    const exported = await call(["store", "export", "7", "--jsonl"], never, env)
    expect(exported.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    const lines = await call(["store", "export", "7", "--format", "jsonl"], never, env)
    expect(lines.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    const one = await call(["store", "export", "7", "--json"], never, env)
    expect(one.stdout).toHaveLength(1)
    const help = (await call(["store", "export", "--help"], never, env)).stdout.join("\n").replace(/\s+/g, " ")
    expect(help).not.toContain("as JSON lines")
    expect(help).toContain("--jsonl one message per line, --json the list envelope of messages")
    const envelope = JSON.parse(one.stdout[0] ?? "")
    expect(envelope).toMatchObject({ page: { limit: 3, has_more: false } })
    expect(envelope.items.map((message: { id: string }) => message.id)).toEqual(["1", "2", "3"])
    const transcript = await call(["store", "export", "7", "--format", "markdown"], never, env)
    expect(transcript.stdout.join("\n")).toMatch(
      /^# 7\n\nTimes are in [\w/+-]+\.\n\n## \d{4}-\d{2}-\d{2}\n\n\*\*\d{2}:\d{2} /,
    )
    expect((await call(["store", "export", "7", "--format", "html"], never, env)).code).not.toBe(0)
    expect((await call(["export", "7"], never, env)).code).not.toBe(0)
    expect((await call(["sync", "status"], never, env)).code).not.toBe(0)
  })

  it("**store clear --left deletes the chats the account left**, only with --allow-dangerous, never the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    await call(["chats", "list", "--json"], async () => fake, env)
    const left: MessengerAdapter = { ...fake, chats: async () => ({ items: people, hasMore: false }) }
    await call(["chats", "list", "--json"], async () => left, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("store clear must never connect")
    }

    expect((await call(["store", "clear"], never, env)).code).toBe(2)
    const unconfirmed = await call(["store", "clear", "--left"], never, env, { tty: true })
    expect(unconfirmed.code).toBe(7)
    expect(unconfirmed.stderr.join("\n")).toContain("1 chat(s) this account has left and their 3 message(s)")
    expect(unconfirmed.stderr.join("\n")).toMatch(/7 {2}Book club {2}3/)
    const quiet = await call(["store", "clear", "--left", "--quiet"], never, env, { tty: true })
    expect(quiet.stderr.join("\n")).toMatch(/7 {2}Book club {2}3/)
    const refused = await call(["store", "clear", "--left", "--json"], never, env)
    expect(refused.stderr.join("\n")).not.toContain("Book club")
    const preview = await call(["store", "clear", "--left", "--dry-run", "--json"], never, env)
    expect(JSON.parse(preview.stdout[0] ?? "").item).toEqual({
      cleared: false,
      dry_run: true,
      chats: 1,
      messages: 3,
      left: [{ id: "7", title: "Book club", messages: 3 }],
    })
    const cleared = await call(["store", "clear", "--left", "--allow-dangerous", "--json"], never, env)
    expect(JSON.parse(cleared.stdout[0] ?? "").item).toEqual({
      cleared: true,
      chats: 1,
      messages: 3,
      left: [{ id: "7", title: "Book club", messages: 3 }],
    })
    expect(readdirSync(join(root, "state"), { recursive: true, encoding: "utf8" }).length).toBeGreaterThan(0)
    for (const file of readdirSync(join(root, "state"), { recursive: true, encoding: "utf8" })) {
      const path = join(root, "state", file)
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8"), file).not.toContain("Book club")
    }
    const again = await call(["store", "clear", "--left", "--json"], never, env)
    expect(JSON.parse(again.stdout[0] ?? "").item).toEqual({ cleared: false, chats: 0, messages: 0, left: [] })
    expect(JSON.parse((await call(["store", "status", "--json"], never, env)).stdout[0] ?? "").items).toEqual([])
  })

  it("**store clear --left names the first 20 chats it would delete** and counts the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const many = Array.from({ length: 23 }, (_, n) => ({ ...chat, id: `${100 + n}`, title: `Group ${n}` }))
    await call(
      ["chats", "list", "--json"],
      async () => ({ ...fake, chats: async () => ({ items: many, hasMore: false }) }),
      env,
    )
    await call(
      ["chats", "list", "--json"],
      async () => ({ ...fake, chats: async () => ({ items: people, hasMore: false }) }),
      env,
    )
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("store clear must never connect")
    }

    const refused = (await call(["store", "clear", "--left"], never, env, { tty: true })).stderr.join("\n")
    const preview = await call(["store", "clear", "--left", "--dry-run", "--json"], never, env)

    expect(refused).toContain("Group 0")
    expect(refused).not.toContain("Group 22")
    expect(refused).toContain("and 3 more — --dry-run --json lists every one")
    expect(JSON.parse(preview.stdout[0] ?? "").item.left).toHaveLength(23)
    const locked = { ...env, CHAT_READ_ONLY: "1" }
    expect((await call(["store", "clear", "--left", "--dry-run", "--json"], never, locked)).code).toBe(0)
    expect((await call(["store", "clear", "--left", "--allow-dangerous", "--json"], never, locked)).code).not.toBe(0)
    expect(
      JSON.parse((await call(["store", "clear", "--left", "--json"], never, env)).stderr[0] ?? "").error.code,
    ).toBe("confirmation_required")
  })

  it("**export to a new file only the owner can read**, from --since on, and never over a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }
    const file = join(root, "book.jsonl")

    const written = await call(
      ["store", "export", "7", "--output", file, "--since-time", "2026-09-27T10:01:00Z", "--json"],
      never,
      env,
    )
    const again = await call(["store", "export", "7", "--output", file], never, env)

    expect(written.code).toBe(0)
    expect(JSON.parse(written.stdout[0] ?? "").item).toEqual({ path: file, format: "jsonl", count: 2 })
    expect(JSON.parse(written.stdout[0] ?? "").meta).toMatchObject({ window: { since: "2026-09-27T10:01:00.000Z" } })
    expect(JSON.parse(written.stdout[0] ?? "").meta).not.toHaveProperty("timezone")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual(["2", "3"])
    expect(readFileSync(file, "utf8").split("\n")[0]).toContain('"chat_id":"7"')
    expect(readFileSync(file, "utf8")).not.toContain("chatId")
    expect(again.code).toBe(2)
    expect(again.stderr.join("\n")).toContain("never overwrites")
    expect((await call(["store", "export", "7", "--since-time", "4242"], never, env)).code).toBe(2)
  })

  it("**export chats into a folder, and run again for only what changed** — a deletion without its text", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }
    const dir = join(root, "export")
    const exported = async () =>
      JSON.parse((await call(["store", "export", "7", "--output-dir", dir, "--json"], never, env)).stdout[0] ?? "").item
    const lines = (file: string) =>
      readFileSync(join(dir, file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))

    const first = await exported()
    const unchanged = await exported()
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.messages.markDeleted({ provider: manifest.provider, account: manifest.account }, ["2"], { chatId: "7" })
    await store.close()
    const after = await exported()

    expect(lines(first.chats[0].file).map((one: { id: string }) => one.id)).toEqual(["1", "2", "3"])
    expect(statSync(join(dir, first.chats[0].file)).mode & 0o777).toBe(0o600)
    expect(unchanged.chats[0]).toMatchObject({ file: null, messages: 0, deleted: 0 })
    expect(lines(first.chats[0].file)[0]).toMatchObject({ id: "1", chat_id: "7", ref: expect.any(String) })
    expect(lines(after.chats[0].file)).toEqual([{ id: "2", chat_id: "7", deleted: true }])
    expect(manifest.version).toBe(2)
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).chats["7"]).toMatchObject({
      messages: 3,
      deleted: 1,
      files: [first.chats[0].file, after.chats[0].file],
    })
  })

  it("refuses an export folder it cannot add to safely, and --output-dir with what it does not keep", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }
    const busy = join(root, "busy")
    mkdirSync(busy)
    writeFileSync(join(busy, "notes.txt"), "mine")

    const intoBusy = await call(["store", "export", "7", "--output-dir", busy], never, env)
    const markdown = await call(
      ["store", "export", "7", "--output-dir", join(root, "x"), "--format", "markdown"],
      never,
      env,
    )
    const nothing = await call(["store", "export", "--output-dir", join(root, "y")], never, env)
    const several = await call(["store", "export", "7", "8"], never, env)

    const older = join(root, "older")
    mkdirSync(older)
    writeFileSync(
      join(older, "manifest.json"),
      JSON.stringify({ format: "cli-messaging-export", version: 1, chats: {} }),
    )
    const intoOlder = await call(["store", "export", "7", "--output-dir", older], never, env)

    expect(intoBusy.stderr.join("\n")).toContain("holds other files")
    expect(intoOlder.stderr.join("\n")).toContain("export version 1")
    expect([intoBusy.code, intoOlder.code, markdown.code, nothing.code, several.code]).toEqual([2, 2, 2, 2, 2])
    expect(existsSync(join(root, "x"))).toBe(false)
  })

  const encryptedArchive = async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }
    const password = (text: string) => ({ stdin: Object.assign(Readable.from([`${text}\n`]), { isTTY: false }) })
    const dir = join(root, "sealed")

    return { root, env, never, password, dir }
  }

  it("exports encrypted, accepts only the password and never keeps it", async () => {
    const { root, env, never, password, dir } = await encryptedArchive()
    const first = await call(
      ["store", "export", "7", "--output-dir", dir, "--encrypt", "--json"],
      never,
      env,
      password("pw one"),
    )
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
    const run = first.stdout[0] ? JSON.parse(first.stdout[0]).item.chats[0].file : ""
    const plainInto = await call(["store", "export", "7", "--output-dir", dir], never, env)
    const wrong = await call(
      ["store", "decrypt", join(dir, run), "--output", join(root, "x.jsonl")],
      never,
      env,
      password("pw two"),
    )
    const opened = await call(
      ["store", "decrypt", join(dir, run), "--output", join(root, "run.jsonl")],
      never,
      env,
      password("pw one"),
    )
    const noFile = await call(["store", "export", "7", "--encrypt"], never, env, password("pw one"))

    expect(first.code).toBe(0)
    expect(manifest).toMatchObject({ encrypted: true, chats: { "7": { title: null, messages: 3 } } })
    expect(run).toMatch(/^run-.*\.jsonl\.sealed$/)
    expect(readFileSync(join(dir, run)).includes("Book")).toBe(false)
    expect(plainInto.code).toBe(2)
    expect(wrong.code).toBe(2)
    expect(existsSync(join(root, "x.jsonl"))).toBe(false)
    expect(opened.code).toBe(0)
    expect(
      readFileSync(join(root, "run.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual(["1", "2", "3"])
    expect(noFile.code).toBe(2)
    const everyFile = readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    expect(everyFile.filter((entry) => readFileSync(join(entry.parentPath, entry.name)).includes("pw one"))).toEqual([])
  })

  it("checks the encrypted folder password on later exports", async () => {
    const { env, never, password, dir } = await encryptedArchive()
    const first = await call(
      ["store", "export", "7", "--output-dir", dir, "--encrypt", "--json"],
      never,
      env,
      password("pw one"),
    )
    expect(first.code).toBe(0)
    const again = await call(
      ["store", "export", "7", "--output-dir", dir, "--encrypt", "--json"],
      never,
      env,
      password("pw two"),
    )
    const same = await call(
      ["store", "export", "7", "--output-dir", dir, "--encrypt", "--json"],
      never,
      env,
      password("pw one"),
    )
    expect(again.code).toBe(2)
    expect(again.stderr.join("\n")).toContain("not the password this folder was sealed with")
    expect(same.code).toBe(0)
  })

  it("backs up encrypted and restores only with the password, leaving no temporary copy", async () => {
    const { root, env, never, password } = await encryptedArchive()
    const away = join(root, "away")
    mkdirSync(away)
    const backup = join(away, "store.sealed")
    const backedUp = await call(["store", "backup", backup, "--encrypt", "--json"], never, env, password("pw one"))
    const badRestore = await call(["store", "restore", backup], never, env, password("nope"))
    const restored = await call(["store", "restore", backup, "--json"], never, env, password("pw one"))

    expect(JSON.parse(backedUp.stdout[0] ?? "").item).toMatchObject({
      path: backup,
      encrypted: true,
      rows: { messages: 3 },
    })
    expect(readdirSync(away)).toEqual(["store.sealed"])
    expect(readFileSync(backup).subarray(0, 15).toString()).not.toBe("SQLite format 3")
    expect(readdirSync(root).filter((name) => name.includes(".backup-"))).toEqual([])
    expect(badRestore.code).toBe(2)
    expect(restored.code).toBe(0)
    expect(JSON.parse(restored.stdout[0] ?? "").item).toMatchObject({ restored_from: backup })
    expect(readdirSync(root).filter((name) => name.includes("unsealing"))).toEqual([])
  })

  it("keep the account file where tg-cli 0.x kept it", () => {
    const tg = { command: "tg", appName: "tg-cli", envPrefix: "TG", description: "", version: "0" }
    expect(accountFileFor(tg, "work", { TG_PROFILE: "default", TG_STATE_DIR: "/state" })).toBe(
      "/state/accounts/work.json",
    )
  })
})

describe("messages download", () => {
  const bytes = (text: string) =>
    async function* () {
      yield new TextEncoder().encode(text)
    }
  const withFiles: MessengerAdapter = {
    ...fake,
    download: async () => ({
      files: [
        { kind: "file", name: "../../.bashrc", mime: "text/plain", bytes: bytes("notes") },
        { kind: "photo", bytes: bytes("jpeg") },
      ],
      skipped: ["poll"],
    }),
  }
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    return {
      root,
      env: { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") },
    }
  }

  it("**saves every file into the folder under a safe name**, and answers paths and sizes", async () => {
    const { root, env } = setup()
    const into = join(root, "out")
    const { code, stdout, stderr } = await call(
      ["messages", "download", "Book", "1", "--output-dir", into, "--json"],
      async () => withFiles,
      env,
    )

    expect(code).toBe(0)
    expect(JSON.parse(stdout[0] ?? "").item.files).toEqual([
      { kind: "file", path: join(into, "bashrc"), bytes: 5 },
      { kind: "photo", path: join(into, "1-2.jpg"), bytes: 4 },
    ])
    expect(readFileSync(join(into, "bashrc"), "utf8")).toBe("notes")
    expect(readdirSync(into).sort()).toEqual(["1-2.jpg", "bashrc"])
    expect(stderr.join("")).toContain("poll")
  })

  it("**records in the local store where each file of a held message went**", async () => {
    const { root, env } = setup()
    const into = join(root, "out")
    const held: MessengerAdapter = {
      ...withFiles,
      history: async () => ({
        items: [
          { ...message, attachments: [{ kind: "file", name: "../../.bashrc" }, { kind: "poll" }, { kind: "photo" }] },
        ],
        hasMore: false,
      }),
    }
    await call(["messages", "list", "Book", "--json"], async () => held, env)
    const { code } = await call(["messages", "download", "Book", "1", "--output-dir", into], async () => held, env)
    const database = await openCache(env.MESSAGING_STORE)
    const rows = database
      .prepare("SELECT position, local_path AS path FROM attachments ORDER BY position")
      .all()
      .map((row) => ({ ...row }))
    database.close()

    expect(code).toBe(0)
    expect(rows).toEqual([
      { position: 0, path: join(into, "bashrc") },
      { position: 1, path: null },
      { position: 2, path: join(into, "1-2.jpg") },
    ])
  })

  it("keeps downloads and structured failures when optional extraction fails", async () => {
    const { root, env } = setup()
    const into = join(root, "out")
    const held: MessengerAdapter = {
      ...withFiles,
      history: async () => ({
        items: [{ ...message, attachments: [{ kind: "file", name: "broken.docx" }] }],
        hasMore: false,
      }),
      download: async () => ({
        files: [{ kind: "file", position: 0, name: "broken.docx", bytes: bytes("not a document") }],
        skipped: [],
      }),
    }
    await call(["messages", "list", "Book", "--json"], async () => held, env)
    const result = await call(
      ["messages", "download", "Book", "1", "--extract", "--output-dir", into, "--json"],
      async () => held,
      env,
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout[0] ?? "").item).toMatchObject({
      complete: false,
      files: [{ path: join(into, "broken.docx") }],
      batch: { failed: 1, succeeded: 1, failures: [{ stage: "extract", error: { retryable: false } }] },
    })
    expect(readFileSync(join(into, "broken.docx"), "utf8")).toBe("not a document")
  })

  it("**never overwrites a file already there**", async () => {
    const { root, env } = setup()
    writeFileSync(join(root, "bashrc"), "mine")
    const { code, stderr } = await call(
      ["messages", "download", "Book", "1", "--output-dir", root],
      async () => withFiles,
      env,
    )

    expect(code).toBe(0)
    expect(stderr.join("")).toContain("validation_error")
    expect(readFileSync(join(root, "bashrc"), "utf8")).toBe("mine")
    expect(readdirSync(root).filter((name) => name.endsWith(".part"))).toEqual([])
  })

  it("refuses a message with no file, and a messenger that cannot download", async () => {
    const { env } = setup()
    const empty = await call(
      ["messages", "download", "Book", "1"],
      async () => ({ ...fake, download: async () => ({ files: [], skipped: [] }) }),
      env,
    )
    const unable = await call(["messages", "download", "Book", "1"], async () => fake, env)

    expect(empty.stderr.join("")).toContain("no file to download")
    expect(unable.stderr.join("")).toContain("cannot download attachments")
  })

  describe("--all", () => {
    const withIds = (ids: number[], kinds: Record<number, string>) =>
      ids.map((id) => ({ ...message, id: String(id), attachments: kinds[id] ? [{ kind: kinds[id] }] : [] }))
    const chatOf = (
      ids: number[],
      kinds: Record<number, string>,
      asked: string[],
      failOn?: string,
    ): MessengerAdapter => ({
      ...fake,
      history: async (_chat, { before }) => {
        const older = withIds(ids, kinds).filter((one) => before === undefined || Number(one.id) < Number(before))
        return { items: older.slice(0, 2).toReversed(), hasMore: older.length > 2 }
      },
      download: async (_chat, id) => {
        if (id === failOn) throw new CliError("network_error", "the connection dropped")
        asked.push(id)
        return {
          files: [{ kind: "file", name: "notes.txt", mime: "text/plain", bytes: bytes(`notes ${id}`) }],
          skipped: [],
        }
      },
    })

    it("**saves every file of the chat, page by page, asking only for messages that carry one**", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      const asked: string[] = []
      const { code, stdout } = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into, "--json"],
        async () => chatOf([5, 4, 3, 2, 1], { 5: "file", 4: "webpage", 2: "file" }, asked),
        env,
      )

      expect(code).toBe(0)
      expect(asked).toEqual(["5", "2"])
      expect(JSON.parse(stdout[0] ?? "").item).toMatchObject({
        files: [{ path: join(into, "notes.txt") }, { path: join(into, "2-1-notes.txt") }],
        saved: 2,
        complete: true,
      })
      expect(readFileSync(join(into, "2-1-notes.txt"), "utf8")).toBe("notes 2")
    })

    it("stops repeated extraction failures while retaining successful byte-download checkpoints", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      const asked: string[] = []
      const ids = Array.from({ length: 20 }, (_, i) => 20 - i)
      const adapter = {
        ...chatOf(ids, Object.fromEntries(ids.map((id) => [id, "file"])), asked),
        download: async (_chat: string, id: string) => {
          asked.push(id)
          return {
            files: [{ kind: "file", position: 0, name: `broken-${id}.docx`, bytes: bytes("not a document") }],
            skipped: [],
          }
        },
      }
      const result = await call(
        ["messages", "download", "Book", "--all", "--extract", "--pause", "1ms", "--output-dir", into, "--json"],
        async () => adapter,
        { ...env, MESSAGING_BATCH_MAX_ERROR_PERCENT: "1" },
      )
      expect(result.code).toBe(0)
      const body = JSON.parse(result.stdout[0] ?? "").item
      expect(body).toMatchObject({
        saved: 5,
        complete: false,
        batch: { attempted: 10, failed: 5, stop_reason: "error_rate" },
      })
      expect(asked).toHaveLength(5)
      expect(JSON.parse(readFileSync(join(into, ".download-7.json"), "utf8")).failed).toBeUndefined()
    })

    it("**continues where a cut-short run stopped**, and asks for no file twice", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      const kinds = { 6: "file", 5: "file", 3: "file", 1: "file" }
      const first: string[] = []
      const cut = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into, "--json"],
        async () => chatOf([5, 4, 3, 2, 1], kinds, first, "3"),
        env,
      )
      const second: string[] = []
      const again = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into, "--json"],
        async () => chatOf([6, 5, 4, 3, 2, 1], kinds, second),
        env,
      )

      expect(cut.code).toBe(0)
      expect(JSON.parse(cut.stdout[0] ?? "")).toMatchObject({
        item: { complete: false },
        next: [{ step: "messages.download", args: { chat: "Book", all: true, output_dir: into } }],
      })
      expect(first).toEqual(["5", "1"])
      expect(second).toEqual(["6", "3"])
      expect(JSON.parse(again.stdout[0] ?? "").item).toMatchObject({ saved: 2, existing: 0, complete: true })
      expect(readdirSync(into).filter((name) => !name.startsWith("."))).toHaveLength(4)
    })

    it("walks each page newest first in the order the messenger returned it", async () => {
      const { root, env } = setup()
      const asked: string[] = []
      const shuffled: MessengerAdapter = {
        ...chatOf([], {}, asked),
        history: async () => ({ items: withIds([3, 1, 2], { 3: "file", 1: "file", 2: "file" }), hasMore: false }),
      }
      await call(
        ["messages", "download", "Book", "--all", "--output-dir", join(root, "out")],
        async () => shuffled,
        env,
      )

      expect(asked).toEqual(["2", "1", "3"])
    })

    it("refuses ids that are not numbers before downloading anything: the progress file compares them", async () => {
      const { root, env } = setup()
      const asked: string[] = []
      const opaque: MessengerAdapter = {
        ...chatOf([], {}, asked),
        history: async () => ({
          items: [{ ...message, id: "msg-b", attachments: [{ kind: "file" }] }],
          hasMore: false,
        }),
      }
      const { code, stderr } = await call(
        ["messages", "download", "Book", "--all", "--output-dir", join(root, "out")],
        async () => opaque,
        env,
      )

      expect(code).not.toBe(0)
      expect(stderr.join("")).toContain("cannot resume")
      expect(asked).toEqual([])
    })

    it("uses the descriptor's page size and pause default for remote download", async () => {
      const { root, env } = setup()
      const limits: number[] = []
      const fetching = { page: 30, pause: "5s", maxPages: 10, orderBy: "time" as const }
      const descriptor: Messenger = {
        app,
        provider: "chat",
        chatArgument: "a chat",
        resolveSettings: settingsFor(app).resolveSettings,
        connect: async () => fake,
        fetching,
      }
      const download = messagesCommand(descriptor).commands.find((one) => one.name() === "download")
      expect(download?.options.find((one) => one.long === "--pause")?.defaultValue).toBe("5s")
      const result = await call(
        ["messages", "download", "Book", "--all", "--output-dir", join(root, "out"), "--json"],
        async () => ({
          ...fake,
          history: async (_chat, { limit }) => {
            limits.push(limit)
            return { items: [], hasMore: false }
          },
        }),
        env,
        {},
        { fetching },
      )
      expect(result.code).toBe(0)
      expect(limits).toEqual([30])
      expect(JSON.parse(result.stdout[0] ?? "").item).toMatchObject({ saved: 0, complete: true })
    })

    const byTime: Partial<Messenger> = { fetching: { page: 100, pause: "1ms", maxPages: 10, orderBy: "time" } }
    const wordChatOf = (sent: [id: string, second: number][], asked: string[], failOn?: string): MessengerAdapter => {
      const all = sent.map(([id, second]) => ({
        ...message,
        id,
        timestamp: new Date(Date.parse(message.timestamp) + second * 1000).toISOString(),
        attachments: [{ kind: "file" }],
      }))
      return {
        ...chatOf([], {}, asked, failOn),
        history: async (_chat, { before }) => {
          if (before !== undefined && !/^\d{4}-\d{2}-\d{2}T/.test(before)) {
            throw new CliError("validation_error", `this messenger pages back from a time, not from ${before}`)
          }
          const older = before === undefined ? all : all.filter((one) => one.timestamp < before)
          return { items: older.slice(-3), hasMore: older.length > 3 }
        },
      }
    }

    it("**pages a chat whose ids are words by send time**, resumes a cut run, and saves no file twice", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      const sent: [string, number][] = [
        ["msg-a", 1],
        ["msg-b", 2],
        ["msg-c", 2],
        ["msg-d", 2],
        ["msg-e", 3],
        ["msg-f", 4],
      ]
      const first: string[] = []
      const cut = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into],
        async () => wordChatOf(sent, first, "msg-c"),
        env,
        {},
        byTime,
      )
      const second: string[] = []
      const again = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into, "--json"],
        async () => wordChatOf([...sent, ["msg-g", 4]], second),
        env,
        {},
        byTime,
      )

      expect(cut.code).toBe(0)
      expect(first).toEqual(["msg-f", "msg-e", "msg-d", "msg-b", "msg-a"])
      expect(second).toEqual(["msg-g", "msg-c"])
      expect(JSON.parse(again.stdout[0] ?? "").item).toMatchObject({ saved: 2, existing: 0, complete: true })
      expect(readdirSync(into).filter((name) => !name.startsWith("."))).toHaveLength(7)
      expect(JSON.parse(readFileSync(join(into, ".download-7.json"), "utf8"))).toMatchObject({ by: "time" })
    })

    it("**resumes from a progress file written before it said what it counts by**, as ids", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      mkdirSync(into)
      writeFileSync(join(into, ".download-7.json"), JSON.stringify({ chat: "7", done: [{ from: 3, to: 5 }] }))
      const asked: string[] = []
      const kinds = { 6: "file", 5: "file", 4: "file", 3: "file", 2: "file", 1: "file" }

      const { code } = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into],
        async () => chatOf([6, 5, 4, 3, 2, 1], kinds, asked),
        env,
      )

      expect(code).toBe(0)
      expect(asked).toEqual(["6", "2", "1"])
      expect(JSON.parse(readFileSync(join(into, ".download-7.json"), "utf8"))).toMatchObject({
        by: "id",
        done: [{ from: 1, to: 6 }],
      })
    })

    it("sets aside a progress file that counts by time where the messenger counts by id", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      mkdirSync(into)
      const at = Date.parse(message.timestamp)
      writeFileSync(
        join(into, ".download-7.json"),
        JSON.stringify({ chat: "7", by: "time", done: [{ from: at, to: at + 5000, fromId: "1" }] }),
      )
      const asked: string[] = []

      const { stderr } = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output-dir", into],
        async () => chatOf([2, 1], { 2: "file", 1: "file" }, asked),
        env,
      )

      expect(asked).toEqual(["2", "1"])
      expect(stderr.join("")).toContain("starting from the newest again")
    })

    it("refuses a message id beside --all, and neither", async () => {
      const { env } = setup()
      const both = await call(["messages", "download", "Book", "1", "--all"], async () => withFiles, env)
      const neither = await call(["messages", "download", "Book"], async () => withFiles, env)

      expect(both.stderr.join("")).toContain("leave out the message id")
      expect(neither.stderr.join("")).toContain("name a message id")
    })
  })

  it("strips what could climb out of the folder, hide the file or disguise its extension", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd")
    expect(safeName("..\\evil.exe")).toBe("evil.exe")
    expect(safeName(".hidden")).toBe("hidden")
    expect(safeName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe")
    expect(safeName("..")).toBeUndefined()
  })
})

describe("messages transcribe", () => {
  const env = () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    return {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      MESSAGING_STORE: join(root, "m.db"),
      WIRECAT_STATE_DIR: join(root, "cache"),
      CHAT_CACHE_DIR: join(root, "chat-cache"),
    }
  }

  it("answers the text, and asks again later through a messages.transcribe step when it was not finished", async () => {
    const done = await call(
      ["messages", "transcribe", "Book", "5", "--json"],
      async () => ({ ...fake, transcribe: async () => ({ text: "hello", pending: false }) }),
      env(),
    )
    const pending = await call(
      ["messages", "transcribe", "Book", "5", "--json"],
      async () => ({ ...fake, transcribe: async () => ({ text: "", pending: true }) }),
      env(),
    )

    const answer = JSON.parse(done.stdout[0] ?? "")
    expect(v.safeParse(ENTITIES.message_transcript, answer.item).success).toBe(true)
    expect(v.safeParse(ENTITIES.message_transcript, JSON.parse(pending.stdout[0] ?? "").item).success).toBe(true)
    expect(answer.item).toEqual({ message_id: "5", text: "hello", pending: false, via: "chat" })
    expect(answer.next).toBeUndefined()
    expect(done.stderr).toEqual([])
    expect(JSON.parse(pending.stdout[0] ?? "").next).toMatchObject([
      { step: "messages.transcribe", args: { chat: "7", message: "5" } },
    ])
  })

  it("**refuses --local before connecting** when the model is not downloaded, naming the command", async () => {
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("a missing model must not cost a connection")
    }
    const { code, stderr } = await call(["messages", "transcribe", "Book", "5", "--local"], never, env())

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("chat models download parakeet-v3")
  })

  it("**saves a reference the messenger renewed while --local read the voice message**", async () => {
    const root = env()
    const directory = modelsDirectory(root)
    const model = speechModel("parakeet-v3")
    mkdirSync(join(directory, model.id), { recursive: true })
    for (const [path, bytes] of [
      [vadPath(directory), VAD.bytes] as const,
      ...model.files.map((file) => [modelPath(directory, model)(file.name), file.bytes] as const),
    ]) {
      writeFileSync(path, "")
      truncateSync(path, bytes)
    }
    rememberAccount(app, "default", "500", root)
    const seeded = await openStore({ env: root })
    await seeded.messages.saveMessages(
      { provider: "chat", account: "500" },
      "7",
      [{ ...message, id: "5", attachments: [{ kind: "voice", providerRef: { directPath: "/synthetic/expired" } }] }],
      { via: "history" },
    )
    await seeded.close()
    const tone = new Uint8Array(readFileSync(new URL("../../testing/fixtures/tone.ogg", import.meta.url)))
    const voice: RemoteFile = {
      kind: "voice",
      mime: "audio/ogg",
      position: 0,
      async *bytes() {
        yield tone
        voice.providerRef = { directPath: "/synthetic/fresh" }
      },
    }

    const heard = await call(
      ["messages", "transcribe", "Book", "5", "--local", "--json"],
      async () => ({ ...fake, download: async () => ({ files: [voice], skipped: [] }) }),
      root,
      { recognizer: () => ({ recognize: () => "heard locally", free: () => {} }) },
    )
    const store = await openStore({ env: root })
    const read = await store.messages.message({ provider: "chat", account: "500" }, "5", { chatId: "7" })
    await store.close()

    expect(JSON.parse(heard.stdout[0] ?? "").item).toMatchObject({ text: "heard locally", via: "local" })
    expect(read?.attachments.map((one) => one.providerRef)).toEqual([{ directPath: "/synthetic/fresh" }])
  })

  it("**lists a chat with its voice messages heard**, and shows them again later without asking", async () => {
    const root = env()
    const spoken = { ...message, attachments: [{ kind: "voice", mime: "audio/ogg" }] }
    let asked = 0
    const hearing = {
      ...fake,
      history: async () => ({ items: [spoken], hasMore: false }),
      transcribe: async () => {
        asked++
        return { text: "read me", pending: false }
      },
    }

    const first = await call(["messages", "list", "Book", "--transcribe", "--json"], async () => hearing, root)
    const again = await call(["messages", "list", "Book", "--json"], async () => hearing, root)
    const person = await call(["messages", "list", "Book"], async () => hearing, root, { tty: true })

    expect(JSON.parse(first.stdout[0] ?? "")).toMatchObject({ items: [{ transcript: "read me" }] })
    expect(JSON.parse(first.stdout[0] ?? "").missing).toBeUndefined()
    expect(JSON.parse(again.stdout[0] ?? "").items[0].transcript).toBe("read me")
    expect(person.stdout.join("")).toContain("🎤 read me")
    expect(asked).toBe(1)
  })

  describe("a kept transcript", () => {
    const voiceNote = { ...message, text: "", attachments: [{ kind: "voice", mime: "audio/ogg" }] }
    const hearing = (asked: string[]) => ({
      ...fake,
      history: async () => ({ items: [voiceNote], hasMore: false }),
      around: async () => [{ ...voiceNote, anchor: true as const }],
      transcribe: async () => {
        asked.push("transcribe")
        return { text: "synthetic zebrafinch", pending: false }
      },
    })
    const found = async (root: NodeJS.ProcessEnv, connect: Messenger["connect"]) =>
      JSON.parse((await call(["search", "messages", "zebrafinch", "--json"], connect, root)).stdout[0] ?? "").items.map(
        ({ ref }: { ref: string }) => ref.split("/").at(-1),
      )

    it("**is shown by messages show, found by search and not heard again**", async () => {
      const root = env()
      const asked: string[] = []
      const connect = async () => hearing(asked)

      await call(["messages", "list", "Book", "--transcribe", "--json"], connect, root)
      const shown = await call(["messages", "show", "Book", "1", "--json"], connect, root)
      const again = await call(["messages", "transcribe", "Book", "1", "--json"], connect, root)

      expect(JSON.parse(shown.stdout[0] ?? "").item.transcript).toBe("synthetic zebrafinch")
      expect(JSON.parse(again.stdout[0] ?? "").item).toMatchObject({ text: "synthetic zebrafinch", pending: false })
      expect(asked).toEqual(["transcribe"])
      expect(await found(root, connect)).toEqual(["1"])
      const pretty = await call(["search", "messages", "zebrafinch"], connect, root, { tty: true })
      expect(pretty.stdout.join("")).toContain("found in the transcript: synthetic zebrafinch")
    })

    it("**is found by search when it was heard before the message was stored**", async () => {
      const root = env()
      const connect = async () => hearing([])

      await call(["messages", "transcribe", "Book", "1", "--json"], connect, root)
      await call(["messages", "list", "Book", "--json"], connect, root)

      expect(await found(root, connect)).toEqual(["1"])
    })
  })

  it("lists the speech models Parakeet first, none downloaded, the first the default", async () => {
    const { stdout } = await call(["models", "list", "kind:audio", "--json"], async () => fake, env())

    expect(
      JSON.parse(stdout[0] ?? "").items.map((one: { id: string; downloaded: boolean; default: boolean }) => [
        one.id,
        one.downloaded,
        one.default,
      ]),
    ).toEqual([
      ["parakeet-v3", false, true],
      ["gigaam-v3", false, false],
      ["gigaam-v3-ctc", false, false],
    ])
  })
})

describe("the guard, account and mcp config commands", () => {
  const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    return {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
  }
  const json = (stdout: string[]) => JSON.parse(stdout[0] ?? "")

  it("**turn the recipient list on with the first add** and off again, and refuse removing a stranger", async () => {
    const env = sandbox()
    const online = async () => fake

    const off = await call(["recipients", "list", "--json"], online, env)
    expect(json(off.stdout)).toMatchObject({ items: [], page: { limit: 1, has_more: false } })
    expect(off.stderr.join("\n")).toContain("is off")

    expect(json((await call(["recipients", "add", "Book", "--json"], online, env)).stdout).item).toEqual({
      id: "7",
      title: "Book club",
      added: true,
    })
    expect(json((await call(["recipients", "list", "--json"], online, env)).stdout)).toMatchObject({
      items: [{ id: "7" }],
    })

    const filtered = await call(["recipients", "list", 'title:"book club"', "--json"], online, env)
    expect(filtered.code).toBe(0)
    expect(v.safeParse(ENTITIES.recipient, json(filtered.stdout).items[0]).success).toBe(true)
    const projected = await call(["recipients", "list", "id:7", "--json=id,title"], online, env)
    expect(json(projected.stdout).items).toEqual([{ id: "7", title: "Book club" }])
    const noMatch = await call(["recipients", "list", "id:99", "--json"], online, env)
    expect(json(noMatch.stdout).items).toEqual([])
    expect(noMatch.stderr.join("\n")).toContain("no recipients match")
    expect(noMatch.stderr.join("\n")).not.toContain("may send nowhere")
    const unsupported = await call(["recipients", "list", "added_at>=7d", "--json"], online, env)
    expect(unsupported.code).toBe(2)
    expect(unsupported.stderr.join("\n")).toContain("query.unsupported-field")
    const stranger = await call(["recipients", "remove", "99"], online, env)
    expect(stranger.code).not.toBe(0)
    expect(stranger.stderr.join("\n")).toContain("99 is not on the recipient list")

    expect(json((await call(["recipients", "remove", "7", "--json"], online, env)).stdout).item).toMatchObject({
      removed: true,
    })
    const empty = await call(["recipients", "list", "--json"], online, env)
    expect(empty.stderr.join("\n")).toContain("on and empty")

    expect(json((await call(["recipients", "clear", "--json"], online, env)).stdout).item).toEqual({
      off: true,
      was_on: true,
    })
    expect((await call(["recipients", "off"], online, env)).code).not.toBe(0)
  })

  it("list attempts to send newest first, and say when there were none", async () => {
    const env = sandbox()
    const none = await call(["sends", "list", "--json"], async () => fake, env)
    expect(none.stderr.join("\n")).toContain("has not tried to send anything")

    await call(["messages", "send", "Book", "one"], async () => fake, env)
    await call(["messages", "send", "Book", "two", "--reply-to", "1"], async () => fake, env)
    const listed = await call(["sends", "list", "--limit", "1", "--json"], async () => fake, env)
    const page = json(listed.stdout)
    expect(page.items.map((entry: { reply_to?: string }) => entry.reply_to)).toEqual(["1"])
    expect(page.page.has_more).toBe(true)
    expect(v.safeParse(ENTITIES.send_attempt, page.items[0]).success).toBe(true)
    const query = "outcome:sent chat_id:7"
    const filtered = await call(["sends", "list", query, "--limit", "1", "--json"], async () => fake, env)
    expect(filtered.code).toBe(0)
    expect(json(filtered.stdout).next[0]).toMatchObject({ args: { query, page: 2, limit: 1 } })
    const second = await call(
      ["sends", "list", query, "--limit", "1", "--page", "2", "--json=chat_id,outcome"],
      async () => fake,
      env,
    )
    expect(json(second.stdout).items).toEqual([{ chat_id: "7", outcome: "sent", operation_id: expect.any(String) }])
    expect(json(second.stdout).page.has_more).toBe(false)
    const noMatch = await call(["sends", "list", "outcome:failed", "--json"], async () => fake, env)
    expect(json(noMatch.stdout).items).toEqual([])
    expect(noMatch.stderr.join("\n")).toContain("no send attempts match")
    expect(noMatch.stderr.join("\n")).not.toContain("has not tried")
  })

  it("show who the profile is logged in as", async () => {
    const { stdout } = await call(["account", "show", "--json"], async () => fake, sandbox())
    expect(v.parse(itemEnvelopeSchema(ENTITIES.account), json(stdout)).item).toEqual({
      provider: "chat",
      id: "500",
      name: "Owner",
      username: null,
    })
  })

  it("**show the whole phone number, and leave it out with --hide-phone**", async () => {
    const withPhone: MessengerAdapter = {
      ...fake,
      me: async () => ({ ...(await fake.me()), phone: "+00 000 000-1234" }),
    }

    const whole = await call(["account", "show", "--json"], async () => withPhone, sandbox())
    const hidden = await call(["account", "show", "--hide-phone", "--json"], async () => withPhone, sandbox())

    expect(json(whole.stdout).item.phone).toBe("+00 000 000-1234")
    expect(json(hidden.stdout).item).not.toHaveProperty("phone")
  })

  it("**refuses mcp serve --http without an https tunnel address**, before connecting", async () => {
    const missing = await call(["mcp", "serve", "--http", "--json"], async () => fake, sandbox())
    const plain = await call(
      ["mcp", "serve", "--http", "--public-url", "http://name.example", "--json"],
      async () => fake,
      sandbox(),
    )
    const withQuery = await call(
      ["mcp", "serve", "--http", "--public-url", "https://name.ts.net/tg?x=1", "--json"],
      async () => fake,
      sandbox(),
    )

    expect(json(missing.stderr).error).toMatchObject({ code: "configuration_error" })
    expect(missing.stderr.join("\n")).toContain("--public-url https://")
    expect(json(plain.stderr).error.message).toContain("must be https")
    expect(json(withQuery.stderr).error.message).toContain("without a query")
  })

  it("**mcp revoke forgets every browser login** of the profile", async () => {
    const env = sandbox()
    const file = httpTokenFile(app, "default", env)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ clients: [], tokens: [] }))

    const { code, stdout } = await call(["mcp", "revoke", "--json"], async () => fake, env)
    const flag = await call(["mcp", "serve", "--revoke", "--json"], async () => fake, env)
    expect(flag.code).toBe(2)

    expect(code).toBe(0)
    expect(json(stdout).item).toEqual({ revoked: true, profile: "default" })
    expect(existsSync(file)).toBe(false)
  })

  it("**print the mcp entry by full path**, and warn when node belongs to a version manager", async () => {
    const env = sandbox()
    const mcp = { execPath: "/home/o/.nvm/versions/node/v24/bin/node", scriptPath: "/usr/lib/chat/bin/chat.js" }
    const { code, stdout } = await call(["work", "mcp", "config", "--json"], async () => fake, env, {
      mcp,
    })

    expect(code).toBe(0)
    expect(json(stdout).item.config.mcpServers["chat-work"]).toMatchObject({
      command: mcp.execPath,
      args: [mcp.scriptPath, "work", "mcp", "serve"],
      env: { MESSAGING_STORE: env.MESSAGING_STORE },
    })
    expect(json(stdout).next).toEqual([expect.objectContaining({ step: "mcp.config", command: "mcp config" })])

    const pretty = await call(["mcp", "config"], async () => fake, env, { mcp, tty: true })
    expect(JSON.parse(pretty.stdout.join("\n")).mcpServers["chat-default"].args).toEqual([
      mcp.scriptPath,
      "default",
      "mcp",
      "serve",
    ])
  })

  it("**mcp --help suggests an mcp add line that names the profile and serve**", async () => {
    const help = (await call(["mcp", "--help"], async () => fake, sandbox())).stdout.join("\n").replace(/\s+/g, " ")
    expect(help).toContain("claude mcp add chat -- chat <profile> mcp serve")
  })

  it("**mcp alone shows its commands and serves nothing** (WC-CMD-3)", async () => {
    const terminal = await call(["mcp"], async () => fake, sandbox(), { tty: true })
    const machine = await call(["mcp", "--json"], async () => fake, sandbox())

    expect(terminal.code).toBe(2)
    expect(terminal.stderr.join("\n")).toContain("serve")
    expect(machine.code).toBe(2)
    expect(json(machine.stderr).error).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("--help"),
    })
  })

  it("refuse a script in npx's cache", async () => {
    const env = sandbox()
    const mcp = { execPath: "/usr/bin/node", scriptPath: "/usr/lib/chat/bin/chat.js" }
    const npx = await call(["mcp", "config"], async () => fake, env, {
      mcp: { ...mcp, scriptPath: "/home/o/.npm/_npx/abc/node_modules/chat/bin/chat.js" },
    })
    expect(npx.code).toBe(2)
    expect(npx.stderr.join("\n")).toContain("npx's cache")
  })

  it("**page a listing the same way in every format**: the envelope, JSON lines, and a table with a note", async () => {
    const env = sandbox()
    const paged: MessengerAdapter = { ...fake, chats: async () => ({ items: [chat], hasMore: true }) }
    const online = async () => paged

    const envelope = await call(["chats", "list", "--limit", "1", "--page", "2", "--json"], online, env)
    expect(json(envelope.stdout)).toMatchObject({
      page: { limit: 1, has_more: true },
      next: [{ step: "page.next", args: { page: 3, limit: 1 } }],
    })

    const lines = await call(["chats", "list", "--limit", "1", "--jsonl"], online, env)
    expect(jsonlData(lines.stdout).map((one) => one.id)).toEqual(["7"])
    expect(lines.stderr.join("\n")).toContain("--page 2")

    const all = await call(["chats", "list", "--all", "--json"], online, env)
    expect(json(all.stdout)).toMatchObject({ page: { has_more: false } })

    const table = await call(["chats", "list", "--limit", "1"], online, env, { tty: true })
    expect(table.code).toBe(0)
    expect(table.stderr.join("\n")).toContain("more exist: chat chats list --page 2 --limit 1")
  })

  it("**chats list refuses a field the messenger cannot filter**, rather than reading every chat", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const busy: MessengerAdapter = {
      ...fake,
      chats: async (window) => {
        asked.push(window)
        return { items: [chat, ...people], hasMore: true }
      },
    }
    const online = async () => busy

    const found = await call(["chats", "list", "kind:dialog", "unread_count>0", "--json"], online, env)

    expect(found.code).toBe(2)
    expect(found.stdout).toEqual([])
    expect(JSON.parse(found.stderr[0] ?? "").error).toMatchObject({ reason: "query.unsupported-field" })
    expect(asked).toEqual([])
  })

  it("**read forward with messages list --after**, from a message id or a moment", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const forward: MessengerAdapter = {
      ...fake,
      historyAfter: async (_chat, window) => {
        asked.push(window.after)
        return { items: thread, hasMore: true }
      },
    }

    const byId = await call(["messages", "list", "7", "id>41", "--limit", "3", "--jsonl"], async () => forward, env)
    await call(
      ["messages", "list", "7", 'date>"2026-09-27T10:00:00Z"', "--limit", "3", "--json"],
      async () => forward,
      env,
    )
    await call(
      ["messages", "list", "7", 'date>="2026-09-27T00:00:00Z"', "--limit", "3", "--json"],
      async () => forward,
      env,
    )
    await call(["messages", "list", "7", 'id>"urn:li:msg:4F2"', "--limit", "3", "--json"], async () => forward, env)
    await call(["messages", "list", "7", "date>2h", "--limit", "3", "--json"], async () => forward, env)

    expect(asked.slice(0, 4)).toEqual([
      { id: "41" },
      { time: Date.parse("2026-09-27T10:00:00Z") },
      { time: Date.parse("2026-09-27") },
      { id: "urn:li:msg:4F2" },
    ])
    expect(asked[4]).toEqual({ time: expect.any(Number) })
    expect(byId.stderr.join("\n")).toContain("--cursor after:3")
  })

  it("**read back from a moment with messages list --before-time**; a messenger that cannot is refused", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const back: MessengerAdapter = {
      ...fake,
      historyBefore: async (_chat, window) => {
        asked.push(window)
        return { items: thread, hasMore: false }
      },
    }

    const read = await call(["messages", "list", "7", 'date<"2026-09-27T10:00:00Z"', "--json"], async () => back, env)
    const unable = await call(["messages", "list", "7", "date<2h"], async () => fake, env)
    const both = await call(["messages", "list", "7", "date<2h", "id<5"], async () => back, env)

    expect(read.code).toBe(0)
    expect(asked).toEqual([{ limit: expect.any(Number), time: Date.parse("2026-09-27T10:00:00Z") }])
    expect([unable.code, unable.stderr.join("\n")]).toEqual([2, expect.stringContaining("read back from a time")])
    expect(both.code).toBe(2)
  })

  it("refuses --before with --after, --after offline, and a messenger that cannot read forward", async () => {
    const env = sandbox()
    const online = async () => fake

    expect((await call(["messages", "list", "7", "id<5", "id>2"], online, env)).code).toBe(2)
    expect((await call(["messages", "list", "7", "id<5", "--cursor", "after:2"], online, env)).code).toBe(2)
    expect((await call(["messages", "list", "7", "id:5 OR topic:2"], online, env)).code).toBe(2)
    expect((await call(["messages", "list", "7", "book"], online, env)).code).toBe(2)
    expect((await call(["messages", "list", "7", "id>2", "--offline"], online, env)).code).toBe(2)
    const unable = await call(["messages", "list", "7", "id>2"], online, env)
    expect([unable.code, unable.stderr.join("\n")]).toEqual([2, expect.stringContaining("read forward")])
    for (const [bad, why] of [
      ["date>2026-13-45", "query.invalid-date"],
      ["id:42", "query.unsupported-operator"],
      ["kind:group", "query.unknown-field"],
    ] as const) {
      const refused = await call(["messages", "list", "7", bad, "--json"], online, env)
      expect([refused.code, refused.stdout.join("") + refused.stderr.join("")]).toEqual([
        2,
        expect.stringContaining(why),
      ])
    }
    const cursor = await call(["messages", "list", "7", "--cursor", "sideways:4"], online, env)
    expect([cursor.code, cursor.stderr.join("\n")]).toEqual([2, expect.stringContaining("--cursor takes")])
  })

  it("**chats events** asks from 7 days back, keeps the --event names, and says when it was cut short", async () => {
    const env = sandbox()
    const asked: number[] = []
    const events: MessengerAdapter = {
      ...fake,
      chatEvents: async (_chat, { since }) => {
        asked.push(since)
        return {
          chatId: "7",
          since: new Date(since).toISOString(),
          more: true,
          events: [
            { messageId: "1", timestamp: message.timestamp, event: "join", by: { id: "9", name: "Olga" }, people: [] },
            { messageId: "2", timestamp: message.timestamp, event: "pin", by: { id: "9", name: "Olga" }, people: [] },
          ],
        }
      },
    }
    const online = async () => events

    const all = await call(["chats", "events", "7", "--json"], online, env)
    const day = await call(["chats", "events", "7", "time>=1d", "--jsonl"], online, env)
    const typed = await call(["chats", "events", "7", "type:join"], online, env)

    expect(Date.now() - (asked[0] ?? 0)).toBeGreaterThanOrEqual(7 * 86_400_000 - 5000)
    expect(Date.now() - (asked[1] ?? 0)).toBeLessThan(86_400_000 + 5000)
    expect(json(all.stdout)).toMatchObject({ meta: { truncated: true } })
    expect(json(all.stdout).items).toHaveLength(2)
    expect(jsonlData(day.stdout).map((one) => one.type)).toEqual(["join", "pin"])
    expect(day.stderr.join("\n")).toContain("more history")
    expect(typed.code).toBe(2)
    expect((await call(["chats", "events", "7"], async () => fake, env)).code).toBe(2)
  })

  it("**chats members list** pages a group's members like every listing, and refuses a messenger without it", async () => {
    const env = sandbox()
    const windows: unknown[] = []
    const group: MessengerAdapter = {
      ...fake,
      members: async (_chat, window) => {
        windows.push(window)
        return { chatId: "7", items: [{ id: "9", name: "Olga", username: null, role: "admin" }], hasMore: true }
      },
    }
    const online = async () => group

    const page = await call(["chats", "members", "list", "7", "--limit", "1", "--page", "2", "--json"], online, env)
    await call(["chats", "members", "list", "7", "--all", "--json"], online, env)

    expect(json(page.stdout)).toMatchObject({
      items: [{ id: "9", role: "admin" }],
      page: { limit: 1, has_more: true },
      next: [{ step: "page.next", args: { chat: "7", page: 3 } }],
    })
    expect(windows).toEqual([{ limit: 1, offset: 1 }, { offset: 0 }])
    expect((await call(["chats", "members", "list", "7"], async () => fake, env)).code).toBe(2)
  })

  it("**contacts lookup** reads the number from stdin, never argv, and refuses what is not a number", async () => {
    const env = sandbox()
    const phones: string[] = []
    const finder: MessengerAdapter = {
      ...fake,
      lookup: async (phone) => {
        phones.push(phone)
        return { id: "21", name: "Adam", username: "adam_k" }
      },
    }
    const piped = (text: string) => ({ stdin: Object.assign(Readable.from([text]), { isTTY: false }) })

    const found = await call(["contacts", "lookup", "--json"], async () => finder, env, piped("+34 600-123 456\n"))
    const typo = await call(["contacts", "lookup"], async () => finder, env, piped("call me"))
    const inArgv = await call(["contacts", "lookup", "34600123456"], async () => finder, env, piped(""))

    expect(v.safeParse(ENTITIES.contact_lookup, json(found.stdout).item).success).toBe(true)
    expect(json(found.stdout).item).toEqual({ id: "21", name: "Adam", username: "adam_k" })
    const unknown = await call(["contacts", "lookup", "--json=phone"], async () => finder, env, piped(""))
    expect(unknown.code).toBe(2)
    expect(unknown.stdout).toEqual([])
    expect(JSON.parse(unknown.stderr.at(-1) ?? "{}").error.reason).toBe("output.unknown-field")
    expect(phones).toEqual(["34600123456"])
    expect([typo.code, inArgv.code]).toEqual([2, 2])
    expect(inArgv.stderr.join("\n")).not.toContain("600123456")

    const spaced = await call(["contacts", "lookup", "+34", "600", "123", "456"], async () => finder, env, piped(""))
    expect(spaced.code).toBe(2)
    const kept = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? kept(join(dir, entry.name)) : [readFileSync(join(dir, entry.name), "utf8")],
      )
    const records = kept(join(env.CHAT_STATE_DIR ?? "", "runs")).join("\n")
    expect(records).toContain('"argv":["contacts","lookup","[redacted]","[redacted]","[redacted]","[redacted]"]')
    expect(records).not.toMatch(/"600"|34600123456/)
  })

  it("**contacts sync** keeps the contact list in the store and counts what was new or changed", async () => {
    const env = sandbox()
    let people: AddressBookEntry[] = [{ id: "21", name: "Adam", username: "adam_k", phone: "+34600000021" }]
    const book: MessengerAdapter = { ...fake, addressBook: async () => people }

    const first = await call(["contacts", "sync", "--json"], async () => book, env)
    people = [
      { id: "21", name: "Adam K.", username: "adam_k" },
      { id: "22", name: "Bea", username: null },
    ]
    const second = await call(["contacts", "sync", "--json"], async () => book, env)

    expect(v.safeParse(ENTITIES.contact_sync, json(first.stdout).item).success).toBe(true)
    expect(v.safeParse(ENTITIES.contact_sync, json(second.stdout).item).success).toBe(true)
    expect(json(first.stdout).item).toEqual({ added: 1, changed: 0, known: 1 })
    expect(json(second.stdout).item).toEqual({ added: 1, changed: 1, known: 2 })
    const store = await openStore({ path: env.MESSAGING_STORE })
    expect(await store.people.phoneOf({ provider: "chat", account: "500" }, "21")).toBe("+34600000021")
    expect(await store.people.phoneOf({ provider: "chat", account: "500" }, "22")).toBeNull()
    await store.close()
  })

  it("**account sessions list** shows where the account is logged in, and a messenger without it refuses", async () => {
    const env = sandbox()
    const devices: MessengerAdapter = {
      ...fake,
      sessions: async () => [
        { current: true, client: "tg 1.0", device: "Linux", location: "Valencia, ES", lastActiveAt: null },
        { current: false, client: "Telegram iOS 11.2", device: "iPhone", location: null, lastActiveAt: null },
      ],
    }

    const listed = await call(["account", "sessions", "list", "--json"], async () => devices, env)
    const lines = await call(["account", "sessions", "list", "--jsonl"], async () => devices, env)

    expect(json(listed.stdout).items.map((one: { current: boolean }) => one.current)).toEqual([true, false])
    expect(v.parse(listEnvelopeSchema(ENTITIES.account_session), json(listed.stdout)).items[0]).toMatchObject({
      last_active_at: null,
    })
    expect(jsonlData(lines.stdout)).toHaveLength(2)
    expect((await call(["account", "sessions", "list"], async () => fake, env)).code).toBe(2)
  })

  it("**chats inspect** answers what a link leads to, and refuses offline and without the method", async () => {
    const env = sandbox()
    const links: string[] = []
    const reader: MessengerAdapter = {
      ...fake,
      inspect: async (link) => {
        links.push(link)
        return {
          kind: "group",
          title: "Book club",
          id: null,
          username: null,
          participantsCount: 40,
          description: null,
          member: false,
          approvalNeeded: true,
        }
      },
    }

    const found = await call(["chats", "inspect", "https://t.me/+abc", "--json"], async () => reader, env)

    expect(json(found.stdout).item).toMatchObject({ title: "Book club", member: false, approval_needed: true })
    expect(links).toEqual(["https://t.me/+abc"])
    const projected = await call(
      ["chats", "inspect", "https://t.me/+abc", "--json=title,approval_needed"],
      async () => reader,
      env,
    )
    expect(projected.code, projected.stderr.join(" ")).toBe(0)
    expect(json(projected.stdout).item).toEqual({ title: "Book club", approval_needed: true })
    const connected = links.length
    const unknown = await call(
      ["chats", "inspect", "https://t.me/+abc", "--json=unknown_field"],
      async () => reader,
      env,
    )
    expect(unknown.code).not.toBe(0)
    expect(links).toHaveLength(connected)

    expect((await call(["chats", "inspect", "x", "--offline"], async () => reader, env)).code).toBe(2)
    expect((await call(["chats", "inspect", "x"], async () => fake, env)).code).toBe(2)
  })

  it("**topics list and search** page a forum's topics, search passing its words on", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const forum: MessengerAdapter = {
      ...fake,
      topics: async (_chat, window) => {
        asked.push(window)
        const topic = {
          id: "4",
          title: "Pisos",
          closed: false,
          pinned: true,
          unreadCount: 2,
          lastMessageAt: null,
          createdAt: null,
        }
        return { items: [topic], hasMore: false }
      },
    }
    const online = async () => forum

    const listed = await call(["topics", "list", "7", "--limit", "5", "--json"], online, env)
    await call(["search", "topics", "7", "pisos", "--json"], online, env)
    const filtered = await call(
      ["topics", "list", "7", 'title:"Book club"', "--limit", "1", "--page", "2", "--json"],
      online,
      env,
    )
    expect(filtered.code, filtered.stderr.join("\n")).toBe(0)
    expect(
      (
        await call(
          ["topics", "list", "7", "closed:true"],
          async () => {
            throw new Error("unsupported filters must not connect")
          },
          env,
        )
      ).code,
    ).toBe(2)

    expect(json(listed.stdout).items).toEqual([expect.objectContaining({ id: "4", pinned: true })])
    expect(asked).toEqual([
      { limit: 5, offset: 0 },
      { limit: 20, offset: 0, search: "pisos" },
      { limit: 1, offset: 1, search: "Book club" },
    ])
    expect((await call(["topics", "list", "7"], async () => fake, env)).code).toBe(2)
  })

  it("**topics show** answers one forum topic, only where the messenger lists it", async () => {
    const env = sandbox()
    const topic = {
      id: "4",
      title: "Pisos",
      closed: true,
      pinned: false,
      unreadCount: 0,
      lastMessageAt: null,
      createdAt: null,
    }
    const forum: MessengerAdapter = { ...fake, topic: async (_chat, topicId) => ({ ...topic, id: topicId }) }
    const show = (argv: string[], adapter: MessengerAdapter, own: Partial<Messenger> = { topicShow: true }) =>
      call(["topics", "show", ...argv], async () => adapter, env, {}, own)

    const shown = await show(["7", "4", "--json"], forum)

    expect(json(shown.stdout).item).toEqual({
      id: "4",
      title: "Pisos",
      closed: true,
      pinned: false,
      unread_count: 0,
      last_message_at: null,
      created_at: null,
      untrusted: ["title"],
    })
    expect((await show(["7", "4", "--offline"], forum)).code).toBe(2)
    expect((await show(["7", " "], forum)).code).toBe(2)
    expect((await show(["7", "4"], fake)).code).toBe(2)
    expect((await show(["7", "4"], forum, {})).code).not.toBe(0)
  })

  it("refuses a --search under 3 characters and an unknown --kind, before connecting", async () => {
    const env = sandbox()
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("must not connect")
    }

    expect((await call(["chats", "list", "--search", "zo"], never, env)).code).toBe(2)
    expect((await call(["chats", "list", "--kind", "bot"], never, env)).code).toBe(2)
  })

  it("**print one message per line** from `messages list` and `search messages` with --jsonl", async () => {
    const env = sandbox()
    const online = async (): Promise<MessengerAdapter> => ({
      ...fake,
      history: async () => ({ items: thread, hasMore: true }),
    })

    const listed = await call(["messages", "list", "7", "--jsonl"], online, env)
    expect(jsonlData(listed.stdout).map((one) => one.id)).toEqual(["1", "2", "3"])
    expect(listed.stderr.join("\n")).toContain("--cursor before:1")

    const found = await call(["search", "messages", "chapter", "--jsonl"], online, env)
    expect(jsonlData(found.stdout).map((one) => one.ref.split("/").at(-1))).toEqual(["3", "2", "1"])
  })
})

describe("every list in --json", () => {
  it("**answers { items, page, limit, hasMore }**, never a bare array or a shape of its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_CACHE_DIR: join(root, "cache"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const lists: MessengerAdapter = {
      ...fake,
      scheduled: async () => [message],
      sessions: async () => [],
      topics: async () => ({ items: [], hasMore: false }),
      folders: async () => [],
      members: async () => ({ items: [], hasMore: false, chatId: "7" }),
      chatEvents: async () => ({ chatId: "7", since: "2026-09-20T00:00:00.000Z", events: [], more: false }),
    }
    const online = async () => lists

    for (const argv of [
      ["chats", "list"],
      ["chats", "members", "list", "7"],
      ["chats", "folders", "list"],
      ["chats", "events", "7"],
      ["contacts", "list"],
      ["topics", "list", "7"],
    ]) {
      const { code, stdout, stderr } = await call([...argv, "--json"], online, env)
      expect([argv.join(" "), code, stderr.join("\n")]).toEqual([argv.join(" "), 0, expect.any(String)])
      expect([argv.join(" "), JSON.parse(stdout[0] ?? "null")]).toEqual([
        argv.join(" "),
        expect.objectContaining({ items: expect.any(Array), page: expect.objectContaining({ has_more: false }) }),
      ])
    }
    // search messages is the search session's to change, and still answers without `page`.
    for (const argv of [
      ["messages", "list", "7"],
      ["messages", "context", "7", "2"],
      ["messages", "scheduled", "7"],
      ["account", "sessions", "list"],
      ["models", "list", "kind:audio"],
      ["store", "status"],
      ["store", "jobs", "list"],
      ["sends", "list"],
      ["recipients", "list"],
    ]) {
      const { code, stdout, stderr } = await call([...argv, "--json"], online, env)
      expect([argv.join(" "), code, stderr.join("\n")]).toEqual([argv.join(" "), 0, expect.any(String)])
      const keys = Object.keys(JSON.parse(stdout[0] ?? "null") ?? {})
      expect([argv.join(" "), keys]).toEqual([
        argv.join(" "),
        expect.arrayContaining(
          keys.includes("meta") ? ["items", "page", "meta"] : ["items", "page", "limit", "hasMore"],
        ),
      ])
    }
  })
})

describe("message link command", () => {
  it("prints one account-scoped result in JSON and JSONL, and closes on a provider error", async () => {
    const root = mkdtempSync(join(tmpdir(), "link-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    rememberAccount(app, "default", "500", env)
    const close = vi.fn(async () => {})
    const permalink = vi.fn(async () => ({
      url: "https://provider.example/1",
      access: "restricted" as const,
      reason: null,
    }))
    const connect = vi.fn(async () => ({ ...fake, permalink, close }))
    for (const flag of ["--json", "--jsonl"]) {
      const result = await call(["messages", "link", "msg:chat/500/7/1", flag], connect, env)
      expect(result.code).toBe(0)
      expect(result.stdout).toHaveLength(flag === "--json" ? 1 : 2)
      const answer = flag === "--json" ? JSON.parse(result.stdout.join("")).item : jsonlData(result.stdout)[0]
      expect(answer).toEqual({
        ref: "msg:chat/500/7/1",
        url: "https://provider.example/1",
        access: "restricted",
        reason: null,
      })
      expect(result.stderr.join("")).toBe("")
    }
    const mismatch = await call(["messages", "link", "msg:chat/other/7/1", "--json"], connect, env)
    expect(mismatch.code).not.toBe(0)
    expect(connect).toHaveBeenCalledTimes(2)
    permalink.mockRejectedValueOnce(new CliError("permission_error", "synthetic denied"))
    const denied = await call(["messages", "link", "7", "1", "--json"], connect, env)
    expect(denied.code).not.toBe(0)
    expect(denied.stdout).toEqual([])
    expect(close).toHaveBeenCalledTimes(3)
  })
})

describe("sender identity commands", () => {
  it("lists identities as one envelope and sends text as one of them", async () => {
    const root = mkdtempSync(join(tmpdir(), "send-as-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const identities = [
      { id: "500", title: "Owner", kind: "self" as const, premiumRequired: false, default: true },
      { id: "-1002", title: "Synthetic channel", kind: "channel" as const, premiumRequired: true, default: false },
    ]
    const send = vi.fn(async (chatId: string, text: string, options: { sendId: string }) => ({
      sendId: options.sendId,
      message: { ...message, id: "4", chatId, text },
    }))
    const connect = vi.fn(async () => ({ ...fake, sendAsIdentities: async () => identities, send }))

    const listed = await call(["chats", "send-as", "7", "--json"], connect, env)
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout.join(""))).toMatchObject({
      items: identities.map(({ premiumRequired, ...one }) => ({ ...one, premium_required: premiumRequired })),
      page: { limit: 2, has_more: false },
    })

    const sent = await call(["messages", "send", "7", "hi", "--send-as", "-1002", "--json"], connect, env)
    expect(sent.code).toBe(0)
    expect(send).toHaveBeenCalledWith("7", "hi", expect.objectContaining({ sendAs: "-1002" }))

    const blank = await call(["messages", "send", "7", "hi", "--send-as", " ", "--json"], connect, env)
    expect(blank.code).not.toBe(0)
    expect(send).toHaveBeenCalledOnce()
  })
})

describe("topics delete", () => {
  it("asks first: refused with nobody to answer, done with --allow-dangerous, journaled by topic id", async () => {
    const root = mkdtempSync(join(tmpdir(), "topic-delete-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const deleteTopic = vi.fn(async () => {})
    const connect = vi.fn(async () => ({ ...fake, deleteTopic }))

    const unasked = await call(["topics", "delete", "7", "12", "--json"], connect, env)
    const done = await call(["topics", "delete", "7", "12", "--allow-dangerous", "--json"], connect, env)
    const general = await call(["topics", "delete", "7", "1", "--allow-dangerous", "--json"], connect, env)

    expect(unasked.stderr.join("\n")).toContain("--allow-dangerous")
    expect(JSON.parse(done.stdout[0] ?? "").item).toEqual({
      operation_id: expect.any(String),
      chat_id: "7",
      topic_id: "12",
    })
    expect(general.stderr.join("\n")).toContain("General topic cannot be deleted")
    expect(deleteTopic.mock.calls).toEqual([["7", "12"]])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { action: "topic-delete", key: "topics.delete", threadId: "12", outcome: "refused" },
      { action: "topic-delete", key: "topics.delete", threadId: "12", outcome: "sent" },
    ])
  })
})

describe("topics edit", () => {
  it("passes a title and on/off as closed, and refuses another word", async () => {
    const root = mkdtempSync(join(tmpdir(), "topic-edit-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const topic = {
      id: "12",
      title: "t",
      closed: true,
      pinned: false,
      unreadCount: 0,
      lastMessageAt: null,
      createdAt: null,
    }
    const editTopic = vi.fn(async () => topic)
    const connect = vi.fn(async () => ({ ...fake, editTopic }))

    const closed = await call(["topics", "edit", "7", "12", "--closed", "on", "--title", "t", "--json"], connect, env)
    expect(closed.code).toBe(0)
    expect(JSON.parse(closed.stdout.join("")).item).toMatchObject({
      chat_id: "7",
      topic: { id: "12", closed: true, unread_count: 0 },
    })
    expect(editTopic).toHaveBeenCalledWith("7", "12", { title: "t", closed: true })

    const reopened = await call(["topics", "edit", "7", "12", "--closed", "off", "--json"], connect, env)
    expect(reopened.code).toBe(0)
    expect(editTopic).toHaveBeenLastCalledWith("7", "12", { closed: false })

    const pinned = await call(["topics", "edit", "7", "12", "--pinned", "on", "--json"], connect, env)
    expect(pinned.code).toBe(0)
    expect(editTopic).toHaveBeenLastCalledWith("7", "12", { pinned: true })

    const icon = await call(["topics", "edit", "7", "12", "--emoji", "🤖", "--json"], connect, env)
    expect(icon.code).toBe(0)
    expect(editTopic).toHaveBeenLastCalledWith("7", "12", { icon: "🤖" })

    const removed = await call(["topics", "edit", "7", "12", "--emoji", "none", "--json"], connect, env)
    expect(removed.code).toBe(0)
    expect(editTopic).toHaveBeenLastCalledWith("7", "12", { icon: null })

    for (const flag of ["--closed", "--pinned"]) {
      const wrong = await call(["topics", "edit", "7", "12", flag, "yes", "--json"], connect, env)
      expect(wrong.code).not.toBe(0)
    }
    expect(editTopic).toHaveBeenCalledTimes(5)
  })
})

describe("topics icons list", () => {
  it("lists the emojis, one per line for a person and as items in JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "topic-icons-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const connect = vi.fn(async () => ({ ...fake, topicIcons: async () => ["🤖", "📰"] }))

    const json = await call(["topics", "icons", "list", "--json"], connect, env)
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout.join("")).items).toEqual([{ emoji: "🤖" }, { emoji: "📰" }])

    const text = await call(["topics", "icons", "list"], connect, env, { tty: true })
    expect(text.stdout.join("")).toContain("🤖\n📰\n")
  })
})

describe("messages comments", () => {
  it("prints the discussion and the comments in each format, with a note for more", async () => {
    const root = mkdtempSync(join(tmpdir(), "comments-cli-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const discussion = { chatId: "-1002", messageId: "900" }
    const comment = { ...message, id: "901", chatId: "-1002", text: "synthetic comment" }
    const comments = vi.fn(async () => ({ items: [comment], hasMore: true }))
    const connect = vi.fn(async () => ({ ...fake, discussionOf: async () => discussion, comments }))

    const json = await call(["messages", "comments", "7", "42", "id<950", "--limit", "5", "--json"], connect, env)
    expect(json.code).toBe(0)
    const answer = JSON.parse(json.stdout.join(""))
    expect(answer.items).toMatchObject([{ id: "901", chat_id: "-1002", ref: "msg:chat/500/-1002/901" }])
    expect(answer.page).toEqual({ mode: "cursor", limit: 5, has_more: true, next_cursor: "before:901" })
    expect(answer.next[0]).toMatchObject({
      step: "page.next",
      args: { chat: "7", post: "42", query: "id<950", cursor: "before:901" },
    })
    expect(comments).toHaveBeenCalledWith("7", "42", { limit: 5, before: "950" })

    const jsonl = await call(["messages", "comments", "7", "42", "--jsonl"], connect, env)
    expect(jsonlData(jsonl.stdout)[0]).toMatchObject({ id: "901" })

    const pretty = await call(["messages", "comments", "7", "42"], connect, env)
    expect(pretty.code).toBe(0)
    expect(pretty.stdout.join("")).toContain("synthetic comment")
  })
})

describe("the messages reads answer in the envelope of their entity", () => {
  it.each([
    [["messages", "list", "Book"], "message", true],
    [["messages", "list", "Book", "id<9"], "message", true],
    [["messages", "context", "Book", "2"], "message", true],
    [["messages", "show", "Book", "2"], "message", false],
    [["messages", "comments", "7", "42", "id<950"], "message", true],
    [["messages", "scheduled", "7"], "message", true],
    [["messages", "link", "7", "1"], "message_link", false],
  ] as const)("%j answers a %s", async (argv, entity, list) => {
    const root = mkdtempSync(join(tmpdir(), "contract-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    rememberAccount(app, "default", "500", env)
    const adapter: MessengerAdapter = {
      ...fake,
      scheduled: async () => [{ ...message, scheduledFor: "2030-01-01T09:00:00.000Z" }],
      discussionOf: async () => ({ chatId: "-1002", messageId: "900" }),
      comments: async () => ({ items: [{ ...message, id: "901", chatId: "-1002" }], hasMore: true }),
      permalink: async () => ({ url: "https://provider.example/1", access: "restricted" as const, reason: null }),
    }
    const answer = await call([...argv, "--json"], async () => adapter, env)
    expect([answer.code, answer.stderr.join("\n")]).toEqual([0, expect.any(String)])
    const schema = ENTITIES[entity] as v.GenericSchema
    const parsed = v.safeParse(
      list ? listEnvelopeSchema(schema) : itemEnvelopeSchema(schema),
      JSON.parse(answer.stdout[0] ?? ""),
    )
    expect(parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)).toBeUndefined()
  })
})

it("declares both star receipts and refuses unknown fields before changing a star", async () => {
  const root = mkdtempSync(join(tmpdir(), "message-star-entity-"))
  const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
  const writes: boolean[] = []
  const adapter: MessengerAdapter = {
    ...fake,
    star: async (_chat, _message, starred) => {
      writes.push(starred)
    },
  }
  for (const name of ["star", "unstar"]) {
    const result = await call(
      ["messages", name, "Book", "3", "--json"],
      async () => adapter,
      env,
      {},
      { messageStars: true },
    )
    expect(result.code).toBe(0)
    expect(v.safeParse(ENTITIES.message_star, JSON.parse(result.stdout[0] ?? "").item).success).toBe(true)
  }
  const projected = await call(
    ["messages", "star", "Book", "3", "--json=starred"],
    async () => adapter,
    env,
    {},
    { messageStars: true },
  )
  expect(JSON.parse(projected.stdout[0] ?? "").item).toEqual({ operation_id: expect.any(String), starred: true })
  const invalid = await call(
    ["messages", "unstar", "Book", "3", "--json=missing"],
    async () => adapter,
    env,
    {},
    { messageStars: true },
  )
  expect(invalid.code).toBe(2)
  expect(writes).toEqual([true, false, true])
})
