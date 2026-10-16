import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Chat, Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { servicesFor, storedDeps } from "./index.js"
import { refreshSearch } from "./search-refresh.js"

const account = { provider: "test", account: "500" }
const messenger = {
  provider: "test",
  app: { command: "chat" },
  fetching: { orderBy: "id", pause: "1ms" },
} as Messenger
const message = (chatId: string, id = "1"): Message => ({
  id,
  chatId,
  senderId: "9",
  senderName: "Reader",
  timestamp: `2026-10-01T00:00:0${id}.000Z`,
  editedAt: null,
  text: "chapter",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const stores: MessageStore[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) await store.close()
})
const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "refresh-")), "m.db") })
  stores.push(store)
  await store.chats.saveChats(
    account,
    ["7", "8", "9", "10", "11", "12"].map(
      (id, i): Chat => ({
        id,
        title: `Chat ${id}`,
        kind: "group",
        unreadCount: 1,
        lastMessageAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 6 - i)).toISOString(),
        participantsCount: null,
      }),
    ),
  )
  await store.messages.saveMessages(account, "7", [message("7")], { via: "history" })
  const asked: string[] = []
  const markRead = vi.fn(() => {
    throw new Error("must never mark read")
  })
  const adapter = {
    self: () => "500",
    markRead,
    history: vi.fn(async (chat: string) => {
      asked.push(chat)
      const items = [message(chat, "2"), message(chat)]
      await store.messages.saveMessages(account, chat, items, { via: "history" })
      return { items, hasMore: false }
    }),
  } as unknown as MessengerAdapter
  const guard = { check: vi.fn(), record: vi.fn() } satisfies SendGuard
  const connection = vi.fn(async () => adapter)
  const deps = { ...storedDeps(messenger, store, account, guard), offline: false, connection }
  return { store, deps, asked, adapter, markRead, guard, connection, services: servicesFor(deps) }
}

