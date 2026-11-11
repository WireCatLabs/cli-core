import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"

const account: AccountKey = { provider: "telegram", account: "1" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const message = (id: number, chatId: string, text: string): Message => ({
  id: String(id),
  chatId,
  senderId: "200",
  senderName: "alice",
  timestamp: new Date(Date.UTC(2026, 0, id, 10)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const TEXTS: Record<string, string[]> = {
  "1": [
    "Договор подписан",
    "ДОГОВОРЫ на столе",
    "переговоры завтра",
    "ёлка во дворе",
    "елка в лесу",
    "отчёт за квартал",
  ],
  "2": ["договор с банком", "просто текст", "Отчет готов"],
  // Over the word list's budget, so a pattern read through it would be refused.
  "3": [Array.from({ length: 10_001 }, (_, at) => `w${at.toString(36)}x`).join(" ")],
}
const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "lucene-infix-")), "messages.db") })
  live.push(store)
  await store.chats.saveChats(
    account,
    Object.keys(TEXTS).map((id) => ({
      id,
      title: `Chat ${id}`,
      kind: "group",
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
    })),
  )
  let id = 0
  for (const [chat, texts] of Object.entries(TEXTS))
    await store.messages.saveMessages(
      account,
      chat,
      texts.map((text) => message(++id, chat, text)),
      { via: "history" },
    )
  return store
}
const ids = async (store: MessageStore, text: string) =>
  (await searchStore(store, account, { text, limit: 50 })).items.map(({ id }) => Number(id)).sort((a, b) => a - b)

describe("a part inside a word in chat messages", () => {
  it("**\\*говор\\*** finds the part in any case, inside and at either end of a word", async () => {
    const store = await seeded()
    expect(await ids(store, "*говор*")).toEqual([1, 2, 3, 7])
    expect(await ids(store, "text:*ГОВОР*")).toEqual([1, 2, 3, 7])
    expect(await ids(store, "exact:*говор*")).toEqual([1, 2, 3, 7])
  })

  it("reads ё and е as one letter, typed either way", async () => {
    const store = await seeded()
    expect(await ids(store, "*ёлк*")).toEqual([4, 5])
    expect(await ids(store, "*елк*")).toEqual([4, 5])
    expect(await ids(store, "*тчет*")).toEqual([6, 9])
  })

  it("keeps a word's end and a single letter where the pattern puts them", async () => {
    const store = await seeded()
    expect(await ids(store, "*говор")).toEqual([1, 7])
    expect(await ids(store, "*гов?ры")).toEqual([2, 3])
    expect(await ids(store, "*дог*вор")).toEqual([1, 7])
  })

  it("works inside AND, OR, NOT and groups, and with chat: and date:", async () => {
    const store = await seeded()
    expect(await ids(store, "*говор* AND chat:2")).toEqual([7])
    expect(await ids(store, "*говор* AND NOT *ереговор*")).toEqual([1, 2, 7])
    expect(await ids(store, "*говор* -банком")).toEqual([1, 2, 3])
    expect(await ids(store, "(*ёлк* OR *тчет*) AND chat:1")).toEqual([4, 5, 6])
    expect(await ids(store, "*говор* AND date>=2026-01-03")).toEqual([3, 7])
    expect(await ids(store, "*говор AND NOT chat:2")).toEqual([1])
    expect(await ids(store, "NOT *говор* AND chat:2")).toEqual([8, 9])
    expect(await ids(store, "NOT *говор AND chat:1")).toEqual([2, 3, 4, 5, 6])
  })
})
