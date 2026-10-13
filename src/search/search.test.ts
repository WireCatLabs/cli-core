import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "../store/open.js"
import { type AccountKey, historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { parseQuery } from "./query.js"
import { search } from "./search.js"

const ME: AccountKey = { provider: "telegram", account: "100" }

/** The owner's six messages (docs/storage/search-indexes.md, "Scenarios"). */
const SIX = [
  "¿Alguien conoce un buen gestor en València?",
  "Order AB45217 arrived, tracking ab-99812",
  "Сдаю квартиру в центре, пишите в whatsapp",
  "Tiempo de espera para la TIE: dos meses",
  "My calendly.com/ptsarev link for the TV setup",
  "Entiendo, gracias",
]

const message = (id: string, text: string, minute: number): Message => ({
  id,
  chatId: "1",
  senderId: "7",
  senderName: "Ana",
  timestamp: new Date(Date.UTC(2026, 8, 1, 10, minute)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

let store: MessageStore
let path: string
beforeAll(async () => {
  path = join(mkdtempSync(join(tmpdir(), "search-")), "messages.db")
  store = await openStore({ path })
  await store.saveChats(ME, [
    { id: "1", title: "Valencia", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(
    ME,
    "1",
    SIX.map((text, index) => message(String(index + 1), text, index)),
    { via: "history" },
  )
  await store.fillSearchIndex()
})
afterAll(async () => store.close())

const run = async (query: string) => {
  const { after, before, ...parsed } = parseQuery(query)
  const scope = {
    accounts: [ME],
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
  }
  const found = await search(store, parsed, scope, { limit: 10 })
  return { ids: found.items.map((hit) => hit.id), match: found.items[0]?.match, corrections: found.corrections }
}

describe("the search, over the owner's scenarios", () => {
  it.each([
    ["gestor valencia", ["1"], "words"],
    ["whatsap", ["3"], "beginnings"],
    ["квартир", ["3"], "beginnings"],
    // The table found València too; this store's substring index keeps accents, so "len" misses "lèn".
    ["len", ["5"], "substring"],
    ["45217", ["2"], "substring"],
    ["99812", ["2"], "words"],
    ["tie", ["4"], "words"],
    ["tv", ["5"], "words"],
  ])("%s finds %j by %s", async (query, ids, match) => {
    expect(await run(query)).toMatchObject({ ids, match })
  })

  it("**corrects Valenca to valencia**, and says so", async () => {
    expect(await run("Valenca")).toEqual({
      ids: ["1"],
      match: "corrected",
      corrections: [{ from: "Valenca", to: ["valencia"] }],
    })
  })

  it("finds ptsarev from part of it — corrected, as the vocabulary is nearer than the substring", async () => {
    expect(await run("sarev")).toMatchObject({ ids: ["5"] })
  })

  it("**falls back to any word** when no message has every word, and not when OR chose", async () => {
    expect(await run("gestor whatsapp")).toMatchObject({ match: "anyWord" })
    expect((await run("gestor whatsapp")).ids.sort()).toEqual(["1", "3"])
    expect(await run("gestor OR nadie whatsapp")).toMatchObject({ ids: [] })
  })

  it("lists by filters alone, newest first", async () => {
    expect(await run("before:2026-09-02")).toMatchObject({ ids: ["6", "5", "4", "3", "2", "1"], match: "filters" })
    expect(await run("after:2026-09-02")).toMatchObject({ ids: [] })
  })

  it("**answers by substring alone until the word index is built**, and says so", async () => {
    const database = await openCache(path)
    database.exec("UPDATE search_index_state SET filled_through = 0, watermark = 99")
    database.close()
    const found = await search(store, parseQuery("gestor"), { accounts: [ME] }, { limit: 10 })
    const filtered = await search(store, parseQuery("before:2026-09-02"), { accounts: [ME] }, { limit: 10 })
    const restore = await openCache(path)
    restore.exec("UPDATE search_index_state SET filled_through = 6, watermark = 6")
    restore.close()

    expect(found).toMatchObject({ wordsReady: false, items: [{ id: "1", match: "substring" }] })
    expect(filtered.wordsReady).toBe(false)
    expect(filtered.items[0]).toMatchObject({ match: "filters" })
    expect(await search(store, parseQuery("before:2026-09-02"), { accounts: [ME] }, { limit: 1 })).toMatchObject({
      wordsReady: true,
    })
  })
})

describe("completeness", () => {
  it("**is unknown for a chat nobody fetched**, and complete once fetched to its start without gaps", async () => {
    expect(await store.chatCompleteness(ME, ["1"])).toEqual([
      { chatId: "1", state: "unknown", upToDate: null, gaps: false, reachesStart: false, fetchedAt: null },
    ])

    await store.markRange(ME, "1", 1, 6)
    await store.setSyncState(ME, historyStartKey("1"), "1")
    expect((await store.chatCompleteness(ME, ["1"]))[0]).toMatchObject({ state: "complete", reachesStart: true })

    await store.markRange(ME, "1", 9, 10)
    expect((await store.chatCompleteness(ME, ["1"]))[0]).toMatchObject({ state: "partial", gaps: true })
  })

  it("**answers for more chats than SQLite takes parameters**", async () => {
    const many = Array.from({ length: 200_000 }, (_, at) => `missing-${at}`)
    expect((await store.chatCompleteness(ME, [...many, "1"])).map(({ chatId }) => chatId)).toEqual(["1"])
  })

  it("**stops counting a start mark once older messages are held**, so a wrong mark heals with the next fetch", async () => {
    const chat = { id: "40", title: "Marked", kind: "group" as const, unreadCount: 0, lastMessageAt: null }
    await store.saveChats(ME, [{ ...chat, participantsCount: null }])
    await store.markRange(ME, "40", 4, 6)
    await store.setSyncState(ME, historyStartKey("40"), "4")
    expect((await store.chatCompleteness(ME, ["40"]))[0]).toMatchObject({ state: "complete", reachesStart: true })

    await store.markRange(ME, "40", 2, 6)
    expect((await store.chatCompleteness(ME, ["40"]))[0]).toMatchObject({ state: "partial", reachesStart: false })
  })
})
