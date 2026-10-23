import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Chat, Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { storedDeps } from "./deps.js"
import { servicesFor } from "./index.js"

const account = { provider: "telegram", account: "1" }
const LEFT = "-1007"
const OLD = "-1008"
const NEW = "-1009"

const chat = (id: string): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

const message = (chatId: string): Message => ({
  id: "1",
  chatId,
  senderId: "500",
  senderName: "Ana",
  timestamp: "2026-10-19T10:00:00.000Z",
  editedAt: null,
  text: "kept",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const services = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "left-reads-")), "wirecat.db") })
  stores.push(store)
  await store.chats.saveChats(account, [chat(LEFT), chat(OLD)])
  await store.messages.saveMessages(account, LEFT, [message(LEFT)], { via: "history" })
  await store.messages.saveMessages(account, OLD, [message(OLD)], { via: "history" })
  await store.chats.rekeyChat(account, OLD, NEW)
  await store.chats.markChatsLeft(account, [])
  const messenger = { provider: "telegram", app: { command: "tg" } } as Messenger
  return servicesFor(storedDeps(messenger, store, account, {} as SendGuard))
}

describe("reads of a left chat's kept history by a numeric id", () => {
  it.each([
    [LEFT, LEFT],
    [OLD, NEW],
  ])("**%s finds the kept chat %s** in export, export by name, status and thread", async (typed, kept) => {
    const { archive, messages } = await services()

    expect((await archive.export(typed)).messages.map((one) => one.chatId)).toEqual([kept])
    expect((await archive.exportable({ chats: [typed] })).chats.map(({ id }) => id)).toEqual([kept])
    expect((await archive.status(typed)).map(({ chatId }) => chatId)).toEqual([kept])
    expect((await messages.thread(typed, "1")).chat).toBe(kept)
  })

  it.each([
    [LEFT, LEFT],
    [OLD, NEW],
  ])("**%s finds the kept chat %s** in a search by --chat or chat:, and in metadata show", async (typed, kept) => {
    const { messages, metadata } = await services()
    const chatsOf = async (request: Parameters<typeof messages.search>[0]) =>
      (await messages.search(request)).items.map(({ chatId }) => chatId)

    expect(await chatsOf({ text: "kept", limit: 5, chat: typed })).toEqual([kept])
    expect(await chatsOf({ text: `kept chat:"${typed}"`, limit: 5 })).toEqual([kept])
    expect((await metadata.get(typed)).chatId).toBe(kept)
  })

  it.each([LEFT, OLD])("**tracking members of %s is refused**: the account is no longer in it", async (typed) => {
    const { chats } = await services()

    await expect(chats.track(typed, true)).rejects.toThrow("you left chat")
  })
})
