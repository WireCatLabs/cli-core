import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { openCache } from "../store/open.js"
import { HISTORY_KEPT } from "../store/sqlite/searches.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { messagesService } from "./messages.js"
import { searchRecordOf } from "./search-record.js"
import { searchesService } from "./searches.js"

const OWNER: AccountKey = { provider: "tg", account: "1" }
const live: MessageStore[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const store of live.splice(0)) await store.close()
})

const chat: Chat = {
  id: "1",
  title: "Chat 1",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}
const message = (id: string, text: string, timestamp: string): Message => ({
  id,
  chatId: "1",
  senderId: "7",
  senderName: "Ana",
  timestamp,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const setup = async (history?: boolean) => {
  const path = join(mkdtempSync(join(tmpdir(), "searches-")), "messages.db")
  const store = await openStore({ path })
  live.push(store)
  await store.saveChats(OWNER, [chat])
  await store.saveMessages(
    OWNER,
    "1",
    [
      message("1", "invoice early", "2026-01-01T10:00:00.000Z"),
      message("2", "invoice late", "2026-01-20T10:00:00.000Z"),
    ],
    { via: "history" },
  )
  const deps = {
    messenger: { provider: "tg" },
    offline: true,
    account: async () => OWNER,
    store: async () => store,
    ...(history === undefined ? {} : { history }),
  } as unknown as ServiceDeps
  return { store, path, messages: messagesService(deps), searches: searchesService(deps) }
}

const rows = async (path: string) => {
  const database = await openCache(path)
  try {
    return database.prepare("SELECT name, command, params, runs FROM searches ORDER BY id").all()
  } finally {
    database.close()
  }
}

describe("search history", () => {
  it("**records each run once, with its options as given**; the same run again counts on its row", async () => {
    const { messages, path } = await setup()
    await messages.search({ text: "invoice", limit: 5, context: 0 })
    await messages.search({ context: 0, limit: 5, text: "invoice" })
    await messages.stats({ text: "invoice", limit: 5, by: "day" })
    expect(await rows(path)).toEqual([
      {
        name: null,
        command: "search",
        params: '{"context":0,"limit":5,"text":"invoice"}',
        runs: 2,
      },
      { name: null, command: "stats", params: '{"by":"day","limit":5,"text":"invoice"}', runs: 1 },
    ])
  })

  it("keeps a refused query and a run with recording off out of it", async () => {
    const { messages, path } = await setup()
    await expect(messages.search({ text: "foo:bar", limit: 5 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(await rows(path)).toEqual([])

    const off = await setup(false)
    await off.messages.search({ text: "invoice", limit: 5 })
    expect(await rows(off.path)).toEqual([])
  })

  it("answers the search even when the history cannot be written", async () => {
    const { store, messages } = await setup()
    store.recordSearch = async () => {
      throw new Error("database is locked")
    }
    expect((await messages.search({ text: "invoice", limit: 5 })).items).toHaveLength(2)
  })

  it(`keeps the newest ${HISTORY_KEPT} unnamed runs, and never prunes a saved search`, async () => {
    const { store, searches } = await setup()
    await searches.create("kept", { text: "invoice" })
    for (let n = 0; n <= HISTORY_KEPT; n++)
      await store.recordSearch(searchRecordOf("search", { text: `word${n}`, limit: 1 }))
    const history = await searches.history(HISTORY_KEPT + 10)
    expect(history.items).toHaveLength(HISTORY_KEPT)
    expect(history.items[0]?.params.text).toBe(`word${HISTORY_KEPT}`)
    expect(history.items.some(({ params }) => params.text === "word0")).toBe(false)
    expect((await searches.list()).map(({ name }) => name)).toEqual(["kept"])
    expect((await searches.clear()).cleared).toBe(HISTORY_KEPT)
    expect((await searches.history(10)).items).toEqual([])
    expect((await searches.list()).map(({ name }) => name)).toEqual(["kept"])
  })
})

describe("saved searches", () => {
  it("**saves without running**, refuses a taken name unless --replace, and finds it by name or id", async () => {
    const { searches } = await setup()
    const saved = await searches.create("Invoices", { text: "invoice", limit: 3 })
    expect(saved).toMatchObject({
      name: "invoices",
      command: "search",
      params: { limit: 3, text: "invoice" },
      language: "lucene-v1",
      version: 1,
      fieldsVersion: 2,
      runs: 0,
      lastRunAt: null,
    })
    await expect(searches.create("invoices", { text: "paid" })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "name.taken" },
    })
    const replaced = await searches.create("invoices", { text: "paid", by: "day" }, { replace: true })
    expect([replaced.id, replaced.command, replaced.params.text]).toEqual([saved.id, "stats", "paid"])
    expect((await searches.show(saved.id)).name).toBe("invoices")
    expect((await searches.history(10)).items).toEqual([])
    expect((await searches.delete("invoices")).id).toBe(saved.id)
    await expect(searches.show("invoices")).rejects.toMatchObject({ code: "not_found" })
  })

  it.each([
    ["42", { text: "invoice" }, "name.invalid"],
    ["bad name", { text: "invoice" }, "name.invalid"],
    ["typo", { text: "foo:bar" }, "query.unknown-field"],
  ])("refuses %s before saving it", async (name, params, reason) => {
    const { searches } = await setup()
    await expect(searches.create(name, params)).rejects.toMatchObject({
      code: "validation_error",
      ...(reason ? { details: { reason } } : {}),
    })
    expect(await searches.list()).toEqual([])
  })

  it("**--saved ANDs more words and lets typed options win**; the run counts on the saved row too", async () => {
    const { messages, searches } = await setup()
    await searches.create("invoices", { text: "invoice", newest: true, limit: 1, timezone: "UTC" })
    const resolved = await searches.resolve("invoices", { text: "late", limit: 9 })
    expect(resolved.params).toEqual({
      text: "(invoice) AND (late)",
      newest: true,
      limit: 9,
      timezone: "UTC",
    })
    const found = await messages.search({
      ...resolved.params,
      limit: 9,
      saved: resolved.id,
    } as Parameters<typeof messages.search>[0])
    expect(found.items.map(({ id }) => id)).toEqual(["2"])
    expect(await searches.show("invoices")).toMatchObject({ runs: 1 })
    expect((await searches.history(10)).items.map(({ name, params }) => name ?? params.text)).toHaveLength(2)
  })

  it("**re-checks the stored query against today's fields**, naming the saved search when it fails", async () => {
    const { store, searches } = await setup()
    await store.saveSearch("old", searchRecordOf("search", { text: "renamed:field" }))
    await expect(searches.resolve("old", {})).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining('saved search "old": search: query.unknown-field'),
    })
  })

  it("adds words to a stored AST", async () => {
    const { searches } = await setup()
    await searches.create("tree", {
      ast: {
        version: 1,
        language: "lucene-v1",
        root: { kind: "predicate", field: "text", operator: "term", value: "invoice", span: { start: 0, end: 7 } },
      },
    })
    const resolved = await searches.resolve("tree", { text: "late" })
    expect(resolved.params.ast).toMatchObject({
      root: { kind: "boolean", clauses: [{ occur: "must" }, { occur: "must" }] },
    })
  })

  it("refuses a search saved in the removed legacy language instead of reading it as Lucene", async () => {
    const { searches, path } = await setup()
    await searches.create("old", { text: "inv.ice" })
    const database = await openCache(path)
    database.prepare("UPDATE searches SET language = 'legacy' WHERE name = 'old'").run()
    database.close()
    await expect(searches.resolve("old", {})).rejects.toThrow(
      'saved search "old": the legacy search and --regex are gone',
    )
  })

  it("**a saved relative date means the day it runs**: date>=7d finds different messages on different days", async () => {
    const { messages, searches } = await setup()
    await searches.create("recent", { text: "invoice date>=7d" })
    const run = async (day: string) => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(day))
      const { params } = await searches.resolve("recent", {})
      const found = await messages.search({ text: params.text as string, limit: 10 })
      vi.useRealTimers()
      return found.items.map(({ id }) => id).sort()
    }
    expect(await run("2026-01-05T00:00:00.000Z")).toEqual(["1", "2"])
    expect(await run("2026-01-25T00:00:00.000Z")).toEqual(["2"])
  })
})
