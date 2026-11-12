import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "./store.js"

const account = { provider: "test", account: "500" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const message = (id: number, chatId: string, minute: number): Message => ({
  id: String(id),
  chatId,
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString(),
  editedAt: null,
  text: `note ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

it("gives each chat's title, count and newest message as chatStats does, past tombstones and empty chats", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "chats-newest-")), "m.db") })
  live.push(store)
  await store.chats.saveChats(
    account,
    ["1", "2", "3", "4"].map((id) => ({
      id,
      title: `Chat ${id}`,
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
    })),
  )
  await store.messages.saveMessages(account, "1", [message(1, "1", 5), message(2, "1", 9), message(3, "1", 7)], {
    via: "history",
  })
  await store.messages.saveMessages(account, "2", [message(4, "2", 3)], { via: "history" })
  await store.messages.saveMessages(account, "3", [message(5, "3", 1)], { via: "history" })
  await store.messages.markDeleted(account, ["2"], { chatId: "1" })
  await store.messages.markDeleted(account, ["5"], { chatId: "3" })

  const slow = (await store.chats.chatStats(account)).map(({ chatId, title, messages, newestAt }) => ({
    chatId,
    title,
    messages,
    newestAt,
  }))
  const fast = await store.chats.chatsNewest(account)
  expect(fast.sort((a, b) => a.chatId.localeCompare(b.chatId))).toEqual(
    slow.sort((a, b) => a.chatId.localeCompare(b.chatId)),
  )
  expect(fast.map(({ chatId, newestAt }) => [chatId, newestAt])).toEqual([
    ["1", "2026-11-01T00:07:00.000Z"],
    ["2", "2026-11-01T00:03:00.000Z"],
  ])
})
