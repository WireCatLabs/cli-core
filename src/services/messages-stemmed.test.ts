import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "../store/open.js"
import { resetStems } from "../store/sqlite/stems-fill.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import type { SearchFound } from "./messages.js"
import { searchStore, statsStore } from "./messages-archive-search.js"
import { searchLucene } from "./messages-search.js"

const account: AccountKey = { provider: "telegram", account: "1" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const message = (id: number, text: string): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "200",
  senderName: "alice",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, id)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const open = async (texts: string[], path = join(mkdtempSync(join(tmpdir(), "stemmed-")), "messages.db")) => {
  const store = await openStore({ path })
  live.push(store)
  await store.chats.saveChats(account, [
    { id: "7", title: "Chat 7", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "7",
    texts.map((text, i) => message(i + 1, text)),
    { via: "history" },
  )
  return { store, path }
}
const search = (store: MessageStore, text: string, options: { exact?: boolean; newest?: boolean } = {}) =>
  searchStore(store, account, { text, limit: 100, ...options })
const ids = async (store: MessageStore, text: string, options: { exact?: boolean; newest?: boolean } = {}) =>
  (await search(store, text, options)).items.map(({ id }) => Number(id))
const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    return error as CliError
  }
  throw new Error("the search did not fail")
}

const TEXTS = [
  "квартиру сдали в мае", // 1
  "квартира свободна", // 2
  "квартирант съехал", // 3
  "оплатил счёт вчера", // 4
  "оплатили счета", // 5
  "las canciones de verano", // 6
  "una canción", // 7
]

