import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message, MessageEvent } from "../../domain/models.js"
import { type DeletionScope, type MessageStore, openStore } from "../../store/store.js"
import type { MessengerAdapter } from "./port.js"
import { stored } from "./stored.js"

const account = { provider: "test", account: "500" }

const message = (id: string, text: string, chatId = "7"): Message => ({
  id,
  chatId,
  senderId: "500",
  senderName: "Me",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setUp = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "stored-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [
    { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
    { id: "8", title: "Olga", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.saveMessages(account, "7", [message("1", "the meeting is on tuesday")], { via: "history" })
  const adapter = {
    self: () => "500",
    edit: async (chatId: string, messageId: string, text: string) => message(messageId, text, chatId),
    forward: async () => message("90", "the meeting is on tuesday", "8"),
    delete: async () => {},
  }
  const wrapped = stored(adapter as unknown as MessengerAdapter, {
    account,
    store: async () => store,
    warn: () => {},
    events: () => {},
    profile: { app: "chat", name: "work" },
  })
  const found = async (text: string) => (await store.search(text, { limit: 10, account })).items.map((hit) => hit.id)
  return { wrapped, found, store }
}

describe("what the writes leave in the store", () => {
  it("an edit replaces the text search finds", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.edit?.("7", "1", "the meeting moved to friday", {})

    expect(await found("tuesday")).toEqual([])
    expect(await found("friday")).toEqual(["1"])
  })

  it("the first save records which account the profile is, for other apps to name it", async () => {
    const { wrapped, store } = await setUp()
    expect(await store.profiles()).toEqual({})

    await wrapped.edit?.("7", "1", "the meeting moved to friday", {})

    expect(await store.profiles()).toEqual({ chat: { work: account } })
  })

  it("a deletion leaves nothing for search to find", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.delete?.("7", ["1"], { forEveryone: false })

    expect(await found("tuesday")).toEqual([])
  })

  it("a forward keeps its copy in the chat it went to", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.forward?.("7", "1", "8", { sendId: "1" })

    expect(await found("tuesday")).toEqual(["90", "1"])
  })
})

describe("what a chat list leaves in the store", () => {
  const listing = async (pages: { items: string[]; hasMore: boolean }, window: { limit?: number; offset: number }) => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "stored-")), "m.db") })
    opened.push(store)
    const chat = (id: string) => ({
      id,
      title: id,
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: 2,
    })
    await store.saveChats(account, [chat("7"), chat("8")])
    const adapter = { self: () => "500", chats: async () => ({ items: pages.items.map(chat), hasMore: pages.hasMore }) }
    const wrapped = stored(adapter as unknown as MessengerAdapter, {
      account,
      store: async () => store,
      warn: () => {},
      events: () => {},
    })
    await wrapped.chats?.(window)
    return (await store.chats(account, {})).items.map((one) => one.id).sort()
  }

  it("a page that names every chat marks the others as left", async () => {
    expect(await listing({ items: ["7"], hasMore: false }, { offset: 0 })).toEqual(["7"])
  })

  it("a later page, a page with more after it, or an empty answer marks nothing", async () => {
    expect(await listing({ items: ["7"], hasMore: false }, { offset: 20 })).toEqual(["7", "8"])
    expect(await listing({ items: ["7"], hasMore: true }, { limit: 1, offset: 0 })).toEqual(["7", "8"])
    expect(await listing({ items: [], hasMore: false }, { offset: 0 })).toEqual(["7", "8"])
  })
})

describe("a deletion `watch` hears without its chat", () => {
  const deleting = async (deletedWithoutChat?: DeletionScope) => {
    const { store } = await setUp()
    await store.saveMessages(account, "8", [message("1", "see you tuesday", "8")], { via: "history" })
    const pending = new Set<Promise<void>>()
    const adapter = {
      self: () => "500",
      watch: async (onEvent: (event: MessageEvent) => void) => {
        onEvent({ event: "delete", chatId: null, chatTitle: null, messageId: "1" })
      },
    }
    const wrapped = stored(adapter as unknown as MessengerAdapter, {
      account,
      store: async () => store,
      warn: () => {},
      events: () => {},
      pending,
      ...(deletedWithoutChat ? { deletedWithoutChat } : {}),
    })
    await wrapped.watch?.(() => {}, new AbortController().signal)
    await Promise.all(pending)
    return {
      inGroup: await store.message(account, "1", { chatId: "7" }),
      inDialog: await store.message(account, "1", { chatId: "8" }),
    }
  }

  it("tombstones the one message in the chats the messenger's rule accepts", async () => {
    const { inGroup, inDialog } = await deleting((chat) => chat.kind === "dialog")
    expect(inGroup).toBeDefined()
    expect(inDialog).toBeUndefined()
  })

  it("without the rule, leaves an id two chats share alone", async () => {
    const { inGroup, inDialog } = await deleting()
    expect(inGroup).toBeDefined()
    expect(inDialog).toBeDefined()
  })
})
