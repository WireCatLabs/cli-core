import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { holdLock, lockPath } from "../../background/lock.js"
import type { Chat, Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import { chatsCommand } from "./chats-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { inboxCommand } from "./inbox.js"
import { messagesCommand } from "./messages-command.js"
import type { MessengerAdapter } from "./port.js"
import { reviewCommand } from "./review.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const club: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:02:00.000Z",
  participantsCount: 4,
}
const zoe: Chat = { ...club, id: "20", kind: "dialog", title: "Zoe", participantsCount: 2 }
const thread: Message[] = ["1", "2", "3"].map((id, index) => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${index}:00.000Z`,
  editedAt: null,
  text: "chapter three",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}))

const server = (sent: string[] = []): MessengerAdapter => ({
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [club, zoe], hasMore: false }),
  history: async () => ({ items: thread, hasMore: false }),
  resolve: async (reference) => (reference === "Zoe" ? zoe : club),
  contact: async () => {
    throw new Error("unused")
  },
  chat: async () => ({ ...club, members: [] }),
  around: async () => [],
  send: async (chatId, text, { sendId }) => {
    sent.push(`${chatId}:${text}`)
    return { message: { ...thread[0], text } as Message, sendId }
  },
  logout: async () => {},
  close: async () => {},
})

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "store-mode-"))
  return {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const call = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  connect: Messenger["connect"],
  history?: "store",
  tty = false,
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    ...(history ? { history } : {}),
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        chatsCommand(messenger),
        messagesCommand(messenger),
        contactsCommand(messenger),
        storeCommand(messenger),
        inboxCommand(messenger),
        reviewCommand(messenger),
      ],
    },
    { streams, tty, env },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
}

/** A store filled the way `serve` fills it: a server-mode run saves what it read. */
const filled = async () => {
  const env = sandbox()
  for (const argv of [
    ["chats", "list", "--json"],
    ["messages", "list", "Book", "--json"],
  ]) {
    expect((await call(argv, env, async () => server())).code).toBe(0)
  }
  return env
}

describe("stored evidence command", () => {
  it.each(["--json", "--jsonl"])("returns a complete packet in %s and pages without connecting", async (format) => {
    const env = await filled()
    const connection = pushing()
    const first = await call(["messages", "evidence", "Book", "--limit", "2", format], env, connection.connect)
    expect(first.code).toBe(0)
    expect(first.stderr).toBe("")
    const packet = JSON.parse(first.stdout)
    expect(packet).toMatchObject({
      kind: "chats",
      source: { provider: "chat", account: "500", chat: "7" },
      nextBeforeId: "2",
      coverage: { provided: 2, included: 2, hasMore: true, history: "unknown" },
    })
    expect(packet.items.map((item: { locator: string }) => item.locator)).toEqual([
      "msg:chat/500/7/3",
      "msg:chat/500/7/2",
    ])
    const next = await call(["messages", "evidence", "7", "--before-id", "2", format], env, connection.connect)
    expect(JSON.parse(next.stdout)).toMatchObject({ nextBeforeId: null, items: [{ locator: "msg:chat/500/7/1" }] })
    expect(connection.connects).toEqual([])
  })

  it("shows human evidence with coverage and continuation notes", async () => {
    const env = await filled()
    const connection = pushing()
    const result = await call(["messages", "evidence", "7", "--limit", "1"], env, connection.connect, undefined, true)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("msg:chat/500/7/3")
    expect(result.stderr).toContain("history coverage unknown")
    expect(result.stderr).toContain("--before-id 3")
    expect(connection.connects).toEqual([])
  })

  it("returns typed errors for missing account, bad limits and missing anchors without connecting", async () => {
    const connection = pushing()
    const empty = await call(["messages", "evidence", "7", "--json"], sandbox(), connection.connect)
    expect(empty.code).not.toBe(0)
    expect(empty.stdout).toBe("")
    expect(JSON.parse(empty.stderr).error.code).toBe("not_found")
    const env = await filled()
    for (const flags of [
      ["--limit", "101"],
      ["--before-id", "missing"],
    ]) {
      const result = await call(["messages", "evidence", "7", "--json", ...flags], env, connection.connect)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr).error.code).toBe(flags[0] === "--limit" ? "validation_error" : "not_found")
    }
    expect(connection.connects).toEqual([])
  })

  it("inherits a denied messages permission before opening the store", async () => {
    const env = sandbox()
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "deny" } } } }),
    )
    const connection = pushing()
    const result = await call(["messages", "evidence", "7", "--json"], env, connection.connect)
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("deny")
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
    expect(connection.connects).toEqual([])
  })
})

const pushing = () => {
  const connects: number[] = []
  const sent: string[] = []
  const connect: Messenger["connect"] = async () => {
    connects.push(1)
    return server(sent)
  }
  return { connects, sent, connect }
}

describe("a messenger whose history is read from the store", () => {
  it("**answers chats, messages and contacts from the store and never connects**", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    const chats = await call(["chats", "list", "--json"], env, connect, "store")
    const messages = await call(["messages", "list", "Book", "--json"], env, connect, "store")
    const context = await call(
      ["messages", "context", "7", "2", "--before-n", "1", "--after-n", "0", "--json"],
      env,
      connect,
      "store",
    )
    const shown = await call(["chats", "show", "Book", "--json"], env, connect, "store")
    const contacts = await call(["contacts", "list", "--json"], env, connect, "store")

    expect(JSON.parse(chats.stdout).items.map((one: Chat) => one.id)).toEqual(["7", "20"])
    expect(JSON.parse(messages.stdout).items.map((one: Message) => one.id)).toEqual(["1", "2", "3"])
    expect(JSON.parse(context.stdout).items.map((one: Message) => one.id)).toEqual(["1", "2"])
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: "7", title: "Book club" })
    expect(JSON.parse(contacts.stdout).items.map((one: { name: string }) => one.name)).toEqual(["Zoe"])
    expect(connects).toEqual([])
  })

  it("show and ordinary time context refuse foreign account locators without connecting", async () => {
    const env = await filled()
    const { connects, connect } = pushing()
    for (const name of ["show", "context"]) {
      const refused = await call(["messages", name, "msg:chat/501/7/2", "--json"], env, connect, "store")
      expect(refused.code).toBe(2)
      expect(refused.stdout).toBe("")
      expect(refused.stderr).toContain("another account")
      const accepted = await call(["messages", name, "msg:chat/500/7/2", "--json"], env, connect, "store")
      expect(accepted.code).toBe(0)
      const result = JSON.parse(accepted.stdout)
      const items: Message[] = name === "show" ? [result.item] : result.items
      expect(items.some((one) => one.id === "2")).toBe(true)
    }
    expect(connects).toEqual([])
  })

  it("**says how to fill an empty store**: `serve` or `watch`, not --offline", async () => {
    const { connects, connect } = pushing()
    const { code, stderr } = await call(["messages", "list", "Book", "--json"], sandbox(), connect, "store")

    expect(code).not.toBe(0)
    expect(stderr).toContain("run `chat serve` or `chat watch` once to fill the local store")
    expect(stderr).not.toContain("--offline")
    expect(connects).toEqual([])
  })

  it("**answers not_found for a chat with nothing stored**, known or not", async () => {
    const env = await filled()
    const { connect } = pushing()

    for (const chat of ["Zoe", "999", "Nobody"]) {
      const { code, stdout, stderr } = await call(["messages", "list", chat, "--json"], env, connect, "store")
      expect(code).not.toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain('"code":"not_found"')
      expect(stderr).toContain("nothing stored for this chat yet — keep `chat serve` running")
    }
    const shown = await call(["chats", "show", "Nobody", "--json"], env, connect, "store")
    expect(shown.stderr).toContain("nothing stored for this chat yet")
  })

  it("**still connects to write**, through the guard", async () => {
    const env = await filled()
    const { connects, sent, connect } = pushing()

    const { code } = await call(["messages", "send", "Book", "see you"], env, connect, "store")

    expect(code).toBe(0)
    expect(connects).toEqual([1])
    expect(sent).toEqual(["7:see you"])
  })

  it("**refuses what it cannot answer from the store** before connecting", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    for (const argv of [
      ["messages", "sync", "Book"],
      ["messages", "sync", "Book", "--estimate"],
      ["messages", "list", "Book", "id>1"],
      ["messages", "list", "Book", "date<2h"],
    ]) {
      const { code, stderr } = await call(argv, env, connect, "store")
      expect(code, argv.join(" ")).toBe(2)
      expect(stderr).toContain("this messenger")
    }
    expect(connects).toEqual([])
  })

  it("**answers `inbox` and `review` from the store as the messenger would**, never connecting", async () => {
    const unread = { ...club, unreadCount: 2 }
    const online = (): MessengerAdapter => ({ ...server(), chats: async () => ({ items: [unread], hasMore: false }) })
    const env = sandbox()
    for (const argv of [
      ["chats", "list", "--json"],
      ["messages", "list", "Book", "--json"],
    ]) {
      expect((await call(argv, env, async () => online())).code).toBe(0)
    }
    const { connects, connect } = pushing()
    const since = "2026-09-27T10:00:30.000Z"

    for (const argv of [
      ["inbox", "--json"],
      ["inbox", "--since-time", since, "--json"],
      ["review", "--since-time", since, "--json"],
      ["review", "--since-time", since, "--chat", "Book", "--unanswered", "1h", "--json"],
    ]) {
      const asked = await call(argv, env, async () => online())
      const stored = await call(argv, env, connect, "store")
      expect(stored.code, argv.join(" ")).toBe(0)
      expect(JSON.parse(stored.stdout), argv.join(" ")).toEqual(JSON.parse(asked.stdout))
    }
    const inbox = JSON.parse((await call(["inbox", "--json"], env, connect, "store")).stdout)
    expect(inbox.chats[0].messages.map((one: Message) => one.id)).toEqual(["2", "3"])
    expect(connects).toEqual([])
  })

  it("**counts a chat as changed by its newest stored message**, not the chat's own older time", async () => {
    const stale = { ...club, lastMessageAt: "2026-09-27T09:00:00.000Z" }
    const env = sandbox()
    const online = (): MessengerAdapter => ({ ...server(), chats: async () => ({ items: [stale], hasMore: false }) })
    for (const argv of [
      ["chats", "list", "--json"],
      ["messages", "list", "Book", "--json"],
    ]) {
      expect((await call(argv, env, async () => online())).code).toBe(0)
    }
    const { connect } = pushing()

    const fresh = await call(["inbox", "--since-time", "2026-09-27T09:30:00.000Z", "--json"], env, connect, "store")
    const review = await call(["review", "--since-time", "2026-09-27T09:30:00.000Z", "--json"], env, connect, "store")

    expect(JSON.parse(fresh.stdout).chats[0].messages.map((one: Message) => one.id)).toEqual(["1", "2", "3"])
    expect(JSON.parse(review.stdout)).toMatchObject({ until: "2026-09-27T10:02:00.000Z", complete: true })
  })

  it("**answers not_found for `review --chat` with nothing stored**", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    const { code, stderr } = await call(["review", "--chat", "Zoe", "--json"], env, connect, "store")

    expect(code).not.toBe(0)
    expect(stderr).toContain("nothing stored for this chat yet — keep `chat serve` running")
    expect(connects).toEqual([])
  })

  it("**warns on stderr when no `serve` keeps the store up to date**, with its newest message", async () => {
    const env = await filled()
    const { connect } = pushing()

    const alone = await call(["messages", "list", "Book", "--json"], env, connect, "store")
    holdLock(lockPath(app, "default", env), { pid: process.pid, startedAt: new Date().toISOString() })
    const served = await call(["messages", "list", "Book", "--json"], env, connect, "store")

    expect(alone.stderr).toContain(
      'no `chat serve` keeps profile "default" up to date — the newest stored message is from 2026-09-27T10:02:00.000Z',
    )
    expect(JSON.parse(alone.stdout).items).toHaveLength(3)
    expect(served.stderr).toBe("")
    const { meta: _alone, ...first } = JSON.parse(alone.stdout)
    const { meta: _served, ...second } = JSON.parse(served.stdout)
    expect(second).toEqual(first)
  })

  it("leaves a server-mode messenger's empty chat an empty answer offline", async () => {
    const env = await filled()
    const offline = await call(["messages", "list", "999", "--offline", "--json"], env, async () => server())

    expect(offline.code).toBe(0)
    expect(JSON.parse(offline.stdout).items).toEqual([])
  })

  it("**download --all pages the store** and asks the messenger only for the files, resuming from the store", async () => {
    const env = sandbox()
    const withFiles = thread.map((one) => ({ ...one, attachments: one.id === "2" ? [] : [{ kind: "file" }] }))
    const filling = async () => ({ ...server(), history: async () => ({ items: withFiles, hasMore: false }) })
    for (const argv of [
      ["chats", "list", "--json"],
      ["messages", "list", "Book", "--json"],
    ]) {
      expect((await call(argv, env, filling)).code).toBe(0)
    }
    const asked: string[] = []
    const files: Messenger["connect"] = async () => ({
      ...server(),
      history: async () => {
        throw new Error("paged the messenger")
      },
      download: async (_chat, id) => {
        asked.push(id)
        return { files: [{ kind: "file", name: `${id}.txt`, bytes: async function* () {} }], skipped: [] }
      },
    })
    const into = join(env.MESSAGING_STORE, "..", "out")
    const argv = ["messages", "download", "Book", "--all", "--output-dir", into, "--json"]

    const first = await call(argv, env, files, "store")
    const again = await call(argv, env, files, "store")

    expect(JSON.parse(first.stdout)).toMatchObject({ saved: 2, complete: true })
    expect(JSON.parse(again.stdout)).toMatchObject({ saved: 0, complete: true })
    expect(asked).toEqual(["3", "1"])
  })
})
