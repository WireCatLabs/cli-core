import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { ChatUpdate, Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { chatsService } from "./chats.js"
import { storeModeDeps } from "./deps.js"
import { inboxService } from "./inbox.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = { check: () => {}, record: () => {} } as unknown as SendGuard

const messageIn = (chatId: string, id: string, minute: number): Message => ({
  id,
  chatId,
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 9, 22, 10, minute)).toISOString(),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const holding = async (chats: ChatUpdate[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "chat-state-")), "m.db") })
  opened.push(store)
  await store.chats.saveChats(account, chats)
  for (const { id } of chats)
    await store.messages.saveMessages(account, id, [messageIn(id, `${id}-1`, 1)], { via: "history" })
  return store
}

const chat = (id: string, fields: Partial<ChatUpdate> = {}): ChatUpdate => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 1,
  ...fields,
})

describe("a messenger whose inbox reads the store", () => {
  it("leaves out the chats stored as muted or archived, and takes in one marked unread", async () => {
    const store = await holding([
      chat("muted", { muted: true }),
      chat("archived", { archived: true }),
      chat("marked", { unreadCount: 0, markedUnread: true }),
      chat("plain"),
    ])

    const inbox = await inboxService(storeModeDeps(messenger, store, account, guard)).read({ limit: 20 })

    expect(inbox.chats.map((one) => one.id).sort()).toEqual(["marked", "plain"])
    expect(inbox.quiet).toBe(2)
  })

  it("stores a whole-chat read made here as nothing unread and no longer marked", async () => {
    const store = await holding([chat("7", { unreadCount: 3, markedUnread: true })])
    const adapter = {
      resolve: async () => ({ id: "7", title: "Chat 7", kind: "group" }),
      markRead: async () => {},
    } as unknown as MessengerAdapter
    const deps = { ...storeModeDeps(messenger, store, account, guard), connection: async () => adapter }

    await chatsService(deps).markRead({ chat: "7" })

    expect((await store.chats.chats(account, {})).items[0]).toMatchObject({ unreadCount: 0, markedUnread: false })
  })

  it("keeps the count after a read up to an older message", async () => {
    const store = await holding([chat("7", { unreadCount: 3 })])
    await store.messages.saveMessages(account, "7", [messageIn("7", "7-2", 2)], { via: "history" })
    const adapter = {
      resolve: async () => ({ id: "7", title: "Chat 7", kind: "group" }),
      markRead: async () => {},
    } as unknown as MessengerAdapter
    const deps = { ...storeModeDeps(messenger, store, account, guard), connection: async () => adapter }

    await chatsService(deps).markRead({ chat: "7", until: "7-1" })

    expect((await store.chats.chats(account, {})).items[0]?.unreadCount).toBe(3)
  })
})
