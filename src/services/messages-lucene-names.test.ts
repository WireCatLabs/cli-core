import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"

const account: AccountKey = { provider: "telegram", account: "100" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const chat = (id: string, title: string): Chat => ({
  id,
  title,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})
const message = (id: string, chatId: string, senderId: string, senderName: string): Message => ({
  id,
  chatId,
  senderId,
  senderName,
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text: `note ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const SENDERS: [string, string][] = [
  ["300", "Ярослав"],
  ["301", "ярослав"],
  ["302", "Ярослав Орлов"],
  ["303", "Иван Петров"],
]

const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "lucene-names-")), "messages.db") })
  live.push(store)
  await store.chats.saveChats(account, [chat("1", "Отчёты Q1"), chat("2", "Отчеты Q2"), chat("3", "Семья")])
  await store.messages.saveMessages(
    account,
    "1",
    SENDERS.map(([id, name], at) => message(String(at + 1), "1", id, name)),
    { via: "history" },
  )
  await store.messages.saveMessages(account, "2", [message("10", "2", "303", "Иван Петров")], { via: "history" })
  await store.messages.saveMessages(account, "3", [message("20", "3", "302", "Ярослав Орлов")], { via: "history" })
  return store
}
const ids = async (store: MessageStore, text: string) =>
  (await searchStore(store, account, { text, limit: 50 })).items.map(({ id }) => Number(id)).sort((a, b) => a - b)
const failure = async (store: MessageStore, text: string) =>
  searchStore(store, account, { text, limit: 50 }).then(
    () => undefined,
    (error: unknown) => error as { code: string; message: string; details: Record<string, unknown> },
  )

describe("name patterns in from: and chat:", () => {
  it("**from:Ярослав*** finds everyone whose name starts so, and *Орлов* anywhere in it", async () => {
    const store = await seeded()
    expect(await ids(store, "from:Ярослав*")).toEqual([1, 2, 3, 20])
    expect(await ids(store, "from:*Орлов*")).toEqual([3, 20])
    expect(await ids(store, "from:*орлов")).toEqual([3, 20])
    expect(await ids(store, "from:Ярослав\\ О*")).toEqual([3, 20])
    expect(await ids(store, "from:Яр?слав")).toEqual([1, 2])
    expect(await ids(store, "from:Ярослав* NOT from:*Орлов")).toEqual([1, 2])
    expect(await ids(store, "chat:3 AND from:(Ив* OR Яр*)")).toEqual([20])
  })

  it("**chat:*отчет*** finds every chat whose title holds it, ё read as е", async () => {
    const store = await seeded()
    expect(await ids(store, "chat:*отчет*")).toEqual([1, 2, 3, 4, 10])
    expect(await ids(store, "chat:Сем*")).toEqual([20])
  })

  it("keeps an exact from: name, and lists the names that only contain it when it is ambiguous", async () => {
    const store = await seeded()
    expect(await ids(store, 'from:"Иван Петров"')).toEqual([4, 10])
    expect(await ids(store, "from:303")).toEqual([4, 10])
    const error = await failure(store, 'from:"Ярослав"')
    expect(error?.code).toBe("validation_error")
    expect(((error?.details.candidates ?? []) as { id: string }[]).map(({ id }) => id).sort()).toEqual([
      "300",
      "301",
      "302",
    ])
  })

  it("refuses a pattern that fits nobody, naming the near names, or too many people", async () => {
    const store = await seeded()
    const missing = await failure(store, "from:Ярослва*")
    expect(missing?.code).toBe("not_found")
    expect(missing?.message).toContain("Ярослав")
    expect(missing?.details.candidates).toContainEqual({ id: "300", name: "Ярослав", username: null })
    await store.messages.saveMessages(
      account,
      "3",
      Array.from({ length: 51 }, (_, at) => message(String(100 + at), "3", String(1000 + at), `Bot ${at}`)),
      { via: "history" },
    )
    const broad = await failure(store, "from:Bot*")
    expect(broad?.details.reason).toBe("query.too-large")
    expect(broad?.message).toContain("more than 50")
  })

  it("lets topic: lean on a pattern that fits one chat only", async () => {
    const store = await seeded()
    expect(await ids(store, "chat:Сем* AND topic:42")).toEqual([])
    expect((await failure(store, "chat:*отчет* AND topic:42"))?.message).toContain("query.topic-scope")
  })

  it("finds *word* in a large vocabulary, and refuses a part under three letters with the word's start as the way out", async () => {
    const store = await seeded()
    expect(await ids(store, "*ote")).toEqual([1, 2, 3, 4, 10, 20])
    const words = Array.from({ length: 10_001 }, (_, at) => `w${at.toString(36)}x`)
    await store.messages.saveMessages(
      account,
      "3",
      [{ ...message("30", "3", "303", "Иван Петров"), text: words.join(" ") }],
      {
        via: "history",
      },
    )
    expect(await ids(store, "*note*")).toEqual([1, 2, 3, 4, 10, 20])
    const short = await failure(store, "*no*")
    expect(short?.details.reason).toBe("query.too-large")
    expect(short?.message).toContain("three or more between the stars")
    expect(short?.message).toContain("no*")
  })
})
