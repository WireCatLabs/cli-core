import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { beforeEach, describe, expect, it } from "vitest"
import { parseMarkdown } from "../../domain/markdown.js"
import type { Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import { SendJournal } from "../../sends/journal.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import { botCopy } from "./copy.js"
import type { BotAdapter, BotMessenger, BotSendOptions } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let botId: string
let calls: string[]
let sent: { chat: string; text: string; options: BotSendOptions }[]
let next: number

const message = (chatId: string, id: string, text: string): Message => ({
  id,
  chatId,
  senderId: botId,
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

/** A bot over an in-memory chat; `history: false` is a messenger whose Bot API reads nothing back (Telegram). */
const adapterFor = ({ history = true, edit = true } = {}): BotAdapter => ({
  formatMarkdown: async (text: string) => {
    const parsed = parseMarkdown(text)
    return { text: parsed.text, spans: parsed.markup }
  },
  me: async () => ({ id: botId, name: "Sales", username: "sales_bot" }),
  close: async () => {},
  send: async (chat, text, options) => {
    sent.push({ chat, text, options })
    return message(chat.startsWith("user:") ? "500" : chat, String(next++), text)
  },
  ...(edit ? { edit: async (chat: string, id: string, text: string) => message(chat, id, text) } : {}),
  delete: async (chat, ids) => {
    calls.push(`delete ${chat} ${ids.join(",")}`)
  },
  pin: async (chat, id, { notify }) => {
    calls.push(`pin ${chat} ${id}${notify ? " notify" : ""}`)
  },
  unpin: async (chat, id) => {
    calls.push(`unpin ${chat} ${id}`)
  },
  chat: async (chat) => ({
    id: chat,
    title: `Chat ${chat}`,
    kind: "group",
    unreadCount: null,
    lastMessageAt: null,
    participantsCount: 3,
  }),
  leave: async (chat) => {
    calls.push(`leave ${chat}`)
  },
  action: async (chat, action) => {
    calls.push(`action ${chat} ${action}`)
  },
  admins: async () => [
    { id: "1", name: "Olga", username: null, role: "owner", rights: ["members", "admins", "pin"], title: null },
  ],
  addAdmin: async (chat, person, rights, { title }) => {
    calls.push(`admin ${chat} ${person} ${rights.join(",")}${title ? ` "${title}"` : ""}`)
  },
  removeAdmin: async (chat, person) => {
    calls.push(`unadmin ${chat} ${person}`)
  },
  removeMember: async (chat, person, { block }) => {
    calls.push(`remove ${chat} ${person}${block ? " block" : ""}`)
  },
  ...(history
    ? {
        senders: () => [{ id: botId, name: "Sales", username: "sales_bot", isBot: true }],
        history: async (chat: string) => [message(chat, "1", "first"), message(chat, "2", "second")],
        message: async (chat: string, id: string) => message(chat, id, "from the messenger"),
      }
    : {}),
})

let adapter: BotAdapter

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
}

const call = async (argv: string[], stdin = "") => {
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [botCommand(bot)] },
    { streams, tty: false, env, stdin: Object.assign(Readable.from([stdin]), { isTTY: false }) },
  )
  const answer = streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined
  return { code, answer, stderr: streams.stderr.join("\n") }
}

const configure = (contents: object) => {
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(join(root, "config", "config.json"), JSON.stringify(contents))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-messages-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  botId = `bot${Math.floor(Math.random() * 1e9)}`
  calls = []
  sent = []
  next = 100
  adapter = adapterFor()
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("token")
  new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])
})

const journal = () => new SendJournal(botFiles(app, "sales", env).journal).entries()