describe("bounded search refresh", () => {
  it.each([
    { text: "chapter", chat: "7" },
    { text: "chapter chat:7" },
    { ast: parseLucene("chapter chat:7") },
    { text: "chapter AND (chat:7 OR chat:8)" },
    { text: "chapter AND NOT chat:8", chat: "7" },
  ])("fetches only the required scope for %j, without mark-read", async (query) => {
    const one = await setup()
    const found = await one.services.messages.search({ ...query, syncFirst: {}, limit: 20 })
    expect(one.asked).toEqual(query.text?.includes("OR") ? ["7", "8"] : ["7"])
    expect(found.refreshed?.complete).toBe(true)
    expect(found.items.some(({ id }) => id === "2")).toBe(true)
    expect(one.markRead).not.toHaveBeenCalled()
    expect(one.guard.check).toHaveBeenCalledWith(
      { chatId: null, kind: "reaction", key: "messages.sync-first" },
      { reserve: false },
    )
    expect(one.guard.record).not.toHaveBeenCalled()
  })

  it("takes the most recent five chats by default, and labels the bound stale", async () => {
    const one = await setup()
    const note = vi.fn()
    const found = await one.services.messages.search({
      text: "chapter",
      limit: 20,
      syncFirst: { note },
    })
    expect(one.asked).toEqual(["7", "8", "9", "10", "11"])
    expect(found.refreshed).toMatchObject({ messages: 10, complete: false })
    expect(found.coverage?.state).toBe("stale")
    expect(note).toHaveBeenCalledWith("refresh incomplete — the local answer may be stale")
  })

  it("does not treat an optional chat filter as the entire query scope", async () => {
    const one = await setup()
    await one.services.messages.search({
      text: "chapter OR chat:8",
      limit: 20,
      syncFirst: { maxChats: 2 },
    })
    expect(one.asked).toEqual(["7", "8"])
  })

  it("intersects incompatible required chats without fetching", async () => {
    const one = await setup()
    await one.services.messages.search({ text: "chat:7 AND chat:8", limit: 20, syncFirst: {} })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("excludes negated chats before taking the recent-chat bound", async () => {
    const one = await setup()
    await one.services.messages.search({
      text: "chapter AND NOT chat:7",
      limit: 20,
      syncFirst: { maxChats: 2 },
    })
    expect(one.asked).toEqual(["8", "9"])
  })

  it("honors conflicting explicit and query chat filters without fetching", async () => {
    const one = await setup()
    await one.services.messages.search({
      text: "chapter chat:7",
      chat: "8",
      limit: 20,
      syncFirst: {},
    })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("conversation strict filters select the same refresh chats as message search", async () => {
    const one = await setup()
    const answer = await one.services.embeddings.search("chapter", { filter: "chat:8", limit: 20, syncFirst: {} })
    expect(one.asked).toEqual(["8"])
    expect(answer.refreshed?.complete).toBe(true)
  })

  it("conversation cross-account refresh reports unconnected accounts", async () => {
    const one = await setup()
    await one.store.accounts.saveAccount({ provider: "test", account: "600" }, { name: "Other" })
    const answer = await one.services.embeddings.search("chapter", {
      source: "all",
      limit: 20,
      syncFirst: { maxChats: 1 },
    })
    expect(answer.refreshed?.failed).toContainEqual({
      account: { provider: "test", account: "600" },
      chat: null,
      reason: "account_not_connected",
    })
    expect(answer.coverage?.state).toBe("stale")
  })

  it("refreshes the graph after ingesting new messages when both steps are requested", async () => {
    const one = await setup()
    await one.services.conversations.build("7")
    const found = await one.services.embeddings.search("chapter", {
      chat: "7",
      limit: 20,
      syncFirst: {},
      refresh: { chat: "7", build: true, embed: false },
    })
    expect(found.refreshed?.complete).toBe(true)
    expect(found.prepared?.built).toMatchObject([{ chat: "7", messages: 2 }])
    expect(found.readiness.stale).toEqual([])
    expect(found.hits).toHaveLength(1)
  })

  it("keeps the local answer and sanitized stale coverage when fetching fails", async () => {
    const one = await setup()
    one.connection.mockRejectedValue(new Error("private provider detail"))
    const note = vi.fn()
    const found = await servicesFor(one.deps).messages.search({
      text: "chapter",
      chat: "7",
      limit: 20,
      syncFirst: { note },
    })
    expect(found.items.map(({ id }) => id)).toEqual(["1"])
    expect(found).toMatchObject({
      coverage: { state: "stale" },
      refreshed: { failed: [{ chat: "7", reason: "fetch_failed" }], complete: false },
    })
    expect(JSON.stringify(found)).not.toContain("private provider detail")
    expect(JSON.stringify(note.mock.calls)).not.toContain("private provider detail")
  })

  it.each(["offline", "pushed_history"])("keeps local results for %s without connecting", async (reason) => {
    const one = await setup()
    const deps = {
      ...one.deps,
      offline: reason === "offline",
      reads: reason === "pushed_history" ? ("store" as const) : ("server" as const),
    }
    const found = await servicesFor(deps).messages.search({
      text: "chapter",
      chat: "7",
      limit: 20,
      syncFirst: {},
    })
    expect(found.refreshed?.failed[0]?.reason).toBe(reason)
    expect(found.items).toHaveLength(1)
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("counts the refreshed store through the same stats service", async () => {
    const one = await setup()
    const found = await one.services.messages.stats({
      text: "chapter",
      chat: "7",
      by: "chat",
      limit: 20,
      syncFirst: {},
    })
    expect(found.total).toBe(2)
    expect(found.refreshed?.complete).toBe(true)
  })

  it("labels failed stats refresh stale while retaining counts", async () => {
    const one = await setup()
    const found = await servicesFor({ ...one.deps, offline: true }).messages.stats({
      chat: "7",
      by: "chat",
      limit: 20,
      syncFirst: {},
    })
    expect(found.total).toBe(1)
    expect(found.coverage.state).toBe("stale")
  })

  it("leaves local search and counts disconnected when the option is absent", async () => {
    const one = await setup()
    const found = await one.services.messages.search({ text: "chapter", limit: 20 })
    const stats = await one.services.messages.stats({ by: "chat", limit: 20 })
    expect(found.refreshed).toBeUndefined()
    expect(stats.refreshed).toBeUndefined()
    expect(one.connection).not.toHaveBeenCalled()
    expect(one.guard.check).not.toHaveBeenCalled()
  })

  it("does not fetch another account over the current account's connection", async () => {
    const one = await setup()
    const other = { provider: "test", account: "600" }
    await one.store.chats.saveChats(other, [
      { id: "7", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await one.store.messages.saveMessages(other, "7", [message("7", "3")], { via: "history" })
    const found = await one.services.messages.search({
      text: "chapter",
      source: "all",
      limit: 20,
      syncFirst: { maxChats: 1 },
    })
    expect(found.items.some(({ locator }) => locator === "msg:test/600/7/3")).toBe(true)
    expect(found.refreshed?.failed).toContainEqual({ account: other, chat: null, reason: "account_not_connected" })
    expect(one.asked).toEqual(["7"])
  })

  it("checks permissions before connecting", async () => {
    const one = await setup()
    one.guard.check.mockImplementation(() => {
      throw new CliError("permission_error", "denied")
    })
    await expect(
      one.services.messages.search({ text: "chapter", chat: "7", limit: 20, syncFirst: {} }),
    ).rejects.toMatchObject({ code: "permission_error" })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("stops at the previous newest timestamp instead of fetching old history", async () => {
    const one = await setup()
    one.adapter.history = async (chat) => {
      one.asked.push(chat)
      return { items: [message(chat, "2"), message(chat)], hasMore: true }
    }
    const result = await refreshSearch(one.deps, { chat: "7", limit: 20, syncFirst: {} })
    expect(one.asked).toEqual(["7"])
    expect(result).toMatchObject({ messages: 2, complete: true })
  })

  it("bounds all chats by one message budget", async () => {
    const one = await setup()
    one.adapter.history = async (chat, { limit }) => {
      one.asked.push(chat)
      expect(limit).toBe(1)
      return { items: [message(chat, "2")], hasMore: true }
    }
    const result = await refreshSearch(one.deps, {
      limit: 20,
      syncFirst: { maxMessages: 1, maxChats: 2 },
    })
    expect(one.asked).toEqual(["7"])
    expect(result).toMatchObject({
      messages: 1,
      complete: false,
      failed: [{ reason: "message_bound" }, { reason: "message_bound" }],
    })
  })

  it("awaits the current page but starts no next request after the time bound", async () => {
    const one = await setup()
    vi.useFakeTimers()
    one.adapter.history = async (chat) => {
      one.asked.push(chat)
      await vi.advanceTimersByTimeAsync(31)
      await one.store.messages.saveMessages(account, chat, [message(chat, "2")], { via: "history" })
      return { items: [message(chat, "2")], hasMore: true }
    }
    const result = await refreshSearch(one.deps, {
      limit: 20,
      syncFirst: { timeMs: 30, maxChats: 2 },
    })
    expect(one.asked).toEqual(["7"])
    expect(result).toMatchObject({
      messages: 1,
      complete: false,
      failed: [{ reason: "time_or_abort_bound" }, { reason: "time_or_abort_bound" }],
    })
  })

  it("does not connect for an already aborted refresh", async () => {
    const one = await setup()
    const result = await refreshSearch(one.deps, {
      chat: "7",
      signal: AbortSignal.abort(),
      limit: 20,
      syncFirst: {},
    })
    expect(result?.complete).toBe(false)
    expect(one.connection).not.toHaveBeenCalled()
  })

  it.each([
    { maxChats: 0 },
    { maxChats: 101 },
    { timeMs: 0 },
    { timeMs: Infinity },
    { maxMessages: -1 },
    { maxMessages: 10001 },
  ])("rejects invalid bounds %j before connecting", async (syncFirst) => {
    const one = await setup()
    await expect(refreshSearch(one.deps, { limit: 20, syncFirst })).rejects.toMatchObject({ code: "validation_error" })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("validates queries before network use", async () => {
    const one = await setup()
    await expect(refreshSearch(one.deps, { text: "bogus:value", limit: 20, syncFirst: {} })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(one.connection).not.toHaveBeenCalled()
  })
})
