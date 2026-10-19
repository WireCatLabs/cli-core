import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "whatsapp", account: "1@lid" }
const OTHER: AccountKey = { provider: "whatsapp", account: "2@lid" }
const PHONE = "34600000001@s.whatsapp.net"
const LID = "777@lid"

const dialog = (id: string): Chat => ({
  id,
  title: "Ana",
  kind: "dialog",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const fresh = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "aliases-")), "wirecat.db") })
  opened.push(store)
  await store.chats.saveChats(OTHER, [dialog(PHONE)])
  return store
}

describe("the id a chat was re-keyed from", () => {
  it("names the renamed chat, in its own account only", async () => {
    const store = await fresh()
    await store.chats.saveChats(OWNER, [dialog(PHONE)])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await store.chats.aliasedChat(OWNER, PHONE)).toBe(LID)
    expect(await store.chats.aliasedChat(OTHER, PHONE)).toBeUndefined()
    expect(await store.forAccount(OWNER).chats.aliasedChat(PHONE)).toBe(LID)
  })

  it("names the kept chat after a merge, and so do the ids the absorbed twin was re-keyed from", async () => {
    const store = await fresh()
    await store.chats.saveChats(OWNER, [dialog("old@lid"), dialog(PHONE)])
    await store.chats.rekeyChat(OWNER, "old@lid", LID)
    await store.chats.saveChats(OWNER, [dialog(PHONE)])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await store.chats.aliasedChat(OWNER, PHONE)).toBe(LID)
    expect(await store.chats.aliasedChat(OWNER, "old@lid")).toBe(LID)
  })

  it("is kept when the old id was never stored but the new one is", async () => {
    const store = await fresh()
    await store.chats.saveChats(OWNER, [dialog(LID)])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await store.chats.aliasedChat(OWNER, PHONE)).toBe(LID)
  })

  it("follows a later re-key of the chat it names", async () => {
    const store = await fresh()
    await store.chats.saveChats(OWNER, [dialog(PHONE)])
    await store.chats.rekeyChat(OWNER, PHONE, LID)

    await store.chats.rekeyChat(OWNER, LID, "888@lid")

    expect(await store.chats.aliasedChat(OWNER, PHONE)).toBe("888@lid")
    expect(await store.chats.aliasedChat(OWNER, LID)).toBe("888@lid")
  })

  it("gives way to a chat stored again under the old id", async () => {
    const store = await fresh()
    await store.chats.saveChats(OWNER, [dialog(PHONE)])
    await store.chats.rekeyChat(OWNER, PHONE, LID)

    await store.chats.saveChats(OWNER, [dialog(PHONE)])

    expect(await store.chats.aliasedChat(OWNER, PHONE)).toBeUndefined()
  })

  it("goes with the chat it names when that chat is cleared", async () => {
    const store = await fresh()
    await store.chats.saveChats(OWNER, [dialog(PHONE)])
    await store.chats.rekeyChat(OWNER, PHONE, LID)
    await store.chats.markChatsLeft(OWNER, [])

    await store.chats.leftChats(OWNER, { clear: true })

    expect(await store.chats.aliasedChat(OWNER, PHONE)).toBeUndefined()
  })
})
