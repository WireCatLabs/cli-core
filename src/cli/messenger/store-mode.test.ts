import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { holdLock, lockPath } from "../../background/lock.js"
import type { Chat, Message } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import { chatsCommand } from "./chats-command.js"
import { membersCommand } from "./chats-members-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { inboxCommand } from "./inbox.js"
import { messagesCommand } from "./messages-command.js"
import { reactionsCommand } from "./reactions-command.js"
import { reviewCommand } from "./review.js"
import { searchCommand } from "./search-command.js"

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
  own: Partial<Messenger> = {},
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    ...(history ? { history } : {}),
    ...own,
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
        searchCommand(messenger),
        reactionsCommand(messenger),
        membersCommand(messenger),
      ],
    },
    { streams, tty, env },
  )
  return { code, stdout: streams.stdout.join(""), lines: streams.stdout, stderr: streams.stderr.join("\n") }
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
  it("returns a complete packet in --json as one item and pages with page.next without connecting", async () => {
    const env = await filled()
    const connection = pushing()
    const first = await call(["messages", "evidence", "Book", "--limit", "2", "--json"], env, connection.connect)
    expect(first.code).toBe(0)
    expect(first.stderr).toBe("")
    const answer = JSON.parse(first.stdout)
    expect(answer.item).toMatchObject({
      kind: "chats",
      source: { provider: "chat", account: "500", chat: "7" },
      coverage: { provided: 2, included: 2, has_more: true, history: "unknown" },
    })
    expect(answer.item.items.map((item: { locator: string }) => item.locator)).toEqual([
      "msg:chat/500/7/3",
      "msg:chat/500/7/2",
    ])
    expect(answer.next).toMatchObject([{ step: "page.next", args: { chat: "Book", cursor: "2", limit: 2 } }])
    const next = await call(["messages", "evidence", "7", "--cursor", "2", "--json"], env, connection.connect)
    const older = JSON.parse(next.stdout)
    expect(older.item).toMatchObject({ items: [{ locator: "msg:chat/500/7/1" }] })
    expect(older.next).toBeUndefined()
    expect(connection.connects).toEqual([])
  })

  it("streams the packet as one item line and an end line in --jsonl, and names the next page on stderr", async () => {
    const env = await filled()
    const connection = pushing()
    const first = await call(["messages", "evidence", "Book", "--limit", "2", "--jsonl"], env, connection.connect)
    expect(first.code).toBe(0)
    const [line, end] = first.lines.map((one) => JSON.parse(one))
    expect(line.data).toMatchObject({ kind: "chats", coverage: { included: 2 } })
    expect(end).toMatchObject({ type: "end", complete: true })
    expect(first.stderr).toContain("--cursor 2")
    expect(connection.connects).toEqual([])
  })

  it("shows human evidence and the continuation", async () => {
    const env = await filled()
    const connection = pushing()
    const result = await call(["messages", "evidence", "7", "--limit", "1"], env, connection.connect, undefined, true)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("msg:chat/500/7/3")
    expect(result.stderr).toContain("--cursor 3")
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
      ["--cursor", "missing"],
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
    expect(JSON.parse(shown.stdout).item).toMatchObject({ id: "7", title: "Book club" })
    expect(JSON.parse(contacts.stdout).items.map((one: { name: string }) => one.name)).toEqual(["Zoe"])
    expect(connects).toEqual([])
  })

  it("**chats list answers its query from the stored chats**, and keeps the query on the next page", async () => {
    const env = await filled()
    const { connects, connect } = pushing()
    const ids = async (...query: string[]) => {
      const found = await call(["chats", "list", ...query, "--json"], env, connect, "store")
      expect(found.code).toBe(0)
      return JSON.parse(found.stdout).items.map((one: Chat) => one.id)
    }

    expect(await ids("kind:group")).toEqual(["7"])
    expect(await ids("-kind:group")).toEqual(["20"])
    expect(await ids("title:book", "participants_count>=3")).toEqual(["7"])
    expect(await ids("unread_count>0")).toEqual([])
    const paged = await call(["chats", "list", "-kind:channel", "--limit", "1", "--json"], env, connect, "store")
    expect(JSON.parse(paged.stdout).next[0]).toMatchObject({ args: { query: "-kind:channel", page: 2 } })
    const short = await call(["chats", "list", "title:bo", "--json"], env, connect, "store")
    expect(short.code).toBe(2)
    expect(connects).toEqual([])
  })

  it("**contacts list refuses notes: when the store keeps no contacts**, and when the profile denies notes", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    const unkept = await call(["contacts", "list", "notes:valencia", "--json"], env, connect, "store")
    expect(JSON.parse(unkept.stderr.split("\n").at(-1) ?? "").error).toMatchObject({
      reason: "query.unsupported-field",
    })

    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { "contacts.notes.list": "deny" } } } }),
    )
    const denied = await call(["contacts", "list", "notes:valencia", "--json"], env, connect, "store")
    expect(JSON.parse(denied.stderr.split("\n").at(-1) ?? "").error).toMatchObject({ code: "permission_error" })
    expect((await call(["contacts", "list", "--json"], env, connect, "store")).code).toBe(0)
    expect(connects).toEqual([])
  })

  it("show and ordinary time context refuse foreign account locators without connecting", async () => {
    const env = await filled()
    const { connects, connect } = pushing()
    for (const name of ["show", "context"]) {
      const refused = await call(["messages", name, "msg:chat/501/7/2", "--json"], env, connect, "store")
      expect(refused.code).toBe(2)
      expect(refused.stdout).toBe("")
      expect(refused.stderr).toContain("belongs to account 501")
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
    const env = sandbox()
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { default: {} } }))
    const { code, stderr } = await call(["messages", "list", "Book", "--json"], env, connect, "store")

    expect(code).not.toBe(0)
    expect(stderr).toContain("run `chat default serve` or `chat default watch` once to fill the local store")
    expect(stderr).not.toContain("--offline")
    expect(connects).toEqual([])
  })

  it("**UX-58: names `<tool> <profile> setup` first where the CLI has one**", async () => {
    const { connect } = pushing()
    const env = sandbox()
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { default: {} } }))
    const ask = async (history?: "store") => {
      const messenger: Messenger = {
        app,
        provider: "chat",
        resolveSettings: settingsFor(app).resolveSettings,
        connect,
        chatArgument: "a chat",
        ...(history ? { history } : {}),
      }
      const streams = captureStreams()
      await run(
        ["messages", "list", "Book", "--json", ...(history ? [] : ["--offline"])],
        { app, commands: () => [messagesCommand(messenger), new Command("setup")] },
        { streams, tty: false, env },
      )
      return streams.stderr.join("\n")
    }
    expect(await ask("store")).toContain(
      "link it with `chat default setup`, then run `chat default serve` or `chat default watch` once to fill the local store",
    )
    expect(await ask()).toContain("log in with `chat default setup`, or run the command once without --offline")
  })

  it("**BUG-273: offers no --sync-first and no `messages sync` where the messenger pushes its history**", async () => {
    const { connect } = pushing()
    const help = async (history?: "store") =>
      [
        (await call(["search", "messages", "--help"], sandbox(), connect, history)).stdout,
        (await call(["contacts", "context", "--help"], sandbox(), connect, history)).stdout,
      ].join("\n")
    const pushed = await help("store")
    expect(pushed).not.toContain("--sync-first")
    expect(pushed).not.toContain("messages sync")
    expect(pushed).toContain("what `chat serve` has kept")
    const fetched = await help()
    expect(fetched).toContain("--sync-first")
    expect(fetched).toContain("chat messages sync <chat>")
    expect(fetched).not.toContain("sync --all")
  })

  it("**UX-59: `store check` names `messages sync` only as this messenger can run it**", async () => {
    const env = await filled()
    const { connect } = pushing()
    const steps = async (history?: "store", own: Partial<Messenger> = {}) => {
      const { code, stdout } = await call(["store", "check", "--json"], env, connect, history, false, own)
      expect(code).toBe(0)
      return (JSON.parse(stdout).next ?? []).filter((one: { step: string }) => one.step === "messages.sync")
    }

    expect(await steps()).toEqual([expect.objectContaining({ step: "messages.sync" })])
    expect(await steps("store")).toEqual([])
    expect(await steps("store", { historyOnDemand: true })).toEqual([
      expect.objectContaining({ step: "messages.sync", args: { chat: "20" } }),
    ])
  })

  it("**answers not_found for a chat with nothing stored**, known or not", async () => {
    const env = await filled()
    const { connect } = pushing()

    for (const chat of ["Zoe", "999", "Nobody"]) {
      const { code, stdout, stderr } = await call(["messages", "list", chat, "--json"], env, connect, "store")
      expect(code).not.toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain('"code":"not_found"')
      expect(stderr).toContain("nothing stored for this chat yet — keep `chat default serve` running")
    }
    const shown = await call(["chats", "show", "Nobody", "--json"], env, connect, "store")
    expect(shown.stderr).toContain("nothing stored for this chat yet")
  })

  it("**shows a chat the store holds as left, and says so**, while the list leaves it out", async () => {
    const env = await filled()
    const { connects, connect } = pushing()
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.chats.saveChats({ provider: "chat", account: "500" }, [
      { id: "7", kind: "group", membershipState: "left" },
    ])
    await store.close()

    const shown = await call(["chats", "show", "Book club", "--json"], env, connect, "store")
    const pretty = await call(["chats", "show", "Book club"], env, connect, "store")
    const messages = await call(["messages", "list", "Book club", "--json"], env, connect, "store")
    const listed = await call(["chats", "list", "--json"], env, connect, "store")

    expect(shown.code).toBe(0)
    expect(JSON.parse(shown.stdout).item).toMatchObject({ id: "7", title: "Book club", membership_state: "left" })
    expect(pretty.stderr).toContain(
      "you left this chat; its stored messages are kept — `chat default store clear --left --dry-run`",
    )
    for (const out of [shown, pretty, messages]) expect(out.stderr).not.toContain("nothing stored")
    expect(JSON.parse(messages.stdout).items).toHaveLength(3)
    expect(JSON.parse(listed.stdout).items.map((one: { id: string }) => one.id)).toEqual(["20"])
    expect(connects).toEqual([])
  })

  it("**says a left chat with no stored messages was left**, not that serve should run", async () => {
    const env = await filled()
    const { connect } = pushing()
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.chats.saveChats({ provider: "chat", account: "500" }, [
      { id: "g1@g.us", kind: "group", membershipState: "left" },
    ])
    await store.close()

    const { code, stderr } = await call(["messages", "list", "g1@g.us", "--json"], env, connect, "store")

    expect(code).not.toBe(0)
    expect(stderr).toContain("you left this chat, and the store holds none of its messages")
    expect(stderr).not.toContain("nothing stored")
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
      ["messages", "sync", "Book", "--dry-run"],
      ["messages", "list", "Book", "id>1"],
      ["messages", "list", "Book", "date<2h"],
    ]) {
      const { code, stderr } = await call(argv, env, connect, "store")
      expect(code, argv.join(" ")).toBe(2)
      expect(stderr).toContain("this messenger")
    }
    expect(connects).toEqual([])
  })

  it("**reads one chat back page by page** where the messenger can, capped at its page size, never --all", async () => {
    const env = await filled()
    const windows: unknown[] = []
    const connect: Messenger["connect"] = async () => ({
      ...server(),
      history: async (_chat, window) => {
        windows.push(window)
        return { items: thread.slice(0, window.limit), hasMore: false }
      },
    })
    const onDemand: Partial<Messenger> = {
      historyOnDemand: true,
      fetching: { page: 2, maxPageSize: 2, pause: "1ms", maxPages: 5, orderBy: "time" },
    }
    const sync = (...argv: string[]) => call(["messages", "sync", ...argv], env, connect, "store", false, onDemand)

    const synced = await sync("Book", "--last", "2", "--json")
    const wide = await sync("Book", "--page-size", "3")
    const all = await sync("--all")

    expect(synced.code, synced.stderr).toBe(0)
    expect(windows).toEqual([expect.objectContaining({ limit: 2 })])
    expect(wide.stderr).toContain("--page-size takes at most 2")
    expect(all.code).toBe(2)
    expect(all.stderr).toContain("name one chat")
    expect(windows).toHaveLength(1)
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
      ["inbox", `date>"${since}"`, "--json"],
      ["review", `date>"${since}"`, "--json"],
      ["review", `date>"${since}"`, "chat:Book", "--unanswered", "1h", "--json"],
    ]) {
      const asked = await call(argv, env, async () => online())
      const stored = await call(argv, env, connect, "store")
      expect(stored.code, argv.join(" ")).toBe(0)
      const { meta: _stored, ...fromStore } = JSON.parse(stored.stdout)
      const { meta: _asked, ...fromMessenger } = JSON.parse(asked.stdout)
      expect(fromStore, argv.join(" ")).toEqual(fromMessenger)
    }
    const inbox = JSON.parse((await call(["inbox", "--json"], env, connect, "store")).stdout)
    expect(inbox.items.map((one: { ref: string }) => one.ref.split("/").at(-1))).toEqual(["2", "3"])
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

    const fresh = await call(["inbox", 'date>"2026-09-27T09:30:00.000Z"', "--json"], env, connect, "store")
    const review = await call(["review", 'date>"2026-09-27T09:30:00.000Z"', "--json"], env, connect, "store")

    expect(JSON.parse(fresh.stdout).items.map((one: { ref: string }) => one.ref.split("/").at(-1))).toEqual([
      "1",
      "2",
      "3",
    ])
    expect(JSON.parse(review.stdout).next[0].args.query).toBe('date>"2026-09-27T10:02:00.000Z"')
  })

  it("**answers not_found for `review chat:` with nothing stored**", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    const { code, stderr } = await call(["review", "chat:Zoe", "--json"], env, connect, "store")

    expect(code).not.toBe(0)
    expect(stderr).toContain("nothing stored for this chat yet — keep `chat default serve` running")
    expect(connects).toEqual([])
  })

  it("**warns on stderr when no `serve` keeps the store up to date**, with its newest message", async () => {
    const env = await filled()
    const { connect } = pushing()

    const alone = await call(["messages", "list", "Book", "--json"], env, connect, "store")
    holdLock(lockPath(app, "default", env), { pid: process.pid, startedAt: new Date().toISOString() })
    const served = await call(["messages", "list", "Book", "--json"], env, connect, "store")

    expect(alone.stderr).toContain(
      'no `chat default serve` keeps profile "default" up to date — the newest stored message is from 2026-09-27T10:02:00.000Z',
    )
    expect(JSON.parse(alone.stdout).items).toHaveLength(3)
    expect(served.stderr).toBe("")
    const { meta: _alone, ...first } = JSON.parse(alone.stdout)
    const { meta: _served, ...second } = JSON.parse(served.stdout)
    expect(second).toEqual(first)
  })

  it("**does not warn on a write whose connect looks into the store**: reactions, members, sends", async () => {
    const env = await filled()
    const looked: unknown[] = []
    const connect: Messenger["connect"] = async (_command, _base, options) => ({
      ...server(),
      react: async (chatId, messageId) => {
        looked.push((await options?.stored?.message(chatId, messageId))?.text)
      },
      people: async (people) => {
        looked.push(await options?.stored?.wroteTo("20"))
        return people
      },
      addMembers: async () => ({ notAdded: [] }),
      send: async (chatId, text, { sendId }) => {
        looked.push((await options?.stored?.newestIncoming(chatId))?.id)
        return { message: { ...thread[0], text } as Message, sendId }
      },
    })

    const writes = [
      await call(["reactions", "add", "Book", "2", "👍"], env, connect, "store"),
      await call(["members", "add", "Book", "30"], env, connect, "store"),
      await call(["messages", "send", "Book", "see you"], env, connect, "store"),
    ]

    expect(writes.map((one) => one.code)).toEqual([0, 0, 0])
    expect(looked).toEqual(["chapter three", false, "3"])
    for (const { stderr } of writes) expect(stderr).not.toContain("keeps profile")
  })

  it("**store export never writes an attachment's providerRef**, to stdout or a file", async () => {
    const env = sandbox()
    const keyed = thread.map((one) => ({
      ...one,
      attachments: [{ kind: "file", name: "a.pdf", providerRef: { mediaKey: "SYNTHETIC-KEY", path: "/v/t62" } }],
    }))
    const reading = async () => ({ ...server(), history: async () => ({ items: keyed, hasMore: false }) })
    for (const argv of [
      ["chats", "list", "--json"],
      ["messages", "list", "Book", "--json"],
    ])
      expect((await call(argv, env, reading)).code).toBe(0)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const held = await store.messages.message({ provider: "chat", account: "500" }, "1", { chatId: "7" })
    await store.close()
    expect(held?.attachments[0]?.providerRef).toMatchObject({ mediaKey: "SYNTHETIC-KEY" })
    const into = join(env.MESSAGING_STORE, "..")

    const outputs = [
      (await call(["store", "export", "Book", "--json"], env, reading)).stdout,
      (await call(["store", "export", "Book", "--jsonl"], env, reading)).stdout,
      (await call(["store", "export", "Book", "--format", "markdown"], env, reading)).stdout,
    ]
    expect((await call(["store", "export", "Book", "--output", join(into, "out.jsonl")], env, reading)).code).toBe(0)
    outputs.push(readFileSync(join(into, "out.jsonl"), "utf8"))

    expect(outputs[0]).toContain("a.pdf")
    for (const output of outputs) expect(output).not.toMatch(/SYNTHETIC-KEY|providerRef|provider_ref/)
  })

  it("leaves a server-mode messenger's empty chat an empty answer offline", async () => {
    const env = await filled()
    const offline = await call(["messages", "list", "999", "--offline", "--json"], env, async () => server())

    expect(offline.code).toBe(0)
    expect(JSON.parse(offline.stdout).items).toEqual([])
  })

  it("**review --offline reads the store** without connecting, and says it holds only what was synced", async () => {
    const env = await filled()
    const offline = await call(["review", 'date>"2026-09-01T00:00:00Z"', "--offline", "--json"], env, async () => {
      throw new Error("connected")
    })

    expect(offline.stderr).toBe("")
    expect(offline.code).toBe(0)
    const answer = JSON.parse(offline.stdout)
    expect(answer.items.map((one: { text: string }) => one.text)).toEqual([
      "chapter three",
      "chapter three",
      "chapter three",
    ])
    expect(answer.missing).toContainEqual(expect.objectContaining({ why: expect.stringContaining("already synced") }))
    expect(answer.next[0].args.query).toBe('date>"2026-09-01T00:00:00.000Z"')
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

    expect(JSON.parse(first.stdout).item).toMatchObject({ saved: 2, complete: true })
    expect(JSON.parse(again.stdout).item).toMatchObject({ saved: 0, complete: true })
    expect(asked).toEqual(["3", "1"])
  })
})

