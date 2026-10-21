import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { servicesFor, storedDeps } from "./index.js"
import { readThreadContext } from "./thread-context.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", app: { command: "chat" } } as Messenger
const message = (id: number, parent?: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: String(id),
  senderName: `Person ${id}`,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + id * 600_000).toISOString(),
  editedAt: null,
  text: `synthetic message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(parent === undefined ? {} : { replyToId: String(parent) }),
  forwardedFrom: null,
  reactions: null,
})
const records = [message(1), message(2), message(3, 1), message(4, 2), message(5, 3), message(6, 1)]
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
})
const setup = async (build = true, items = records) => {
  let clock = Date.parse("2026-10-06T00:00:00Z")
  vi.spyOn(Date, "now").mockImplementation(() => clock)
  const path = join(mkdtempSync(join(tmpdir(), "thread-")), "m.db")
  const store = await openStore({ path, now: () => clock })
  stores.push(store)
  await store.chats.saveChats(account, [
    { id: "7", title: "Synthetic group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(account, "7", items, { via: "history" })
  const connection = vi.fn(async () => {
    throw new Error("thread context must remain local")
  })
  const services = servicesFor({
    ...storedDeps(messenger, store, account, {} as SendGuard),
    offline: false,
    connection,
  })
  if (build) await services.conversations.build("7")
  return {
    store,
    services,
    path,
    advance: (ms = 1000) => {
      clock += ms
    },
    connection,
  }
}
const ids = (found: Awaited<ReturnType<typeof readThreadContext>>) => found.items.map(({ id }) => id)
const bytes = (found: Awaited<ReturnType<typeof readThreadContext>>) =>
  Buffer.byteLength(JSON.stringify({ items: found.items, links: found.links }))

describe("graph context around a hit", () => {
  it("follows the parent chain and replies without mixing interleaved discussions", async () => {
    const one = await setup()
    const found = await one.services.messages.thread("7", "5")
    expect(ids(found)).toEqual(["1", "3", "5", "6"])
    expect(found.chain).toEqual(["3", "1"])
    expect(found).toMatchObject({ ref: "msg:test/500/7/5", mode: "thread", stale: false, stopped: [] })
    expect(found.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "5",
          parentId: "3",
          source: "provider",
          kind: "reply",
          confidence: 1,
          chosen: true,
          stale: false,
        }),
        expect.objectContaining({ messageId: "6", parentId: "1", source: "provider", kind: "reply", confidence: 1 }),
      ]),
    )
    expect(found.items.filter(({ anchor }) => anchor).map(({ id }) => id)).toEqual(["5"])
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("keeps ordinary time context available separately", async () => {
    const one = await setup()
    const time = await servicesFor(storedDeps(messenger, one.store, account, {} as SendGuard)).messages.around(
      "7",
      "5",
      { before: 1, after: 1 },
    )
    expect(time.map(({ id }) => id)).toEqual(["4", "5", "6"])
    expect(ids(await one.services.messages.thread("7", "5"))).toEqual(["1", "3", "5", "6"])
  })

  it("returns bounded time context and names the fallback when the chat was never built", async () => {
    const one = await setup(false)
    const found = await one.services.messages.thread("7", "3", { before: 1, after: 1 })
    expect(ids(found)).toEqual(["2", "3", "4"])
    expect(found).toMatchObject({ mode: "time", fallback: "not_built", links: [], chain: [] })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("says not_stored for an absent or deleted hit", async () => {
    const one = await setup()
    expect(await one.services.messages.thread("7", "999")).toMatchObject({ items: [], fallback: "not_stored" })
  })

  it("labels changed endpoints stale before a rebuild and does not follow their links", async () => {
    const one = await setup()
    one.advance()
    await one.store.messages.saveMessages(account, "7", [{ ...message(3, 1), text: "edited synthetic endpoint" }], {
      via: "update",
    })
    const found = await one.services.messages.thread("7", "5")
    expect(ids(found)).toEqual(["5"])
    expect(found.stale).toBe(true)
    expect(found.links).toMatchObject([{ messageId: "5", parentId: "3", stale: true, chosen: false }])
    expect((await one.store.conversations.links(account, "7", "3"))[0]?.stale).toBe(true)
  })

  it("handles equal-clock revisions conservatively", async () => {
    const one = await setup()
    await one.store.messages.saveMessages(
      account,
      "7",
      [{ ...message(3, 1), text: "changed in the build millisecond" }],
      {
        via: "update",
      },
    )
    expect((await one.store.conversations.links(account, "7", "5"))[0]?.stale).toBe(true)
  })

  it("does not return deleted text and labels links to deleted endpoints stale", async () => {
    const one = await setup()
    one.advance()
    await one.store.messages.markDeleted(account, ["3"], { chatId: "7" })
    const found = await one.services.messages.thread("7", "5")
    expect(ids(found)).toEqual(["5"])
    expect(found.links[0]?.stale).toBe(true)
    expect(JSON.stringify(found)).not.toContain("synthetic message 3")
  })

  it("detects changed native reply targets even when the text did not change", async () => {
    const one = await setup()
    one.advance()
    await one.store.messages.saveMessages(account, "7", [message(5, 2)], { via: "update" })
    const found = await one.services.messages.thread("7", "5")
    expect(ids(found)).toEqual(["5"])
    expect(found.links[0]?.stale).toBe(true)
  })

  it("uses a labelled time fallback for a hit not included in the graph snapshot", async () => {
    const one = await setup()
    one.advance()
    await one.store.messages.saveMessages(account, "7", [message(7, 5)], { via: "history" })
    expect(await one.services.messages.thread("7", "7")).toMatchObject({
      mode: "time",
      fallback: "not_linked",
      stale: true,
      builtAt: expect.any(String),
    })
    expect((await one.services.messages.thread("7", "5")).builtAt).toBe("2026-10-06T00:00:00.000Z")
  })

  it("carries rule provenance and lets an agent root override a rule", async () => {
    const input = [message(1), { ...message(2), senderId: "1", timestamp: "2026-10-01T00:11:00Z" }]
    const one = await setup(true, input)
    const rule = await one.services.messages.thread("7", "2")
    expect(rule.links).toMatchObject([{ source: "rule", kind: "same_sender", confidence: 0.5 }])
    const batch = await one.services.conversations.nextBatch("7", 10)
    one.advance()
    await one.services.conversations.addAnswers(batch?.batch as string, {
      model: "synthetic-agent",
      answers: [{ message: "2", parent: null, confidence: 0.8 }],
    })
    await one.services.conversations.build("7")
    const rooted = await one.services.messages.thread("7", "2")
    expect(ids(rooted)).toEqual(["2"])
    expect(rooted.links).toMatchObject([
      { source: "agent", parentId: null, kind: "answer", confidence: 0.8, method: "synthetic-agent" },
    ])
  })

  it("returns agent links with provenance and detects a changed endpoint before rebuilding", async () => {
    const one = await setup()
    const batch = await one.services.conversations.nextBatch("7", 10)
    one.advance()
    await one.services.conversations.addAnswers(batch?.batch as string, {
      model: "synthetic-agent",
      answers: [{ message: "2", parent: "1", confidence: 0.7 }],
    })
    await one.services.conversations.build("7")
    const found = await one.services.messages.thread("7", "2")
    expect(found.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "agent", method: "synthetic-agent", confidence: 0.7, chosen: true }),
      ]),
    )
    one.advance()
    await one.store.messages.saveMessages(account, "7", [{ ...message(2), text: "edited agent endpoint" }], {
      via: "update",
    })
    expect((await one.services.messages.thread("7", "2")).links[0]).toMatchObject({ stale: true, chosen: false })
  })

  it("returns a root-only view at zero hops", async () => {
    const one = await setup()
    const found = await one.services.messages.thread("7", "5", { maxHops: 0 })
    expect(ids(found)).toEqual(["5"])
    expect(found.stopped).toContain("hops")
  })

  it("caps hops from the hit in both directions", async () => {
    const one = await setup()
    const found = await one.services.messages.thread("7", "5", { maxHops: 1 })
    expect(ids(found)).toEqual(["3", "5"])
    expect(found.stopped).toContain("hops")
  })

  it("bounds a large reply fan-out", async () => {
    const one = await setup(true, [message(1), ...Array.from({ length: 80 }, (_, i) => message(i + 2, 1))])
    const found = await one.services.messages.thread("7", "1", { maxMessages: 3 })
    expect(found.items).toHaveLength(3)
    expect(found.stopped).toContain("messages")
  })

  it("keeps whole items within the byte budget, including an oversized anchor", async () => {
    const one = await setup()
    const empty = await one.services.messages.thread("7", "5", { maxBytes: 1 })
    expect(empty.items).toEqual([])
    expect(empty.stopped).toEqual(["bytes"])
    const bounded = await one.services.messages.thread("7", "5", { maxBytes: 900 })
    expect(bytes(bounded)).toBeLessThanOrEqual(900)
    expect(bounded.stopped).toContain("bytes")
  })

  it("bounds time either side of the hit", async () => {
    const one = await setup()
    const found = await one.services.messages.thread("7", "5", { withinMs: 600_000 })
    expect(ids(found)).toEqual(["5"])
    expect(found.stopped).toContain("time")
  })

  it("does not cross native topics", async () => {
    const one = await setup(true, [message(1), { ...message(2, 1), threadId: "topic" }])
    const found = await one.services.messages.thread("7", "2")
    expect(ids(found)).toEqual(["2"])
    expect(found.stopped).toContain("thread")
  })

  it("keeps other accounts and chats isolated even with the same message ids", async () => {
    const one = await setup()
    const other = { ...account, account: "600" }
    await one.store.messages.saveMessages(other, "7", records, { via: "history" })
    expect(await readThreadContext(one.store, other, "7", "5")).toMatchObject({
      mode: "time",
      fallback: "not_built",
      links: [],
    })
    expect(await readThreadContext(one.store, account, "8", "5")).toMatchObject({ fallback: "not_stored", links: [] })
  })

  it("bounds time fallback by message and byte caps", async () => {
    const one = await setup(false)
    const found = await one.services.messages.thread("7", "3", { maxMessages: 1 })
    expect(ids(found)).toEqual(["3"])
    expect(found.stopped).toContain("messages")
    const small = await one.services.messages.thread("7", "3", { maxBytes: 1 })
    expect(small.stopped).toContain("bytes")
  })

  it("caps time fallback reads before retrieving neighbours", async () => {
    const one = await setup(false)
    const around = vi.spyOn(one.store.messages, "around")
    const found = await one.services.messages.thread("7", "3", { before: 100, after: 100, maxMessages: 1 })
    expect(ids(found)).toEqual(["3"])
    for (const [, , , window] of around.mock.calls) expect(window.before + window.after + 1).toBeLessThanOrEqual(1)
    expect(found.stopped).toContain("messages")
  })

  it("stops an aborted read without opening a connection", async () => {
    const one = await setup()
    expect(await one.services.messages.thread("7", "5", { signal: AbortSignal.abort() })).toMatchObject({
      items: [],
      stopped: ["aborted"],
    })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it.each([
    { maxHops: -1 },
    { maxHops: 51 },
    { maxMessages: 0 },
    { maxMessages: 501 },
    { maxBytes: Infinity },
    { withinMs: 0 },
    { before: 101 },
  ])("validates %j", async (options) => {
    const one = await setup()
    await expect(one.services.messages.thread("7", "5", options)).rejects.toMatchObject({ code: "validation_error" })
  })

  it("search hits carry the same thread as direct context while retaining time context", async () => {
    const one = await setup()
    const found = await one.services.messages.search({
      text: 'text:"synthetic message 5"',
      limit: 10,
      context: 1,
      thread: {},
    })
    expect(found.items).toHaveLength(1)
    expect(found.items[0]?.thread).toEqual(await one.services.messages.thread("7", "5", { before: 1, after: 1 }))
    expect(found.items[0]?.context?.map(({ id }) => id)).toEqual(["4", "5", "6"])
  })

  it.each(["Helix rollout", "Can operators approve Helix rollout?"])(
    "discovery expands the final hit's approval thread for %s",
    async (text) => {
      const one = await setup(true, [
        { ...message(1), text: "Helix rollout: approve the landing price of 40 credits?" },
        { ...message(2, 1), text: "Yes, confirmed." },
        { ...message(3), text: "Unrelated maintenance." },
      ])
      const query = { text, discover: true, limit: 1, context: 1 }
      const plain = await one.services.messages.search(query)
      expect(plain.items).toHaveLength(1)
      const found = await one.services.messages.search({ ...query, thread: {} })
      const expanded = found.items[0]
      if (!expanded) throw new Error("discovery returned no hit")
      const { thread, ...hit } = expanded
      expect(hit).toEqual(plain.items[0])
      expect(thread).toEqual(await one.services.messages.thread("7", hit.id, { before: 1, after: 1 }))
      expect(thread?.items.map(({ id }) => id)).toEqual(["1", "2"])
      expect(thread?.links).toContainEqual(
        expect.objectContaining({ messageId: "2", parentId: "1", source: "provider", kind: "reply", chosen: true }),
      )
      const bounded = await one.services.messages.search({ ...query, thread: { maxMessages: 1 } })
      expect(bounded.items[0]?.thread?.items).toHaveLength(1)
      expect(bounded.items[0]?.thread?.stopped).toContain("messages")
      expect(one.connection).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])("validates thread bounds on empty search with discovery=%s", async (discover) => {
    const one = await setup()
    await expect(
      one.services.messages.search({ text: "unmatched", limit: 10, discover, thread: { maxMessages: 0 } }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("accepts a stable locator but refuses another account's locator", async () => {
    const one = await setup()
    expect(ids(await one.services.messages.thread("msg:test/500/7/5"))).toEqual(["1", "3", "5", "6"])
    await expect(one.services.messages.thread("msg:test/600/7/5")).rejects.toMatchObject({ code: "validation_error" })
    await expect(one.services.messages.thread("msg:other/500/7/5")).rejects.toMatchObject({ code: "validation_error" })
    expect(one.connection).not.toHaveBeenCalled()
  })

  it("does not hide errors reading the store", async () => {
    const one = await setup()
    const broken: MessageStore = {
      ...one.store,
      messages: {
        ...one.store.messages,
        around: async () => {
          throw new Error("store unavailable")
        },
      },
    }
    await expect(readThreadContext(broken, account, "7", "5")).rejects.toThrow("store unavailable")
  })

  it("terminates an invalid cyclic graph", async () => {
    const one = await setup()
    const database = await openCache(one.path)
    database
      .prepare(`INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at, updated_at)
      SELECT m.chat_id, m.id, p.id, 'agent', 'answer', 1, 'synthetic', ?, 0 FROM messages m JOIN messages p ON p.external_id = '5'
      WHERE m.external_id = '1'`)
      .run(Date.now())
    database.close()
    const found = await one.services.messages.thread("7", "5")
    expect(found.stopped).toContain("cycle")
    expect(found.items.length).toBeLessThanOrEqual(4)
  })
})
