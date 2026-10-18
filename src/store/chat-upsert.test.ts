import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, ChatUpdate } from "../domain/models.js"
import { storedChatId } from "../services/message-resolution.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "chat-upsert-")), "messages.db")
const OWNER: AccountKey = { provider: "whatsapp", account: "1" }

const chat = (id: string, fields: Partial<Chat> = {}): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
  ...fields,
})

const saving = async (...pushes: ChatUpdate[][]) => {
  const store = await openStore({ path: fresh() })
  for (const push of pushes) await store.chats.saveChats(OWNER, push)
  const stored = (id: string) => store.chats.chats(OWNER, {}).then(({ items }) => items.find((one) => one.id === id))
  return { store, stored }
}

describe("saving a chat the store already holds", () => {
  it("keeps a metadata key the new push leaves out", async () => {
    const { store, stored } = await saving(
      [chat("community", { providerMetadata: { community: true } })],
      [chat("community"), chat("community", { providerMetadata: { announce: true } })],
    )
    expect((await stored("community"))?.providerMetadata).toEqual({ community: true, announce: true })
    await store.close()
  })

  it("removes a metadata key set to null, and the whole metadata once no key is left", async () => {
    const { store, stored } = await saving(
      [chat("a", { providerMetadata: { pinned: true, username: "team" } })],
      [chat("a", { providerMetadata: { pinned: null } })],
    )
    expect((await stored("a"))?.providerMetadata).toEqual({ username: "team" })
    await store.chats.saveChats(OWNER, [chat("a", { providerMetadata: { username: null } })])
    expect((await stored("a"))?.providerMetadata).toBeUndefined()
    await store.close()
  })

  it("never stores a null key on a chat it saves for the first time", async () => {
    const { store, stored } = await saving([chat("a", { providerMetadata: { isBot: null, chatType: "group" } })])
    expect((await stored("a"))?.providerMetadata).toEqual({ chatType: "group" })
    await store.close()
  })

  it("takes every field of a full update", async () => {
    const { store, stored } = await saving(
      [chat("a", { parentChatId: "p1", providerMetadata: { username: "old" }, unreadCount: 3 })],
      [chat("a", { title: "Renamed", parentChatId: "p2", providerMetadata: { username: "new" }, unreadCount: 0 })],
    )
    expect(await stored("a")).toMatchObject({
      title: "Renamed",
      parentChatId: "p2",
      providerMetadata: { username: "new" },
      unreadCount: 0,
    })
    await store.close()
  })

  it("keeps the title, counts and last activity a notice leaves out, and clears the parent it names", async () => {
    const held = { title: "Team", unreadCount: 4, lastMessageAt: "2026-10-01T09:00:00.000Z", participantsCount: 12 }
    const { store, stored } = await saving(
      [chat("group", { ...held, parentChatId: "community" })],
      [{ id: "group", kind: "group", parentChatId: null }],
    )
    const after = await stored("group")
    expect(after).toMatchObject(held)
    expect(after?.parentChatId).toBeUndefined()
    await store.close()
  })

  it("clears only the fields an update sets to null", async () => {
    const { store, stored } = await saving(
      [chat("a", { unreadCount: 4, lastMessageAt: "2026-10-01T09:00:00.000Z", participantsCount: 12 })],
      [{ id: "a", kind: "group", unreadCount: null, lastMessageAt: null }],
    )
    expect(await stored("a")).toMatchObject({
      title: "Chat a",
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: 12,
    })
    await store.chats.saveChats(OWNER, [{ id: "a", kind: "group", title: null }])
    expect((await stored("a"))?.title).toBeNull()
    await store.close()
  })

  it("stores none of the fields a first save leaves out", async () => {
    const { store, stored } = await saving([{ id: "a", kind: "group" }])
    expect(await stored("a")).toMatchObject({
      title: null,
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: null,
    })
    await store.close()
  })

  it("keeps the parent when the push leaves it out, and clears it on null", async () => {
    const { store, stored } = await saving([chat("group", { parentChatId: "community" })], [chat("group")])
    expect((await stored("group"))?.parentChatId).toBe("community")
    await store.chats.saveChats(OWNER, [chat("group", { parentChatId: null })])
    expect((await stored("group"))?.parentChatId).toBeUndefined()
    await store.close()
  })

  it("keeps a dialog's partner through a login catch-up that names the chat without metadata", async () => {
    const { store, stored } = await saving([chat("d1", { kind: "dialog", providerMetadata: { partnerId: "7" } })])
    await store.sync.applyDelta(OWNER, { chats: [chat("d1", { kind: "dialog" })] })
    expect((await stored("d1"))?.providerMetadata).toEqual({ partnerId: "7" })
    await store.close()
  })

  it("stops resolving a username the chat gave up", async () => {
    const dialog = (username: string | null) => chat("42", { kind: "dialog", providerMetadata: { username } })
    const { store } = await saving([dialog("old")])
    expect(await storedChatId({}, "@old", store, OWNER)).toBe("42")
    await store.chats.saveChats(OWNER, [dialog(null)])
    await expect(storedChatId({}, "@old", store, OWNER)).rejects.toThrow("no stored chat is @old")
    await store.close()
  })
})