describe("names where the history is read from the store", () => {
  const naming = (store: "store" | undefined) => {
    const asked: string[] = []
    const sent: string[] = []
    const connect: Messenger["connect"] = async () => ({
      ...server(sent),
      resolve: async (reference) => {
        asked.push(reference)
        if (reference === "Newcomer") return { ...zoe, id: "40", title: "Newcomer" }
        if (reference === "500") return { ...zoe, id: "500", title: null }
        return reference === "Zoe" ? zoe : club
      },
      people: async (people) => {
        asked.push(...people)
        return people.map(() => "41")
      },
      addMembers: async () => ({ notAdded: [] }),
    })
    return {
      asked,
      sent,
      send: (...argv: string[]) =>
        call(argv, filledEnv, connect, store, false, { savedChatId: (account) => account.account }),
    }
  }
  let filledEnv: NodeJS.ProcessEnv

  it("**a send finds the chat by its stored name** and never asks the messenger to look it up", async () => {
    filledEnv = await filled()
    const { asked, sent, send } = naming("store")

    expect((await send("messages", "send", "Book", "see you")).code).toBe(0)
    expect((await send("messages", "send", "me", "note")).code).toBe(0)

    expect(sent).toEqual(["7:see you", "500:note"])
    expect(asked).toEqual(["500"])
  })

  it("**asks the messenger for a name the store does not hold**", async () => {
    filledEnv = await filled()
    const { asked, sent, send } = naming("store")

    expect((await send("messages", "send", "Newcomer", "hi")).code).toBe(0)

    expect(asked).toEqual(["Newcomer"])
    expect(sent).toEqual(["40:hi"])
  })

  it("**refuses a name two stored chats share**, without asking the messenger", async () => {
    filledEnv = sandbox()
    const two: Messenger["connect"] = async () => ({
      ...server(),
      chats: async () => ({ items: [club, zoe, { ...club, id: "8", title: "Book fair" }], hasMore: false }),
    })
    expect((await call(["chats", "list", "--json"], filledEnv, two)).code).toBe(0)
    const { asked, sent, send } = naming("store")

    const refused = await send("messages", "send", "Book", "see you", "--json")
    const shown = await send("chats", "show", "Book", "--json")

    expect(refused.code).toBe(2)
    const error = (run: { stderr: string }) => JSON.parse(run.stderr.split("\n").at(-1) ?? "").error
    expect(error(refused).code).toBe("validation_error")
    expect(error(refused).message).toBe(error(shown).message)
    expect(asked).toEqual([])
    expect(sent).toEqual([])
  })

  it("**finds a person by their stored name** and asks the messenger only for the rest", async () => {
    filledEnv = await filled()
    const { asked, send } = naming("store")

    expect((await send("members", "add", "Book", "Olga", "Nobody")).code).toBe(0)

    expect(asked).toEqual(["Nobody"])
  })

  it("leaves a messenger that answers for its history asking it, as before", async () => {
    filledEnv = await filled()
    const { asked, sent, send } = naming(undefined)

    expect((await send("messages", "send", "Book", "see you")).code).toBe(0)
    expect((await send("members", "add", "Book", "Zoe")).code).toBe(0)

    expect(sent).toEqual(["7:see you"])
    expect(asked).toEqual(["Book", "Zoe", "Book"])
  })
})
