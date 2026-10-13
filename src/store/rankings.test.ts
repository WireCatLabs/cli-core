import { afterEach, describe, expect, it } from "vitest"
import { type RankingInput, type RankingTarget, rankingOptions } from "../domain/rankings-options.js"
import type { QueryExecution, ResolvedPredicate } from "../search/lucene/resolved.js"
import { migrate } from "./migrations.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"
import { rankQuery } from "./sqlite/rankings.js"

const live: StoreContext[] = []
afterEach(() => {
  for (const context of live.splice(0)) context.database.close()
})
const account = { provider: "fixture", account: "owner" }
const root: ResolvedPredicate = {
  kind: "predicate",
  field: "date",
  operator: "range",
  value: "*",
  span: { start: 0, end: 0 },
  resolution: { date: { lower_inclusive: true, upper_inclusive: true } },
}
const open = async () => {
  const context = { ...(await openSqlite(":memory:")), now: () => 0 }
  live.push(context)
  migrate(context.database)
  context.database.exec(`
    INSERT INTO accounts(id,provider,external_id,created_at,updated_at) VALUES (1,'fixture','owner',0,0),(2,'fixture','other',0,0);
    INSERT INTO chats(id,account_id,external_id,kind,updated_at,created_at) VALUES (1,1,'room','group',0,0),(2,2,'room','group',0,0);
    INSERT INTO identities(id,provider,external_id,name,created_at,updated_at) VALUES (1,'fixture','alice','Alice',0,0),(2,'fixture','bob','Bob',0,0);
  `)
  return context
}
const put = (
  context: StoreContext,
  pk: number,
  sender: number | null,
  extra: {
    account?: number
    chat?: number
    text?: string
    at?: number
    reactions?: unknown
    views?: unknown
    reply?: string
    graph?: boolean
    deleted?: boolean
  } = {},
) => {
  const graph =
    extra.graph === false
      ? undefined
      : { version: 1, reply: extra.reply ? { chatId: "room", messageId: extra.reply } : null }
  context.database
    .prepare(
      "INSERT INTO messages(id,account_id,chat_id,external_id,sender_identity_id,sent_at,text,reactions,metadata,deleted_at,created_at,source,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,'history',0)",
    )
    .run(
      pk,
      extra.account ?? 1,
      extra.chat ?? 1,
      String(pk),
      sender,
      extra.at ?? pk * 1000,
      extra.text ?? "Synthetic fixture",
      extra.reactions === undefined ? null : JSON.stringify({ total: extra.reactions }),
      JSON.stringify({ views: extra.views, graph }),
      extra.deleted ? 1 : null,
    )
}
const run = (
  context: StoreContext,
  target: RankingTarget,
  input: RankingInput = {},
  limit = 10,
  extra: Partial<QueryExecution> = {},
) =>
  rankQuery(
    context,
    { root, accounts: [account], limit, ...extra },
    { options: rankingOptions(target, input), timezone: "UTC" },
  )

