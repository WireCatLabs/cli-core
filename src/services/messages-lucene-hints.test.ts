import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import type { AppIdentity } from "../ports/app.js"
import { QUERY_LIMITS } from "../search/lucene/types.js"
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
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, id)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const open = async (texts: Record<string, string[]>) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "lucene-hints-")), "messages.db") })
  live.push(store)
  const chats = Object.keys(texts)
  await store.chats.saveChats(
    account,
    chats.map((id) => ({
      id,
      title: `Chat ${id}`,
      kind: "group",
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
    })),
  )
  let id = 0
  for (const chat of chats)
    await store.messages.saveMessages(
      account,
      chat,
      (texts[chat] ?? []).map((text) => message(++id, chat, text)),
      { via: "history" },
    )
  return store
}
const run = (store: MessageStore, text: string, messenger = {}) =>
  searchStore(store, account, { text, limit: 100 }, messenger)
const ids = async (store: MessageStore, text: string) =>
  (await run(store, text)).items.map(({ id }) => Number(id)).sort((a, b) => a - b)
const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    return error as CliError
  }
  throw new Error("the search did not fail")
}

describe("strict search hints", () => {
  it("folds text: regex literals the way the word index folds words; body: stays case-sensitive", async () => {
    const store = await open({ "1": ["Квартира свободна", "Счёт оплачен", "квартал"] })
    expect(await ids(store, "text:/Квартир.*/")).toEqual([1])
    expect(await ids(store, "text:/счёт/")).toEqual([2])
    expect(await ids(store, "text:/[А-Я]вартал/")).toEqual([3])
    expect(await ids(store, "body:/квартира.*/")).toEqual([])
    expect(await ids(store, "body:/Квартира.*/")).toEqual([1])
    expect((await failure(run(store, "text:/[ﬁ]/"))).details).toMatchObject({ reason: "query.unsupported-regex" })
  })

  it("finds one exact word that the index merges with another, through a body: regex", async () => {
    const store = await open({ "1": ["это мой дом", "Мой кот", "мои книги", "моих"] })
    expect(await ids(store, "exact:мой")).toEqual([1, 2, 3])
    expect(await ids(store, "exact:мой AND body:/(.*[^а-яёА-ЯЁ])?[Мм]ой([^а-яёА-ЯЁ].*)?/")).toEqual([1, 2])
  })

  it("explains that ~ is not strict search and where fuzzy matching is", async () => {
    const store = await open({ "1": ["alpha beta"] })
    const fuzzy = await failure(run(store, "alpha~1"))
    expect(fuzzy.details).toMatchObject({ reason: "query.unsupported-operator" })
    expect(fuzzy.message).not.toContain("legacy")
    expect(fuzzy.message).toContain("word*")
    const proximity = await failure(run(store, '"alpha beta"~2'))
    expect(proximity.message).toContain("proximity")
    expect(proximity.message).not.toContain("legacy")
  })

  it("names the term and the budget when a short prefix expands to too many words, whatever the chat", async () => {
    const words = Array.from({ length: QUERY_LIMITS.expansions + 1 }, (_, n) => `к${n}`)
    const texts: string[] = []
    for (let at = 0; at < words.length; at += 500) texts.push(words.slice(at, at + 500).join(" "))
    const store = await open({ "1": texts, "2": ["кот"] })
    for (const query of ["к*", 'к* chat:"Chat 2"', "text:/к.*/ date>=2026-01-01"]) {
      const error = await failure(run(store, query))
      expect(error.details, query).toMatchObject({
        reason: "query.too-large",
        budget: "term expansions",
        limit: QUERY_LIMITS.expansions,
        complete: false,
      })
      expect(error.message).toContain(String(QUERY_LIMITS.expansions))
      expect(error.message).toContain("longer prefix")
    }
    expect((await failure(run(store, "к*"))).message).toContain("text:к* matches more than")
    expect(await ids(store, "к1000*")).toHaveLength(2)
  })

  it("says how far the word index is and which command finishes it", async () => {
    const store = await open({ "1": ["alpha"] })
    const app = { command: "tg" } as AppIdentity
    const stuck = (state: Awaited<ReturnType<MessageStore["searchIndex"]["searchIndexState"]>>): MessageStore => ({
      ...store,
      searchIndex: {
        ...store.searchIndex,
        fillSearchIndex: async () => ({ normalized: 0, indexed: 0, terms: 0 }),
        searchIndexState: async () => state,
      },
    })
    const partial = {
      watermark: 200,
      filledThrough: 50,
      pendingNormalization: 0,
      ready: false,
      termsThrough: 0,
      newest: 200,
      termsReady: false,
    }
    const filling = await failure(run(stuck({ ...partial, builtAt: null }), "alpha", { app }))
    expect(filling.details).toMatchObject({ reason: "index.not-ready" })
    expect(filling.message).toContain("index is not ready")
    expect(filling.message).toContain("25% built (message 50 of 200)")
    expect(filling.message).toContain("`tg store migrate` finishes it")
    const normalizing = await failure(run(stuck({ ...partial, pendingNormalization: 7, builtAt: null }), "alpha"))
    expect(normalizing.message).toContain("7 messages still wait")
    expect(normalizing.message).toContain("`store migrate`")
    expect((await failure(run(stuck(undefined), "alpha", { app }))).message).toContain("`tg store migrate` builds it")
  })
})