describe("stemmed strict search", () => {
  it("**finds other forms for a word and for quotes**; exact: and --exact do not", async () => {
    const { store } = await open(TEXTS)
    expect((await ids(store, "квартира")).sort()).toEqual([1, 2, 3])
    expect((await ids(store, '"квартира"')).sort()).toEqual([1, 2])
    expect((await ids(store, "canción")).sort()).toEqual([6, 7])
    expect(await ids(store, "exact:квартира")).toEqual([2])
    expect(await ids(store, "квартира", { exact: true })).toEqual([2])
    expect(await ids(store, '"квартира"', { exact: true })).toEqual([2])
  })

  it("**keeps quotes a phrase over stems**, and text: stems even under --exact", async () => {
    const { store } = await open(TEXTS)
    expect((await ids(store, '"оплатил счёт"')).sort()).toEqual([4, 5])
    expect(await ids(store, '"счёт оплатил"')).toEqual([])
    expect(await ids(store, 'exact:"оплатил счёт"')).toEqual([4])
    expect((await ids(store, "text:квартира", { exact: true })).sort()).toEqual([1, 2, 3])
  })

  it("**never stems a pattern**: text: and exact: wildcards read the words", async () => {
    const { store } = await open(TEXTS)
    expect((await ids(store, "text:кварти*")).sort()).toEqual([1, 2, 3])
    expect((await ids(store, "exact:кварти*")).sort()).toEqual([1, 2, 3])
  })

  it("**excludes every form** with -word, and only the exact form with -exact:word", async () => {
    const { store } = await open(TEXTS)
    expect((await ids(store, "кварти* -квартиру")).sort()).toEqual([3])
    expect(await ids(store, "кварти* -квартира")).toEqual([])
    expect((await ids(store, "кварти* -exact:квартира")).sort()).toEqual([1, 3])
  })

  it("**finds every word a word of 4 letters or more begins**, which Snowball stems apart", async () => {
    const { store } = await open(["купил журнал", "с журналом", "журналы лежат", "рост вырос", "тот рост", "ростовщик"])
    expect((await ids(store, "журнал")).sort()).toEqual([1, 2, 3])
    expect((await ids(store, "рост")).sort()).toEqual([4, 5, 6])
    expect((await ids(store, "тот")).sort()).toEqual([5])
  })

  it("**keeps a word whole where its stem is another word**: «домен» is not «дом»", async () => {
    const { store } = await open([
      "купил домен",
      "продлил доменов пять",
      "пришёл дом",
      "иду до дома",
      "кот спит",
      "с котами",
    ])
    expect((await ids(store, "домен")).sort()).toEqual([1, 2])
    expect((await ids(store, "котами")).sort()).toEqual([5, 6])
    expect((await search(store, "домен")).query?.stemming).toMatchObject({
      terms: [{ word: "домен", stem: "домен", stemmer: "russian" }],
    })
  })

  it("**ranks exact forms first** and marks the others, and says how it stemmed", async () => {
    const { store } = await open(["квартиру ищем", "квартиру снять", "квартира у моря", "квартиры дорогие"])
    const found: SearchFound = await search(store, "квартира")
    expect(found.items[0]).toMatchObject({ id: "3", exact: true })
    expect(found.items.slice(1).every(({ exact }) => exact === false)).toBe(true)
    expect(found.stemsReady).toBe(true)
    expect(found.query?.stemming).toEqual({
      applied: true,
      analyzer: "snowball-3.1.1 cyrillic=russian latin=english,spanish",
      terms: [{ word: "квартира", stem: "квартир", stemmer: "russian" }],
    })
    expect((await search(store, "exact:квартира")).query?.stemming).toBeUndefined()
    expect((await ids(store, "квартира", { newest: true })).length).toBe(4)
  })

  it("**fills a page from exact forms first**, and from other forms only when they run out", async () => {
    const { store } = await open(["квартиру ищем", "квартира у моря", "квартира в центре", "квартиры дорогие"])
    const page = await searchStore(store, account, { text: "квартира", limit: 2 })
    expect(page.items.map(({ exact }) => exact)).toEqual([true, true])
    expect(page.hasMore).toBe(true)
    const all = await searchStore(store, account, { text: "квартира", limit: 3 })
    expect(all.items.map(({ exact }) => exact)).toEqual([true, true, false])
    expect(all.hasMore).toBe(true)
  })

  it("**counts what it finds**: stats total equals the search's hits", async () => {
    const { store } = await open(TEXTS)
    const stats = await statsStore(store, account, { text: "квартира", limit: 10, by: "chat" })
    expect(stats.total).toBe(3)
    const exact = await statsStore(store, account, {
      text: "квартира",
      limit: 10,
      by: "chat",
      exact: true,
    })
    expect(exact.total).toBe(1)
  })

  it("**keeps every exact hit**, also one whose stems a different fold would lose", async () => {
    const { store } = await open(TEXTS)
    for (const word of ["квартира", "счёт", "canción", "verano"]) {
      const stemmed = new Set(await ids(store, word))
      for (const id of await ids(store, `exact:${word}`)) expect(stemmed.has(id)).toBe(true)
    }
  })

  it("**refuses a stemmed search while the stems are built by other choices**; exact: still runs", async () => {
    const { store, path } = await open(["running late", "she runs", "run now"])
    await store.searchIndex.saveStemmers({ cyrillic: "russian", latin: "english" })
    const refused = await failure(search(store, "running"))
    expect(refused.details).toMatchObject({
      reason: "index.not-ready",
      index: "message_stems",
      cause: "stemmer_changed",
      built: "snowball-3.1.1 cyrillic=russian latin=english,spanish",
      wanted: "snowball-3.1.1 cyrillic=russian latin=english",
    })
    expect(refused.message).toContain("store rebuild")
    expect(await ids(store, "exact:running")).toEqual([1])

    const database = await openCache(path)
    resetStems(database, { force: true })
    database.close()
    expect((await ids(store, "running")).sort()).toEqual([1, 2, 3])
  })

  it("**matches each word's own form while the stems are still building**, and says how far they are", async () => {
    const { store, path } = await open(TEXTS)
    const database = await openCache(path)
    database.exec("UPDATE search_index_state SET filled_through = 0, watermark = 7 WHERE name = 'message_stems'")
    database.close()
    // Past the 200 ms fill a search runs first, which would finish seven rows.
    const found = await searchLucene(store, account, { text: "квартира", limit: 10 })
    expect(found.items.map(({ id }) => Number(id))).toEqual([2])
    expect(found.stemsReady).toBe(false)
    expect(found.query?.stemming).toEqual({ applied: false, reason: "building", done: 0, total: 7, pending: 0 })
  })

  it("**still refuses stems the owner chose until store rebuild**", async () => {
    const { store } = await open(TEXTS)
    await store.searchIndex.saveStemmers({ cyrillic: "none", latin: "english" })
    const refused = await failure(searchLucene(store, account, { text: "квартира", limit: 10 }))
    expect(refused.details).toMatchObject({ reason: "index.not-ready", cause: "stemmer_changed" })
  })
})

describe("help for plain words", () => {
  it("**searches first the private chat a name points to**, and respells a word no message holds", async () => {
    const { store } = await open(["the invoice is paid", "invoice paid", "an invoice again", "noxvel launch"])
    await store.chats.saveChats(account, [
      { id: "8", title: "Robert Stone", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
      { id: "9", title: "Anna", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    const dialog = (chatId: string, texts: string[]) =>
      store.messages.saveMessages(
        account,
        chatId,
        texts.map((text, at) => ({ ...message(at + 1, text), chatId })),
        { via: "history" },
      )
    await dialog("8", ["Bobby, hi", "Bobby, how are you", "Bobby, any news", "my invoice for the website"])
    await dialog("9", ["the invoice came", "bobby pin"])

    const named = await search(store, "invoice Bobby")
    expect(named.named).toEqual({ word: "bobby", chatId: "8", title: "Robert Stone" })
    expect(named.items[0]).toMatchObject({ chatId: "8", id: "4" })
    expect((await search(store, "invoice")).named).toBeUndefined()

    const misspelt = await search(store, "ноксвел")
    expect(misspelt.respelled).toEqual({ ноксвел: ["noxvel"] })
    expect(misspelt.items.map(({ id }) => id)).toEqual(["4"])
    const nonsense = await search(store, "qzxvwpl")
    expect(nonsense.respelled).toBeUndefined()
    expect(nonsense.items).toEqual([])
  })
})