describe("stored rankings", () => {
  it("ranks known snapshot counters without replacing unknown with zero", async () => {
    const context = await open()
    put(context, 1, 1, { views: 0 })
    put(context, 2, 2, { views: 10 })
    put(context, 3, 2)
    put(context, 4, 2, { views: "20" })
    put(context, 5, 1, { views: -1 })
    put(context, 6, 1, { views: 100, deleted: true })
    put(context, 7, 1, { views: 500, account: 2, chat: 2 })
    const found = run(context, "messages", { measure: "views" }, 1)
    expect(found).toMatchObject({ total: 5, population: 5, eligible: 2, excludedMissing: 3, hasMore: true })
    expect(found.items[0]).toMatchObject({ id: "2", value: 10, components: { views: 10 } })
    expect(run(context, "messages", { measure: "views" }).items.map(({ value }) => value)).toEqual([10, 0])
  })
  it("aggregates people by account and keeps unknown senders out of people rows", async () => {
    const context = await open()
    put(context, 1, 1)
    put(context, 2, 1)
    put(context, 3, 2)
    put(context, 4, null)
    put(context, 5, 1, { account: 2, chat: 2 })
    const found = run(context, "contacts", {}, 10, { accounts: [account, { ...account, account: "other" }] })
    expect(found).toMatchObject({ total: 5, population: 3, excludedUnknownSender: 1 })
    expect(found.items.map(({ account, id, value }) => [account, id, value])).toEqual([
      ["owner", "alice", 2],
      ["other", "alice", 1],
      ["owner", "bob", 1],
    ])
    expect(run(context, "contacts", { minMessages: 2 })).toMatchObject({
      population: 2,
      eligible: 1,
      excludedMinimum: 1,
    })
  })
  it("labels partial reaction sums and excludes them from scores", async () => {
    const context = await open()
    put(context, 1, 1, { reactions: 5 })
    put(context, 2, 1)
    put(context, 3, 2, { reactions: 0 })
    expect(run(context, "contacts", { measure: "reactions" }).items[0]).toMatchObject({
      id: "alice",
      value: 5,
      knownReactions: 1,
      unknownReactions: 1,
    })
    const found = run(context, "contacts", { weights: { reactions: 1, messages: 1 } })
    expect(found).toMatchObject({ population: 2, eligible: 1, excludedMissing: 1 })
    expect(found.items[0]?.id).toBe("bob")
  })
  it("normalizes before limit and sorts fractional scores with stable ids", async () => {
    const context = await open()
    put(context, 1, 1, { text: "one two three four" })
    put(context, 2, 1, { text: "five six seven eight" })
    put(context, 3, 2, { text: "one two three four" })
    const first = run(context, "contacts", { weights: { words: 1 } }, 1)
    const all = run(context, "contacts", { weights: { words: 1 } }, 10)
    expect(first.maxima).toEqual({ words: 8 })
    expect(first.items[0]?.score?.score).toBe(100)
    expect(all.items.map(({ score }) => score?.score)).toEqual([100, 50])
    expect(first.items[0]).toEqual(all.items[0])
  })
  it("keeps author filters out of reply context, and calculates median credited answer delay", async () => {
    const context = await open()
    put(context, 1, 1, { text: "Synthetic question?", at: 1000 })
    put(context, 2, 2, { reply: "1", at: 3000 })
    put(context, 3, 2, { reply: "1", at: 4000 })
    put(context, 4, 1, { text: "Another question?", at: 5000 })
    put(context, 5, 2, { reply: "4", at: 11000 })
    const sender: ResolvedPredicate = {
      kind: "predicate",
      field: "from",
      operator: "term",
      value: "bob",
      span: { start: 0, end: 0 },
      resolution: { sender: { provider: "fixture", id: "bob" } },
    }
    const found = run(context, "contacts", { measure: "answers" }, 10, { root: sender })
    expect(found.items[0]).toMatchObject({ id: "bob", value: 2 })
    expect(run(context, "contacts", { measure: "answer-time" }, 10, { root: sender }).items[0]).toMatchObject({
      value: 4000,
    })
    expect(run(context, "messages", { measure: "replies" }).items.find(({ id }) => id === "1")?.value).toBe(2)
    expect(run(context, "messages", { measure: "thread-size" }).items.find(({ id }) => id === "1")?.value).toBe(2)
    expect(run(context, "contacts", { measure: "threads" }).items[0]).toMatchObject({ id: "alice", value: 2 })
  })
  it("counts active days in the supplied timezone and Unicode words without URL tokens", async () => {
    const context = await open()
    put(context, 1, 1, { at: Date.parse("2026-10-07T23:30:00Z"), text: "Synthetic пример café https://example.test" })
    put(context, 2, 1, { at: Date.parse("2026-10-08T00:30:00Z"), text: "four" })
    expect(run(context, "contacts", { measure: "words" }).items[0]?.value).toBe(4)
    const found = rankQuery(
      context,
      { root, accounts: [account], limit: 10 },
      { options: rankingOptions("contacts", { measure: "active-days" }), timezone: "Asia/Kathmandu" },
    )
    expect(found.items[0]?.value).toBe(1)
    expect(run(context, "contacts", { measure: "active-days" }).items[0]?.value).toBe(2)
  })
  it("filters proven kinds and keeps unknown old graph rows visible as exclusions", async () => {
    const context = await open()
    put(context, 1, 1, { reactions: 1 })
    put(context, 2, 2, { reply: "1", reactions: 2 })
    put(context, 3, 1, { graph: false, reactions: 3 })
    expect(run(context, "messages", { messageKind: "posts" }).items.map(({ id }) => id)).toEqual(["1"])
    const comments = run(context, "messages", { messageKind: "comments" })
    expect(comments.items.map(({ id }) => id)).toEqual(["2"])
    expect(comments.excludedUnknownKind).toBe(1)
  })
  it("does not let incomplete linkage in one account exclude another account's scores", async () => {
    const context = await open()
    put(context, 1, 1, { reactions: 1 })
    put(context, 2, 2, { reply: "1", reactions: 1 })
    put(context, 3, 1, { account: 2, chat: 2, graph: false, reactions: 1 })
    const found = run(context, "messages", { score: "engaging" }, 10, {
      accounts: [account, { ...account, account: "other" }],
    })
    expect(found.items.map(({ account }) => account)).toEqual(["owner", "owner"])
    expect(found.excludedMissing).toBe(1)
  })
  it("uses only period events but can read older structural ancestors", async () => {
    const context = await open()
    put(context, 1, 1, { text: "Question?", at: 1000 })
    put(context, 2, 2, { reply: "1", at: 3000 })
    put(context, 3, 1, { reply: "2", at: 5000 })
    const period: ResolvedPredicate = {
      ...root,
      resolution: { date: { lower: 2000, upper: 4000, lower_inclusive: true, upper_inclusive: false } },
    }
    expect(run(context, "contacts", { measure: "answers" }, 10, { root: period }).items[0]?.value).toBe(0)
    expect(
      run(context, "messages", { messageKind: "comments", measure: "replies" }, 10, { root: period }).items[0],
    ).toMatchObject({ id: "2", value: 0 })
    const alternatives: QueryExecution["root"] = {
      kind: "boolean",
      span: { start: 0, end: 0 },
      clauses: [
        { occur: "should", node: period },
        { occur: "should", node: root },
      ],
    }
    expect(() => run(context, "messages", { measure: "replies" }, 10, { root: alternatives })).toThrow(
      "common positive date",
    )
  })
  it("uses proven channel discussion scope and collapses its automatic copy", async () => {
    const context = await open()
    context.database.exec(
      "UPDATE chats SET kind='channel' WHERE id=1; INSERT INTO chats(id,account_id,external_id,kind,updated_at,created_at) VALUES (3,1,'discussion','group',0,0)",
    )
    put(context, 1, null, { reactions: 2 })
    put(context, 2, null, { chat: 3 })
    put(context, 3, 2, { chat: 3, reactions: 1 })
    context.database
      .prepare("UPDATE messages SET sender_chat_external_id='room',metadata=? WHERE id=1")
      .run(JSON.stringify({ graph: { version: 1, reply: null, discussionChatId: "discussion" } }))
    context.database
      .prepare("UPDATE messages SET sender_chat_external_id='room',metadata=? WHERE id=2")
      .run(JSON.stringify({ graph: { version: 1, reply: null, discussionSource: { chatId: "room", messageId: "1" } } }))
    context.database
      .prepare("UPDATE messages SET metadata=? WHERE id=3")
      .run(JSON.stringify({ graph: { version: 1, reply: { chatId: "discussion", messageId: "2" } } }))
    const found = run(context, "messages", { measure: "replies" }, 10, { chat: { account, chatId: "room" } })
    expect(found.items[0]).toMatchObject({ id: "1", value: 1 })
    expect(found.graphQuality?.complete).toBe(true)
  })
  it("returns an empty exact selection without reading an unrelated large graph", async () => {
    const context = await open()
    put(context, 1, 1)
    const missing: ResolvedPredicate = {
      kind: "predicate",
      field: "body",
      operator: "term",
      value: "absent",
      span: { start: 0, end: 0 },
    }
    expect(run(context, "messages", { measure: "replies" }, 10, { root: missing })).toMatchObject({
      total: 0,
      population: 0,
      items: [],
    })
    expect(() => run(context, "messages", {}, 101)).toThrow("1–100")
  })
})
