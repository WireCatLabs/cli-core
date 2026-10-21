import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ChatUpdate, Message } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "whatsapp", account: "1@lid" }
const CHAT = "7@lid"
const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 10, minute)).toISOString()

const opened = async (clock = { now: Date.parse(at(0)) }) => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "chat-state-")), "wirecat.db"),
    now: () => clock.now,
  })
  const stored = async () => (await store.chats.chats(OWNER, {})).items.find((one) => one.id === CHAT)
  const save = (fields: Partial<ChatUpdate>) => store.chats.saveChats(OWNER, [{ id: CHAT, kind: "dialog", ...fields }])
  return { store, stored, save, clock }
}

const message = (id: string, minute: number, fields: Partial<Message> = {}): Message => ({
  id,
  chatId: CHAT,
  senderId: "7@lid",
  senderName: "Olga",
  timestamp: at(minute),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...fields,
})

describe("a chat's state from the phone", () => {
  it("keeps muted, archived and marked unread, and an update that does not name them leaves them", async () => {
    const { store, stored, save } = await opened()
    await save({ title: "Olga", muted: true, archived: true, markedUnread: true })
    await save({ title: "Olga K", unreadCount: 2, lastMessageAt: at(5) })

    expect(await stored()).toMatchObject({ title: "Olga K", muted: true, archived: true, markedUnread: true })
    expect((await stored())?.mutedUntil).toBeUndefined()
    await save({ muted: false, archived: false, markedUnread: false })
    expect(await stored()).toMatchObject({ muted: false, archived: false, markedUnread: false })
    await store.close()
  })

  it("says nothing of a state no messenger gave", async () => {
    const { store, stored, save } = await opened()
    await save({ title: "Olga" })
    const chat = await stored()
    expect(chat && ["muted", "mutedUntil", "archived", "markedUnread"].filter((key) => key in chat)).toEqual([])
    await store.close()
  })

  it("reads a mute as over once its end has passed, without a write", async () => {
    const { store, stored, save, clock } = await opened()
    await save({ muted: true, mutedUntil: at(30) })
    expect(await stored()).toMatchObject({ muted: true, mutedUntil: at(30) })

    clock.now = Date.parse(at(30))
    expect(await stored()).toMatchObject({ muted: false })
    expect((await stored())?.mutedUntil).toBeUndefined()
    await store.close()
  })

  it("takes an unmute as clearing the end, and a mute without an end as for good", async () => {
    const { store, stored, save, clock } = await opened()
    await save({ muted: true, mutedUntil: at(30) })
    await save({ muted: false })
    await save({ muted: true })
    clock.now = Date.parse(at(59))
    expect(await stored()).toMatchObject({ muted: true })
    expect((await stored())?.mutedUntil).toBeUndefined()
    await store.close()
  })
})

describe("unread counted by the store", () => {
  const counting = { via: "update", countUnread: true } as const

  it("adds each new message from someone else sent after the messenger's count", async () => {
    const { store, stored, save } = await opened()
    await save({ unreadCount: 1, lastMessageAt: at(5) })
    await store.messages.saveMessages(OWNER, CHAT, [message("old", 5), message("new", 6)], counting)
    await store.messages.saveMessages(OWNER, CHAT, [message("new", 6)], counting)
    await store.messages.saveMessages(OWNER, CHAT, [message("mine", 7, { outgoing: true })], counting)
    await store.messages.saveMessages(OWNER, CHAT, [message("edit", 8, { editedAt: at(8) })], counting)

    expect((await stored())?.unreadCount).toBe(2)
    await store.close()
  })

  it("starts again from a read", async () => {
    const { store, stored, save, clock } = await opened()
    await save({ unreadCount: 4, lastMessageAt: at(5) })
    clock.now = Date.parse(at(10))
    await save({ unreadCount: 0 })
    await store.messages.saveMessages(OWNER, CHAT, [message("queued", 9), message("after", 11)], counting)

    expect((await stored())?.unreadCount).toBe(1)
    await store.close()
  })

  it("leaves a chat the messenger never counted, and a save that does not ask", async () => {
    const { store, stored, save } = await opened()
    await save({ title: "Olga" })
    await store.messages.saveMessages(OWNER, CHAT, [message("a", 6)], counting)
    expect((await stored())?.unreadCount).toBeNull()

    await save({ unreadCount: 0, lastMessageAt: at(6) })
    await store.messages.saveMessages(OWNER, CHAT, [message("b", 7)], { via: "update" })
    expect((await stored())?.unreadCount).toBe(0)
    await store.close()
  })
})