describe("bot messages send", () => {
  it("**sends to a seen chat by its title**, journals it without the text, and keeps it", async () => {
    const done = await call(["sales", "bot", "messages", "send", "Team", "Hello", "--json"])

    expect(done.code).toBe(0)
    expect(done.answer.item).toMatchObject({
      operation_id: expect.any(String),
      message: { chat_id: "-100", text: "Hello" },
    })
    expect(sent).toMatchObject([{ chat: "-100", text: "Hello" }])
    expect(journal()).toMatchObject([{ chatId: "-100", kind: "message", outcome: "sent", messageId: "100", length: 5 }])
    expect(JSON.stringify(journal())).not.toContain("Hello")
    const kept = await call(["sales", "bot", "messages", "show", "Team", "100", "--offline", "--json"])
    expect(v.parse(itemEnvelopeSchema(ENTITIES.message), kept.answer).item).toMatchObject({ id: "100", text: "Hello" })
  })

  it("reads the text from stdin, marks it up with --md, and refuses --md with --html", async () => {
    await call(["sales", "bot", "messages", "send", "user:7", "--md", "--json"], "**big**")
    expect(sent).toMatchObject([{ chat: "user:7", text: "big", options: { formatting: [expect.any(Object)] } }])

    expect((await call(["sales", "bot", "messages", "send", "-100", "x", "--md", "--html"])).code).toBe(2)
  })

  it("**refuses a chat that is not on the bot's recipient list**, before anything goes", async () => {
    await call(["sales", "bot", "recipients", "add", "user:7"])
    const refused = await call(["sales", "bot", "messages", "send", "Team", "Hello", "--json"])

    expect(refused.code).toBe(7)
    expect(refused.stderr).toContain("chat sales bot recipients add")
    expect(sent).toEqual([])
    expect(journal()).toMatchObject([{ chatId: "-100", outcome: "refused" }])
  })

  it("**refuses when the bot is read-only**, and leaves the personal account writing", async () => {
    configure({ bot: { profiles: { sales: { permissions: { bot: "readonly" } } } } })
    const refused = await call(["sales", "bot", "messages", "send", "Team", "Hello", "--json"])

    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain("bot.messages.send")
    expect(refused.stderr).toContain("chat sales config set --bot permissions.bot.messages.send allow")
    expect(sent).toEqual([])
  })
})

describe("bot messages list and show", () => {
  it("**asks the messenger where its Bot API has a history**, and keeps what it answered", async () => {
    const listed = await call(["sales", "bot", "messages", "list", "Team", "--limit", "2", "--json"])

    expect(listed.answer.items.map((item: Message) => item.text)).toEqual(["first", "second"])
    const handles = await botCopy("chat-bot").read((store) =>
      store.conversations.senderHandles({ provider: "chat-bot", account: botId }, "-100"),
    )
    expect(handles.get("sales_bot")).toBe(botId)
    expect((await call(["sales", "bot", "messages", "show", "Team", "2", "--json"])).answer.item.text).toBe(
      "from the messenger",
    )
  })

  it("**answers from the bot's own copy where the messenger has no history**, and says so", async () => {
    adapter = adapterFor({ history: false })
    await call(["sales", "bot", "messages", "send", "Team", "kept"])
    const listed = await call(["sales", "bot", "messages", "list", "Team", "--json"])

    expect(listed.answer.items.map((item: Message) => item.text)).toEqual(["kept"])
    expect(listed.stderr).toContain("gives a bot no history")
    expect((await call(["sales", "bot", "messages", "show", "Team", "999", "--json"])).code).toBe(6)
  })

  it("**says what fills the copy** when nothing is kept yet, rather than printing an empty list", async () => {
    const empty = await call(["sales", "bot", "messages", "list", "Team", "--offline", "--json"])

    expect(empty.code).toBe(6)
    expect(empty.stderr).toContain("chat sales bot messages list <chat>` once")
  })
})

describe("bot messages edit, delete, pin", () => {
  it("**asks before a delete**, deletes with --allow-dangerous, and forgets it in the copy", async () => {
    await call(["sales", "bot", "messages", "send", "Team", "gone soon"])

    expect((await call(["sales", "bot", "messages", "delete", "Team", "100", "--json"])).code).toBe(7)
    expect(calls).toEqual([])
    const deleted = await call(["sales", "bot", "messages", "delete", "Team", "100", "--allow-dangerous", "--json"])
    expect(deleted.answer.item).toMatchObject({ chat_id: "-100", deleted: ["100"] })
    expect(calls).toEqual(["delete -100 100"])
    expect((await call(["sales", "bot", "messages", "show", "Team", "100", "--offline", "--json"])).code).toBe(6)
  })

  it("pins quietly unless --notify, unpins, and says which bot cannot edit", async () => {
    await call(["sales", "bot", "messages", "pin", "Team", "5", "--notify"])
    await call(["sales", "bot", "messages", "unpin", "Team", "5"])
    expect(calls).toEqual(["pin -100 5 notify", "unpin -100 5"])

    adapter = adapterFor({ edit: false })
    const refused = await call(["sales", "bot", "messages", "edit", "Team", "5", "new", "--json"])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("a Chat bot cannot edit messages")
  })
})

