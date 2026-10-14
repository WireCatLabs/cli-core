import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { ChatEvents, Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { chatsService } from "./chats.js"
import { type ServiceDeps, storedDeps } from "./deps.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat", app: { command: "chat" } } as Messenger
const guard = {} as SendGuard
const SINCE = Date.parse("2026-09-01T00:00:00Z")

const message = (id: string, at: string, senderId: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "7",
  senderId,
  senderName: null,
  timestamp: `2026-09-${at}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const history = [
  message("1", "02T10:00", "21", "Where is the meeting?"),
  message("2", "02T10:05", "30", "Room four", { replyToId: "1" }),
  message("3", "02T10:10", "22", "Anyone?", {
    reactions: { counts: [{ reaction: "👍", count: 3 }], mine: null, total: 3 },
    providerMetadata: { views: 120, forwards: 2, comments: 4 },
  }),
  message("5", "02T10:15", "23", "", { providerMetadata: { action: "chat_add_user" } }),
  message("4", "02T10:20", "21", "ok"),
  message("6", "03T09:15", "23", "hello all"),
]

const events: ChatEvents = {
  chatId: "7",
  since: new Date(SINCE).toISOString(),
  more: false,
  events: [
    {
      messageId: "5",
      timestamp: "2026-09-02T10:15:00.000Z",
      event: "join",
      by: { id: "23", name: null },
      people: [{ id: "23", name: null }],
    },
    {
      messageId: "8",
      timestamp: "2026-09-03T12:00:00.000Z",
      event: "leave",
      by: { id: "24", name: null },
      people: [{ id: "24", name: null }],
    },
  ],
}

const opened: MessageStore[] = []
const heldStore = async ({ whole }: { whole: boolean }) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "stats-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [
    {
      id: "7",
      title: "Book club",
      kind: "group",
      unreadCount: 0,
      lastMessageAt: "2026-09-03T09:15:00.000Z",
      participantsCount: 5,
    },
  ])
  await store.saveMessages(account, "7", history, { via: "test" })
  if (whole) {
    await store.markRange(account, "7", 1, 6)
    await store.setSyncState(account, historyStartKey("7"), "1")
  }
  return store
}

const askedFor: string[] = []
const adapter = {
  self: () => "500",
  chatEvents: async () => {
    askedFor.push("chatEvents")
    return events
  },
  admins: async () => {
    askedFor.push("admins")
    return ["30"]
  },
} as unknown as MessengerAdapter

const onlineWith = (store: MessageStore): ServiceDeps => ({
  ...storedDeps(messenger, store, account, guard),
  offline: false,
  connection: async () => adapter,
})

afterEach(async () => {
  askedFor.length = 0
  for (const store of opened.splice(0)) await store.close()
})

describe("stats chats show", () => {
  it("counts a held chat's period, its questions and who joined and wrote", async () => {
    const stats = await chatsService(onlineWith(await heldStore({ whole: true }))).stats("7", {
      since: SINCE,
      by: "day",
      timezone: "UTC",
    })

    expect(stats).toMatchObject({
      chatId: "7",
      complete: true,
      messages: 5,
      senders: 4,
      replies: 1,
      threads: 1,
      reactions: 3,
      views: 120,
      forwards: 2,
      comments: 4,
      topPosts: [{ messageId: "3", reactions: 3, views: 120, forwards: 2, comments: 4 }],
      questions: { asked: 2, answered: 1, medianMinutesToAnswer: 5, answeredBy: "owner-and-admins" },
      members: { joined: 1, left: 1, net: 0, wrote: 1, medianMinutesToFirstMessage: 1380, more: false },
      series: [
        { key: "2026-09-02", messages: 4, senders: 3, joined: 1, left: 0 },
        { key: "2026-09-03", messages: 1, senders: 1, joined: 0, left: 1 },
      ],
    })
    expect(askedFor).toEqual(["chatEvents", "admins"])
  })

  it("starts a week on Monday", async () => {
    const stats = await chatsService(onlineWith(await heldStore({ whole: true }))).stats("7", {
      since: SINCE,
      by: "week",
      timezone: "UTC",
    })

    expect(stats.series?.map(({ key, messages }) => ({ key, messages }))).toEqual([{ key: "2026-08-31", messages: 5 }])
  })

  it("leaves joins out offline instead of counting none, and asks the messenger nothing", async () => {
    const stats = await chatsService(storedDeps(messenger, await heldStore({ whole: true }), account, guard)).stats(
      "7",
      { since: SINCE },
    )

    expect(stats.members).toBeUndefined()
    expect(stats.questions.answeredBy).toBe("owner")
    expect(stats.messages).toBe(5)
    expect(askedFor).toEqual([])
  })

  it("says the counts are lower bounds when the store does not hold the chat whole", async () => {
    const stats = await chatsService(onlineWith(await heldStore({ whole: false }))).stats("7", { since: SINCE })

    expect(stats.complete).toBe(false)
    expect(stats.completeness.state).toBe("unknown")
    expect(stats.fetch).toBe("chat messages sync 7")
  })

  it("says the counts are lower bounds when the messenger stopped reading joins early", async () => {
    const cut = { ...adapter, chatEvents: async () => ({ ...events, more: true }) } as MessengerAdapter
    const deps = { ...onlineWith(await heldStore({ whole: true })), connection: async () => cut }

    const stats = await chatsService(deps).stats("7", { since: SINCE })

    expect(stats.complete).toBe(false)
    expect(stats.members?.more).toBe(true)
    expect(stats).not.toHaveProperty("fetch")
  })

  it("leaves views out where no message carries them", async () => {
    const store = await heldStore({ whole: true })

    const stats = await chatsService(onlineWith(store)).stats("7", { since: Date.parse("2026-09-03T00:00:00Z") })

    expect(stats).not.toHaveProperty("views")
    expect(stats.topPosts).toEqual([])
  })
})
