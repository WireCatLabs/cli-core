import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { parseLucene } from "../search/lucene/parser.js"
import { PRESETS } from "../search/lucene/presets.js"
import { type AccountKey, fetchedKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore, statsStore } from "./messages.js"

interface Fixture {
  query: string
  parsed: boolean
  ids?: number[]
}
const reference: Fixture[] = JSON.parse(
  readFileSync(new URL("../search/lucene/reference.json", import.meta.url), "utf8"),
)
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const chat = (id: string, kind: Chat["kind"] = "group", extra: Partial<Chat> = {}): Chat => ({
  id,
  title: `Chat ${id}`,
  kind,
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
  ...extra,
})
const message = (id: string, chatId: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId,
  senderId: Number(id) % 2 === 0 ? "200" : "201",
  senderName: Number(id) % 2 === 0 ? "alice" : "bob",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})
const open = async (now?: () => number) => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "lucene-")), "messages.db"),
    ...(now ? { now } : {}),
  })
  live.push(store)
  return store
}
const ids = (answer: { items: { id: string }[] }) => answer.items.map(({ id }) => Number(id)).sort((a, b) => a - b)
const seed = async (store: MessageStore, account: AccountKey) => {
  await store.saveChats(account, [chat("1", "dialog"), chat("2")])
  const tokens = ["alpha", "beta", "gamma", "delta"]
  for (const chatId of ["1", "2"])
    await store.saveMessages(
      account,
      chatId,
      Array.from({ length: 16 }, (_, mask) => mask)
        .filter((mask) => chatId === (mask % 2 === 0 ? "2" : "1"))
        .map((mask) => message(String(mask), chatId, tokens.filter((_, at) => (mask & (1 << at)) !== 0).join(" "))),
      { via: "history" },
    )
}
const run = (
  store: MessageStore,
  account: AccountKey,
  text: string,
  rest: Parameters<typeof searchStore>[2] = { limit: 100 },
) => searchStore(store, account, { ...rest, text, language: "lucene" })
const comparable = reference.filter(
  (row) =>
    row.parsed &&
    row.ids &&
    !/[~^@]/u.test(row.query) &&
    !row.query.startsWith("fn:") &&
    !/date|size|emoji|hello|foo|O'Brien|A B|a\\|a\\\/|\[TO TO TO\]/u.test(row.query),
)
describe.each(["max", "telegram"])("strict store profile (%s)", (provider) => {
  const account = { provider, account: "100" }
  it("matches reference Lucene ids through the real indexed store and resolved service", async () => {
    const store = await open()
    await seed(store, account)
    for (const row of comparable) expect(ids(await run(store, account, row.query)), row.query).toEqual(row.ids)
  })
  it("does not soften Boolean conditions, typos or incomplete indexes", async () => {
    const store = await open()
    await seed(store, account)
    expect(ids(await run(store, account, "alph gamma"))).toEqual([])
    expect(ids(await run(store, account, "alpha nonexisting"))).toEqual([])
    expect(ids(await run(store, account, "alpha OR beta gamma"))).toEqual([5, 6, 7, 13, 14, 15])
    const partial: MessageStore = Object.assign(Object.create(store) as MessageStore, {
      fillSearchIndex: async () => ({ normalized: 0, indexed: 0, terms: 0 }),
      searchIndexState: async () => undefined,
    })
    await expect(run(partial, account, "alpha")).rejects.toThrow("index is not ready")
    const metadataOnly = await run(partial, account, "kind:group")
    expect(ids(metadataOnly)).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
    expect(metadataOnly.wordsReady).toBe(false)
    expect((await run(store, account, "kind:group")).wordsReady).toBe(true)
  })
  it("finds media-only, unknown peers and same-thread ids without merging chats", async () => {
    const store = await open()
    await seed(store, account)
    await store.saveChats(account, [
      chat("3", "unknown"),
      chat("4", "saved"),
      chat("5", "dialog", { providerMetadata: { isBot: true } }),
      chat("6", "dialog", { providerMetadata: { peerKind: "service" } }),
    ])
    for (const id of ["3", "4", "5", "6"])
      await store.saveMessages(
        account,
        id,
        [message(`10${id}`, id, "", { attachments: [{ kind: "file", name: "invoice.pdf" }], threadId: "42" })],
        { via: "history" },
      )
    expect(ids(await run(store, account, "has:file"))).toEqual([103, 104, 105, 106])
    expect(ids(await run(store, account, 'body:""'))).toEqual([0, 103, 104, 105, 106])
    expect(ids(await run(store, account, "body://"))).toEqual([0, 103, 104, 105, 106])
    expect(ids(await run(store, account, "kind:unknown"))).toEqual([103])
    expect(ids(await run(store, account, "kind:bot"))).toEqual([105])
    expect(ids(await run(store, account, "kind:service"))).toEqual([106])
    expect(ids(await run(store, account, "has:file AND chat:4 AND topic:42"))).toEqual([104])
    await expect(run(store, account, "topic:42")).rejects.toThrow("topic_scope")
    await expect(run(store, account, "chat:3 OR topic:42")).rejects.toThrow("topic_scope")
    expect(ids(await run(store, account, "topic:42", { limit: 100, chat: "3" }))).toEqual([103])
    await expect(run(store, account, "from:NoSuchPerson")).rejects.toThrow()
    await expect(run(store, account, 'chat:"NoSuchChat"')).rejects.toThrow()
  })
  it("matches any attachment by file name, type and size without needing text", async () => {
    const store = await open()
    await store.saveChats(account, [chat("1")])
    await store.saveMessages(
      account,
      "1",
      [
        message("1", "1", "", {
          attachments: [
            { kind: "photo", url: "https://example.org/a.jpg", mime: "image/jpeg", size: 300 * 1024 },
            { kind: "file", name: "Budget 2026.XLSX", size: 3 * 1024 * 1024 },
          ],
        }),
        message("2", "1", "scan attached", {
          attachments: [{ kind: "file", name: "Скан договора.pdf", mime: "application/pdf", size: 1024 }],
        }),
        message("3", "1", "no files here"),
      ],
      { via: "history" },
    )
    expect(ids(await run(store, account, "filename:*.xlsx"))).toEqual([1])
    expect(ids(await run(store, account, 'filename:"скан договора.pdf"'))).toEqual([2])
    expect(ids(await run(store, account, "filename:/budget [0-9]+\\.xlsx/"))).toEqual([1])
    expect(ids(await run(store, account, "filename:budget"))).toEqual([])
    expect(ids(await run(store, account, "mime:image"))).toEqual([1])
    expect(ids(await run(store, account, 'mime:"application/pdf" AND scan'))).toEqual([2])
    expect(ids(await run(store, account, "size>=3MB"))).toEqual([1])
    expect(ids(await run(store, account, "size:[1KB TO 300KB]"))).toEqual([1, 2])
    expect(ids(await run(store, account, "size:{1KB TO 300KB}"))).toEqual([])
    expect(ids(await run(store, account, "size:1024"))).toEqual([2])
    expect(ids(await run(store, account, "has:file AND NOT filename:*.pdf"))).toEqual([1])
    await expect(run(store, account, "size:big")).rejects.toThrow("invalid_size")
  })
  it("folds a file-name regex like the names it is compared with", async () => {
    const store = await open()
    await store.saveChats(account, [chat("1")])
    await store.saveMessages(
      account,
      "1",
      [
        message("1", "1", "", { attachments: [{ kind: "file", name: "invoice.pdf" }] }),
        message("2", "1", "", { attachments: [{ kind: "file", name: "Счет.pdf" }] }),
      ],
      { via: "history" },
    )
    expect(ids(await run(store, account, "filename:/Invoice.*/"))).toEqual([1])
    expect(ids(await run(store, account, "filename:/счёт.*/"))).toEqual([2])
    expect(ids(await run(store, account, "filename:/[А-Я]+\\.PDF/"))).toEqual([2])
    expect(ids(await run(store, account, "filename:СЧЁТ.pdf"))).toEqual([2])
    expect(ids(await run(store, account, "filename:INVOICE*"))).toEqual([1])
    await expect(run(store, account, "filename:/[ﬁ]/")).rejects.toThrow("unsupported_regex")
  })
  it("counts a link preview without a typed URL as a link", async () => {
    const store = await open()
    await store.saveChats(account, [chat("1")])
    await store.saveMessages(
      account,
      "1",
      [
        message("1", "1", "look", { attachments: [{ kind: "share", url: "https://example.org", title: "A page" }] }),
        message("2", "1", "look", { attachments: [{ kind: "webpage" }] }),
        message("3", "1", "see https://example.org"),
        message("4", "1", "look", { attachments: [{ kind: "photo", url: "https://example.org/a.jpg" }] }),
      ],
      { via: "history" },
    )
    expect(ids(await run(store, account, "has:link"))).toEqual([1, 2, 3])
    expect(ids(await run(store, account, "look AND NOT has:link"))).toEqual([4])
  })
  it("reads relative dates against the current time", async () => {
    const store = await open()
    await store.saveChats(account, [chat("1")])
    const at = (ago: number) => new Date(Date.now() - ago).toISOString()
    await store.saveMessages(
      account,
      "1",
      [
        message("1", "1", "fresh", { timestamp: at(60_000) }),
        message("2", "1", "older", { timestamp: at(3 * 86_400_000) }),
        message("3", "1", "oldest", { timestamp: at(30 * 86_400_000) }),
      ],
      { via: "history" },
    )
    expect(ids(await run(store, account, "date:1h"))).toEqual([1])
    expect(ids(await run(store, account, "date>=7d"))).toEqual([1, 2])
    expect(ids(await run(store, account, "date:[60d TO 7d}"))).toEqual([3])
    expect(ids(await run(store, account, "date:today OR date:yesterday", { limit: 100, timezone: "UTC" }))).toContain(1)
  })
  it("counts distinct matches by chat, sender, day and hour", async () => {
    const store = await open()
    await store.saveChats(account, [chat("1"), chat("2")])
    const at = (iso: string) => ({ timestamp: iso })
    await store.saveMessages(
      account,
      "1",
      [
        message("1", "1", "invoice paid", at("2026-03-01T22:30:00.000Z")),
        message("2", "1", "invoice sent", at("2026-03-02T09:00:00.000Z")),
        message("3", "1", "invoice late", { ...at("2026-03-02T09:10:00.000Z"), outgoing: true }),
      ],
      { via: "history" },
    )
    await store.saveMessages(account, "2", [message("4", "2", "invoice", at("2026-03-02T10:00:00.000Z"))], {
      via: "history",
    })
    const stats = (text: string, by: "chat" | "sender" | "day" | "hour", extra = {}) =>
      statsStore(store, account, { text, language: "lucene", limit: 10, by, timezone: "UTC", ...extra })
    const byChat = await stats("invoice", "chat")
    expect(byChat.items.map(({ key, count }) => [key, count])).toEqual([
      ["1", 3],
      ["2", 1],
    ])
    expect(byChat).toMatchObject({ total: 4, hasMore: false, by: "chat", coverage: { state: "unknown" } })
    expect((await stats("invoice", "chat", { limit: 1 })).hasMore).toBe(true)
    expect((await stats("invoice", "sender")).items.map(({ key, count }) => [key, count])).toEqual([
      ["200", 2],
      ["201", 2],
    ])
    expect((await stats("invoice", "day")).items).toEqual([
      { key: "2026-03-01", name: null, count: 1 },
      { key: "2026-03-02", name: null, count: 3 },
    ])
    expect((await stats("invoice", "day", { timezone: "Asia/Kolkata" })).items.map(({ key }) => key)).toEqual([
      "2026-03-02",
    ])
    expect((await stats("invoice", "hour")).items.map(({ key, count }) => [key, count])).toEqual([
      ["2026-03-01T22", 1],
      ["2026-03-02T09", 2],
      ["2026-03-02T10", 1],
    ])
    expect((await stats("body:/invoice (paid|late)/", "chat")).total).toBe(2)
    expect((await stats("invoice AND NOT late", "chat")).total).toBe(3)
  })
  it("uses typed date ranges and body/term regex with stable pagination", async () => {
    const store = await open()
    await seed(store, account)
    expect(ids(await run(store, account, "text:/alpha/"))).toEqual([1, 3, 5, 7, 9, 11, 13, 15])
    expect(ids(await run(store, account, "body:/alpha/"))).toEqual([1])
    expect(ids(await run(store, account, "body:/.*alpha.*/"))).toEqual([1, 3, 5, 7, 9, 11, 13, 15])
    expect(ids(await run(store, account, "body:alph* AND kind:private"))).toEqual([1, 3, 5, 7, 9, 11, 13, 15])
    expect(ids(await run(store, account, 'body:"alpha beta"'))).toEqual([3])
    expect(
      ids(await run(store, account, "date:[2026-01-01 TO 2026-01-01]", { limit: 100, timezone: "UTC" })),
    ).toHaveLength(16)
    expect(
      ids(
        await run(store, account, 'date:["2026-01-01T10:04:00Z" TO "2026-01-01T10:06:00Z"}', {
          limit: 100,
          timezone: "UTC",
        }),
      ),
    ).toEqual([4, 5])
    const page = await run(store, account, "alpha OR beta", { limit: 1, newest: true })
    expect(page.items[0]?.id).toBe("15")
    expect(page.hasMore).toBe(true)
    expect((await run(store, account, "body:/alpha/", { limit: 1 })).hasMore).toBe(false)
    const ast = parseLucene("alpha AND kind:private")
    expect(ids(await searchStore(store, account, { ast, limit: 100 }))).toEqual(
      ids(await run(store, account, "alpha AND kind:private")),
    )
    await expect(run(store, account, "body:/a{4000}/ OR body:/b{4000}/ OR body:/c{4000}/")).rejects.toThrow("states")
    await expect(run(store, account, "body:/~alpha/")).rejects.toThrow("unsupported_regex")
    await expect(run(store, account, "text:/(/")).rejects.toThrow("invalid_regex")
    await expect(run(store, account, "alpha", { limit: 0 })).rejects.toThrow("invalid_limit")
    await expect(searchStore(store, account, { language: "lucene", text: "alpha", ast, limit: 1 })).rejects.toThrow(
      "query_conflict",
    )
  })
  it("orders equal timestamps by qualified message ids before applying the page limit", async () => {
    const store = await open()
    await store.saveChats(account, [chat("1")])
    await store.saveMessages(
      account,
      "1",
      ["71", "72", "73"].map((id) => message(id, "1", "alpha", { timestamp: "2026-01-01T10:00:00Z" })),
      { via: "history" },
    )
    const page = await run(store, account, "alpha", { limit: 2, newest: true })
    expect(page.items.map(({ id }) => id)).toEqual(["73", "72"])
    expect(page.hasMore).toBe(true)
  })
  it("reports when the store last fetched the chats in scope and whether it knows the whole chat list", async () => {
    let clock = Date.parse("2026-10-01T09:00:00Z")
    const store = await open(() => clock)
    await seed(store, account)
    await store.setSyncState(account, fetchedKey("1"), "1")
    expect((await run(store, account, "alpha")).coverage).toMatchObject({
      lastSyncedAt: null,
      inventoryComplete: false,
    })

    clock = Date.parse("2026-10-02T09:00:00Z")
    await store.setSyncState(account, fetchedKey("2"), "1")
    await store.markChatsLeft(account, ["1", "2"])
    const all = await run(store, account, "alpha")
    expect(all.coverage).toMatchObject({ lastSyncedAt: "2026-10-01T09:00:00.000Z", inventoryComplete: true })
    const counted = await statsStore(store, account, { text: "alpha", by: "chat", limit: 10 })
    expect(counted.coverage).toEqual(all.coverage)
    expect(all.completeness.map(({ fetchedAt }) => fetchedAt)).toEqual([
      "2026-10-01T09:00:00.000Z",
      "2026-10-02T09:00:00.000Z",
    ])
    expect((await run(store, account, "alpha", { limit: 100, chat: "Chat 2" })).coverage).toMatchObject({
      lastSyncedAt: "2026-10-02T09:00:00.000Z",
      inventoryComplete: true,
    })
    const other = { provider: account.provider, account: "other" }
    await store.saveChats(other, [chat("9")])
    expect(
      (await searchStore(store, account, { language: "lucene", text: "alpha", limit: 10, accounts: [account, other] }))
        .coverage,
    ).toMatchObject({ lastSyncedAt: null, inventoryComplete: false })
  })
  it("reports coverage even for empty hits and refuses invalid versions/modes", async () => {
    const store = await open()
    await seed(store, account)
    const none = await run(store, account, "nothing")
    expect(none.completeness).toHaveLength(2)
    expect(none.coverage).toMatchObject({
      state: "unknown",
      lastSyncedAt: null,
      inventoryComplete: false,
      coveredChats: 2,
    })
    expect(none.query).toMatchObject({ language: "lucene-v1", version: 1, fieldsVersion: 2, order: "relevance" })
    await expect(searchStore(store, account, { language: "lucene", pattern: /a/, limit: 1 })).rejects.toThrow(
      "--regex is legacy",
    )
    await expect(
      searchStore(store, account, { language: "legacy", timezone: "UTC", text: "a", limit: 1 }),
    ).rejects.toThrow("require the Lucene")
    expect(ids(await run(store, account, 'text:""'))).toEqual([])
    await expect(run(store, account, "alpha", { limit: 10, context: 21 })).rejects.toThrow("invalid_context")
    await expect(run(store, account, "body:/alpha/i")).rejects.toThrow("unsupported_regex_flags")
    await expect(run(store, account, "alpha~1")).rejects.toThrow("unsupported_operator")
    await expect(
      searchStore(Object.assign(Object.create(store) as MessageStore, { matchQuery: undefined }), account, {
        language: "lucene",
        text: "alpha",
        limit: 1,
      }),
    ).rejects.toThrow("upgrade cli-messaging")
    const controller = new AbortController()
    controller.abort()
    await expect(run(store, account, "body:/@/", { limit: 10, signal: controller.signal })).rejects.toThrow("aborted")
  })
  it("keeps account permissions outside Boolean AST and distinguishes bot peers from bot accounts", async () => {
    const store = await open()
    await seed(store, account)
    const other = { provider: `${provider}-bot`, account: "100" }
    await seed(store, other)
    expect(
      (await run(store, account, "alpha")).items.every(({ locator }) => locator.startsWith(`msg:${provider}/100/`)),
    ).toBe(true)
    expect(
      (await run(store, account, "alpha in:bots")).items.every(({ locator }) =>
        locator.startsWith(`msg:${provider}-bot/100/`),
      ),
    ).toBe(true)
    expect((await run(store, account, "alpha in:all")).items).toHaveLength(16)
    expect((await run(store, account, "alpha in:messages")).items).toHaveLength(16)
    expect((await run(store, account, "alpha NOT in:bots")).items).toHaveLength(8)
    if (provider === "telegram") {
      const viaAlias = (await run(store, account, "alpha in:tg")).items
      expect(viaAlias).toHaveLength(8)
      expect(viaAlias.every(({ locator }) => locator.startsWith("msg:telegram/100/"))).toBe(true)
      expect((await run(store, account, "alpha in:messages NOT in:tg")).items).toHaveLength(8)
    }
    expect((await run(store, account, "NOT in:all")).items).toEqual([])
    await expect(run(store, account, "in:all", { limit: 10, accounts: [account] })).rejects.toThrow(
      "accounts it was given",
    )
    expect((await run(store, account, "alpha", { limit: 10, accounts: [account] })).items).toHaveLength(8)
    expect((await run(store, account, "alpha", { limit: 10, source: "all" })).items).toHaveLength(10)
  })
})
describe("preset predicates are candidates, not verified credentials", () => {
  const bodies: Record<string, string> = {
    password: "password: EXAMPLE_ONLY",
    code: "code: 0000",
    "api-key": "api_key: EXAMPLE_ONLY",
    secret: "secret: EXAMPLE_ONLY",
    card: "0000 0000 0000 0000",
    bank: "ZZ00EXAMPLEONLY00000",
    passport: "passport: EXAMPLE_ONLY",
    phone: "+00000000000",
    email: "example@example.invalid",
    "telegram-link": "https://t.me/example",
    url: "https://example.invalid",
    contact: "example@example.invalid",
    location: "geo:0,0",
  }
  it.each(Object.entries(bodies))("detects %s locally with a negative counterexample", (name, body) => {
    expect(PRESETS[name]?.candidate(body, [])).toBe(true)
    expect(PRESETS[name]?.candidate("ordinary synthetic prose", [])).toBe(false)
  })
  it("runs presets through Boolean search without persisting bodies separately", async () => {
    const store = await open()
    const account = { provider: "max", account: "100" }
    await store.saveChats(account, [chat("1", "saved")])
    await store.saveMessages(
      account,
      "1",
      [
        message("1", "1", "secret: EXAMPLE_ONLY"),
        message("2", "1", "ordinary prose"),
        message("3", "1", "", { attachments: [{ kind: "contact" }] }),
      ],
      { via: "history" },
    )
    expect(ids(await run(store, account, "preset:secret kind:saved"))).toEqual([1])
    expect(ids(await run(store, account, "preset:contact"))).toEqual([3])
    expect(ids(await run(store, account, "kind:saved NOT preset:secret"))).toEqual([2, 3])
    expect(PRESETS.location?.candidate("", ["location"])).toBe(true)
  })
})
