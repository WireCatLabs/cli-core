import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { conversationsService } from "./conversations.js"
import { storedDeps } from "./deps.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat", app: { command: "chat" } } as Messenger

const message = (id: number, sender: string, text: string, replyToId?: string): Message => ({
  id: String(id),
  chatId: "7",
  senderId: sender,
  senderName: sender,
  timestamp: new Date(Date.parse("2026-09-27T10:00:00.000Z") + id * 3_600_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const service = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "conversations-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [
    { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  ])
  await store.saveMessages(
    account,
    "7",
    [
      message(1, "9", "who has the book?"),
      message(2, "8", "I do", "1"),
      message(3, "6", "and the next meeting?"),
      message(4, "9", "Friday", "3"),
      message(5, "8", "thanks, I'll bring it", "2"),
    ],
    { via: "history" },
  )
  return conversationsService(storedDeps(messenger, store, account, {} as SendGuard))
}

describe("the conversations service", () => {
  it("**builds a chat** and reads its conversations back, by id and by a message in one", async () => {
    const conversations = await service()

    expect(await conversations.build("7")).toMatchObject({ chat: "7", messages: 5, links: 3, conversations: 2 })

    const { items } = await conversations.list("7", { limit: 10 })
    expect(items.map(({ first_message, messages_count }) => [first_message, messages_count])).toEqual([
      ["msg:test/500/7/3", 2],
      ["msg:test/500/7/1", 3],
    ])
    const byId = await conversations.show({ id: items[1]?.id as string })
    expect(byId.messages.map(({ id }) => id)).toEqual(["1", "2", "5"])
    expect(await conversations.show({ chat: "7", message: "5" })).toEqual(byId)
  })

  it("**says why** a message is where it is: its chosen link and the chain back to the start", async () => {
    const conversations = await service()
    await conversations.build("7")

    const found = await conversations.links("7", "5")

    expect(found.links).toMatchObject([{ parentId: "2", source: "provider", kind: "reply", chosen: true }])
    expect(found.chain).toEqual(["2", "1"])
  })

  it("names the command that builds a chat not built yet", async () => {
    const conversations = await service()

    await expect(conversations.list("7", { limit: 10 })).rejects.toThrow("chat conversations build --chat 7")
    await expect(conversations.show({ chat: "7", message: "1" })).rejects.toThrow("conversations build")
  })

  it("refuses to build a chat the store holds nothing of", async () => {
    const conversations = await service()

    await expect(conversations.build("404")).rejects.toThrow(/holds no messages/)
  })
})
