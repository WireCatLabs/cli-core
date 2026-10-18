import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import type { Chat, ChatEvent, MessageEvent } from "../../domain/models.js"
import type { HistoryBatch, MessengerAdapter } from "../../ports/messenger.js"
import { storeModeDeps } from "../../services/deps.js"
import { servicesFor } from "../../services/index.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import { lackedNeed } from "./lacks.js"
import { stored } from "./stored.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const account = { provider: "chat", account: "500" }
const club: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-10-18T10:00:00.000Z",
  participantsCount: 4,
}

const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const added: ChatEvent = {
  messageId: "ev-1",
  timestamp: recent(30),
  event: "add",
  by: { id: "9", name: "Olga" },
  people: [
    { id: "11", name: "Ivan" },
    { id: "12", name: "Zoe" },
  ],
}
const promoted: ChatEvent = {
  messageId: "ev-2",
  timestamp: recent(10),
  event: "promote",
  by: { id: "9", name: "Olga" },
  people: [{ id: "11", name: "Ivan" }],
}
const retitled: ChatEvent = {
  messageId: "ev-3",
  timestamp: recent(5),
  event: "title",
  by: { id: null, name: null },
  people: [],
  title: "Book club 2",
}

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "chat-events-"))
  return {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, own: Partial<Messenger>) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("never connects")
    },
    chatArgument: "a chat",
    accountOf: () => account,
    ...own,
  }
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [chatsCommand(messenger)] }, { streams, tty: false, env })
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
}

/** What `serve` keeps: one pushed batch and the live events after it, each twice, as a reconnect replays them. */
const pushed = async (path: string) => {
  const store = await openStore({ path })
  const pending = new Set<Promise<void>>()
  const batch: HistoryBatch = { chats: [club], events: [{ chatId: "7", change: added }] }
  const live: MessageEvent[] = [promoted, retitled, promoted].map((change) => ({
    event: "chat_event",
    chatId: "7",
    chatTitle: "Book club",
    change,
  }))
  const adapter = {
    self: () => "500",
    feed: async (onBatch: (one: HistoryBatch) => void) => {
      onBatch(batch)
      onBatch(batch)
    },
    watch: async (onEvent: (event: MessageEvent) => void) => {
      for (const event of live) onEvent(event)
    },
  }
  const wrapped = stored(adapter as unknown as MessengerAdapter, {
    account,
    store: async () => store,
    warn: () => {},
    events: () => {},
    pending,
  })
  await wrapped.feed?.(() => {}, new AbortController().signal)
  await wrapped.watch?.(() => {}, new AbortController().signal)
  await Promise.all(pending)
  return store
}

describe("chat events of a messenger whose history is pushed to the store", () => {
  it("**keeps each event once**, however often the batch or the live event comes again", async () => {
    const store = await pushed(sandbox().MESSAGING_STORE)
    const events = await store.roster.chatEvents(account, "7")
    expect(events.map((one) => [one.messageId, one.event, one.people.map((person) => person.id)])).toEqual([
      ["ev-1", "add", ["11", "12"]],
      ["ev-2", "promote", ["11"]],
      ["ev-3", "title", []],
    ])
    expect(events[2]).toMatchObject({ title: "Book club 2", by: { id: null, name: null } })
    await store.close()
  })

  it("**answers `chats events` from the store and never connects**, though the messenger lacks chatEvents", async () => {
    const env = sandbox()
    await (await pushed(env.MESSAGING_STORE)).close()

    const { code, stdout, stderr } = await call(["chats", "events", "7", "--json"], env, {
      history: "store",
      lacks: ["chatEvents"],
    })

    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout).items).toEqual([
      {
        chat_id: "7",
        time: added.timestamp,
        type: "add",
        message_id: "ev-1",
        by: { id: "9", name: "Olga" },
        people: [
          { id: "11", name: "Ivan" },
          { id: "12", name: "Zoe" },
        ],
      },
      {
        chat_id: "7",
        time: promoted.timestamp,
        type: "promote",
        message_id: "ev-2",
        by: { id: "9", name: "Olga" },
        people: [{ id: "11", name: "Ivan" }],
      },
      {
        chat_id: "7",
        time: retitled.timestamp,
        type: "title",
        message_id: "ev-3",
        by: { id: null, name: null },
        people: [],
        title: "Book club 2",
      },
    ])
  })

  it("lists only the events since the query's time, `--offline` too", async () => {
    const env = sandbox()
    await (await pushed(env.MESSAGING_STORE)).close()

    const { stdout } = await call(["chats", "events", "7", "time>=15m", "--offline", "--json"], env, {
      history: "store",
    })

    expect(JSON.parse(stdout).items.map((one: { message_id: string }) => one.message_id)).toEqual(["ev-2", "ev-3"])
  })

  it("**lists the newest 1000** and marks the answer truncated when the store holds more", async () => {
    const env = sandbox()
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.chats.saveChats(account, [club])
    const many = Array.from({ length: 1001 }, (_, n) => ({
      ...promoted,
      messageId: `ev-${n}`,
      timestamp: new Date(Date.now() - (1001 - n) * 1000).toISOString(),
    }))
    await store.roster.saveChatEvents(account, "7", many)
    await store.close()

    const { code, stdout } = await call(["chats", "events", "7", "--json"], env, { history: "store" })

    const body = JSON.parse(stdout)
    expect(code).toBe(0)
    expect(body.meta.truncated).toBe(true)
    expect(body.items).toHaveLength(1000)
    expect([body.items[0].message_id, body.items.at(-1).message_id]).toEqual(["ev-1", "ev-1000"])
  })

  it("**counts the stored joins in `chats stats`**, never asking the messenger", async () => {
    const store = await pushed(sandbox().MESSAGING_STORE)
    await store.messages.saveMessages(account, "7", [], { via: "history" })
    const messenger = { app, provider: "chat", history: "store" as const }
    const services = servicesFor(storeModeDeps(messenger, store, account, { check: () => {}, record: () => {} }))

    const stats = await services.chats.stats("7", {})

    expect(stats.members).toMatchObject({ joined: 2, left: 0, more: false })
    await store.close()
  })

  it("declares a local read where the store answers, and a remote one where the messenger does", () => {
    const effects = (own: Partial<Messenger>) => {
      const messenger = { app, provider: "chat", chatArgument: "a chat", ...own } as Messenger
      const events = chatsCommand(messenger).commands.find((one) => one.name() === "events")
      return events ? metaOf(events).effects : undefined
    }
    expect(effects({ history: "store" })).toEqual({ remote: "none", local: "read" })
    expect(effects({})).toEqual({ remote: "read", local: "read" })
  })

  it("still refuses `chats events` up front for a server-history messenger that lacks chatEvents", () => {
    expect(lackedNeed({ lacks: ["chatEvents"] }, "chats events")).toEqual(["chatEvents", "read who joined or left"])
    expect(lackedNeed({ lacks: ["chatEvents"], history: "store" }, "chats events")).toBeUndefined()
    expect(lackedNeed({ lacks: ["inspect"], history: "store" }, "chats inspect")).toBeDefined()
  })
})
