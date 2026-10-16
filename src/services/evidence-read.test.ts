import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseLocator } from "../domain/locator.js"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { readEvidencePacket } from "./evidence-read.js"

const account = { provider: "test", account: "owner" }
const message = (id: string, text = "Example message"): Message => ({
  id,
  chatId: "room",
  senderId: "author",
  senderName: "Example author",
  timestamp: "2026-10-02T09:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
const seeded = async (items = [message("a"), message("b"), message("c")]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "evidence-read-")), "m.db") })
  opened.push(store)
  await store.chats.saveChats(account, [
    {
      id: "room",
      title: "Example room",
      kind: "group",
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
      providerMetadata: { username: "ExampleRoom" },
    },
  ])
  await store.messages.saveMessages(account, "room", items, { via: "test" })
  return store
}
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const ids = (packet: Awaited<ReturnType<typeof readEvidencePacket>>) =>
  packet.items.map(({ locator }) => parseLocator(locator).message)

describe("stored evidence", () => {
  it("pages newest first with exclusive cursors, including equal timestamps and opaque ids", async () => {
    const store = await seeded()
    await store.messages.saveMessages({ ...account, account: "another" }, "room", [message("private")], { via: "test" })
    const first = await readEvidencePacket(store, account, { chat: "Example", limit: 2 })
    expect(ids(first)).toEqual(["c", "b"])
    expect(first).toMatchObject({
      kind: "chats",
      source: { ...account, chat: "room" },
      nextBeforeId: "b",
      coverage: { provided: 2, included: 2, omitted: 0, hasMore: true, history: "unknown" },
    })
    const next = await readEvidencePacket(store, account, { chat: "room", limit: 2, before: first.nextBeforeId ?? "" })
    expect(ids(next)).toEqual(["a"])
    expect(next.nextBeforeId).toBeNull()
    expect(next.coverage.hasMore).toBe(false)
    expect((await readEvidencePacket(store, account, { chat: "room", limit: 2 })).fingerprint).toBe(first.fingerprint)
  })

  it("keeps the newest prefix under the byte cap and does not skip omitted messages on the next page", async () => {
    const store = await seeded([message("a", "世界🌍".repeat(4000)), message("b", "Привет".repeat(5000))])
    const first = await readEvidencePacket(store, account, { chat: "room", limit: 2 })
    expect(ids(first)).toEqual(["b"])
    expect(first.coverage).toMatchObject({ provided: 2, included: 1, omitted: 1, hasMore: false, truncatedBy: "bytes" })
    expect(first.contentBytes).toBeLessThanOrEqual(64 * 1024)
    expect(first.nextBeforeId).toBe("b")
    const next = await readEvidencePacket(store, account, { chat: "room", limit: 2, before: "b" })
    expect(ids(next)).toEqual(["a"])
    expect(next.nextBeforeId).toBeNull()
  })

  it("reports an oversized newest message as an obstruction without advancing past it", async () => {
    const store = await seeded([message("a"), message("b", "x".repeat(64 * 1024))])
    const packet = await readEvidencePacket(store, account, { chat: "room", limit: 2 })
    expect(packet).toMatchObject({ items: [], nextBeforeId: null, contentBytes: 2 })
    expect(packet.coverage).toMatchObject({ provided: 2, omitted: 2, truncatedBy: "bytes", history: "unknown" })
  })

  it("resolves stored usernames and Saved Messages aliases", async () => {
    const store = await seeded()
    expect(ids(await readEvidencePacket(store, account, { chat: "@exampleroom", limit: 1 }))).toEqual(["c"])
    const saved = await readEvidencePacket(store, account, { chat: "me", limit: 1 }, { savedChatId: () => "room" })
    expect(ids(saved)).toEqual(["c"])
  })

  it("returns an empty packet without claiming complete history", async () => {
    const store = await seeded([])
    expect(await readEvidencePacket(store, account, { chat: "room", limit: 2 })).toMatchObject({
      items: [],
      nextBeforeId: null,
      coverage: { provided: 0, included: 0, omitted: 0, hasMore: false, history: "unknown", truncatedBy: null },
    })
  })

  it("refuses missing chats and anchors with typed errors", async () => {
    const store = await seeded()
    await expect(readEvidencePacket(store, account, { chat: "missing", limit: 2 })).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(
      readEvidencePacket(store, account, { chat: "room", limit: 2, before: "missing" }),
    ).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it.each([0, -1, 101, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid message limit %s", async (limit) => {
    const store = await seeded()
    await expect(readEvidencePacket(store, account, { chat: "room", limit })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("refuses an empty cursor", async () => {
    const store = await seeded()
    await expect(readEvidencePacket(store, account, { chat: "room", limit: 2, before: " " })).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})