describe("bot chats show, leave, action", () => {
  it("**remembers a chat it was shown**, leaves one, and shows an action", async () => {
    expect((await call(["sales", "bot", "chats", "show", "-200", "--json"])).answer.item).toMatchObject({ id: "-200" })
    expect(
      (await call(["sales", "bot", "chats", "list", "--json"])).answer.items.map((chat: { id: string }) => chat.id),
    ).toContain("-200")

    await call(["sales", "bot", "chats", "leave", "Team"])
    await call(["sales", "bot", "chats", "action", "Team", "typing"])
    expect(calls).toEqual(["leave -100", "action -100 typing"])
    expect((await call(["sales", "bot", "chats", "action", "Team", "dancing"])).code).not.toBe(0)
  })
})

describe("bot chats admins and members", () => {
  it("**lists a chat's admins with their rights**, makes one with a title, and takes the rights back", async () => {
    const listed = await call(["sales", "bot", "chats", "admins", "list", "Team", "--json"])
    expect(listed.answer.items).toEqual([
      { id: "1", name: "Olga", username: null, role: "owner", rights: ["members", "admins", "pin"], title: null },
    ])

    const made = await call([
      "sales",
      "bot",
      "chats",
      "admins",
      "add",
      "Team",
      "91",
      "--can",
      "pin, members",
      "--title",
      "Mod",
      "--json",
    ])
    await call(["sales", "bot", "chats", "admins", "remove", "Team", "91"])

    expect(made.answer.item).toMatchObject({
      chat_id: "-100",
      person_id: "91",
      rights: ["pin", "members"],
      title: "Mod",
    })
    expect(calls).toEqual(['admin -100 91 pin,members "Mod"', "unadmin -100 91"])
    expect(journal()).toMatchObject([
      { chatId: "-100", kind: "chat", action: "admins.add", outcome: "sent" },
      { chatId: "-100", kind: "chat", action: "admins.remove", outcome: "sent" },
    ])
  })

  it("**offers only the rights this messenger has**, and a person only by their id", async () => {
    const telegram = { ...bot, adminRights: ["members", "pin"] as const }
    const streams = captureStreams()
    const code = await run(
      ["sales", "bot", "chats", "admins", "add", "Team", "91", "--can", "read"],
      { app, commands: () => [botCommand(telegram)] },
      { streams, tty: false, env },
    )

    expect(code).toBe(2)
    expect(streams.stderr.join("\n")).toContain("--can takes rights from: members, pin")
    expect((await call(["sales", "bot", "chats", "admins", "add", "Team", "Ivan", "--can", "pin"])).code).toBe(2)
    expect(calls).toEqual([])
  })

  it("**removes a person, and blocks them with --block**", async () => {
    const removed = await call(["sales", "bot", "chats", "members", "remove", "Team", "91", "--json"])
    await call(["sales", "bot", "chats", "members", "remove", "Team", "92", "--block"])

    expect(removed.answer.item).toMatchObject({ chat_id: "-100", removed: ["91"], blocked: false })
    expect(calls).toEqual(["remove -100 91", "remove -100 92 block"])
  })

  it("**refuses when the profile does not let the bot change members**, before anything goes", async () => {
    configure({ bot: { profiles: { sales: { permissions: { "bot.chats.members": "readonly" } } } } })
    const refused = await call(["sales", "bot", "chats", "members", "remove", "Team", "91", "--json"])

    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain("bot.chats.members.remove")
    expect(calls).toEqual([])
  })
})
