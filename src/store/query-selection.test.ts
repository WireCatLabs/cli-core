import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { QueryExecution, ResolvedPredicate } from "../search/lucene/resolved.js"
import { createStemmer } from "../search/stem.js"
import { migrate } from "./migrations.js"
import { countQuery, withQuerySelection } from "./sqlite/lucene.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"

vi.mock("../search/lucene/types.js", async (original) => {
  const actual = await original<typeof import("../search/lucene/types.js")>()
  return { ...actual, QUERY_LIMITS: { ...actual.QUERY_LIMITS, candidates: 4, bodyBytes: 128 } }
})

const live: StoreContext[] = []
afterEach(() => {
  for (const context of live.splice(0)) context.database.close()
})
const account = { provider: "fixture", account: "owner" }
const leaf = (field: string, value: string, operator: ResolvedPredicate["operator"] = "term"): ResolvedPredicate => ({
  kind: "predicate",
  field,
  value,
  operator,
  span: { start: 0, end: 0 },
})
const query = (root: QueryExecution["root"]): QueryExecution => ({ root, accounts: [account], limit: 1 })
const all = (): ResolvedPredicate => ({
  ...leaf("date", "*", "range"),
  resolution: { date: { lower_inclusive: true, upper_inclusive: true } },
})
const opened = async (path = ":memory:") => {
  const context = { ...(await openSqlite(path)), now: () => 0 }
  live.push(context)
  migrate(context.database)
  context.database.exec(`
    INSERT INTO accounts (id,provider,external_id,created_at,updated_at) VALUES (1,'fixture','owner',0,0),(2,'fixture','other',0,0);
    INSERT INTO chats (id,account_id,external_id,kind,updated_at,searchable,created_at)
      VALUES (1,1,'room','group',0,1,0),(2,1,'hidden','group',0,0,0),(3,2,'room','group',0,1,0);
    INSERT INTO messages (id,account_id,chat_id,external_id,sent_at,text,created_at,source,updated_at)
      VALUES (1,1,1,'same',1,'alpha',0,'history',0),(2,1,1,'second',2,'beta',0,'history',0),
        (3,1,2,'same',1,'alpha',0,'history',0),(4,2,3,'same',1,'alpha',0,'history',0);
  `)
  return context
}
const keys = (context: StoreContext, execution: QueryExecution) =>
  withQuerySelection(context, execution, (selection) =>
    context.database
      .prepare(`SELECT id AS pk FROM (${selection.sql}) ORDER BY id`)
      .all(...selection.params)
      .map(({ pk }) => Number(pk)),
  )

describe("a compiled ranking selection", () => {
  it("aggregates an exact population larger than the candidate budget without a hit-page limit", async () => {
    const context = await opened()
    context.database.exec(`
      WITH RECURSIVE seq(n) AS (SELECT 5 UNION ALL SELECT n+1 FROM seq WHERE n<10004)
      INSERT INTO messages (id,account_id,chat_id,external_id,sent_at,text,created_at,source,updated_at)
      SELECT n,1,1,CAST(n AS TEXT),n,'synthetic',0,'history' ,0 FROM seq;
    `)
    let materializedRows = 0
    const recording = {
      ...context,
      database: {
        ...context.database,
        prepare: (sql: string) => {
          const statement = context.database.prepare(sql)
          return {
            ...statement,
            all: (...params: Parameters<typeof statement.all>) => {
              const rows = statement.all(...params)
              materializedRows += rows.length
              return rows
            },
          }
        },
      },
    }
    const total = withQuerySelection(
      recording,
      query(all()),
      (selection) =>
        context.database.prepare(`SELECT count(*) AS total FROM (${selection.sql})`).get(...selection.params)?.total,
    )
    expect(total).toBe(10002)
    expect(materializedRows).toBe(0)
  })

  it("keeps account, hidden-chat and deletion scope, while allowing an explicitly selected hidden chat", async () => {
    const context = await opened()
    context.database.exec("UPDATE messages SET deleted_at=10 WHERE id=2")
    expect(keys(context, query(all()))).toEqual([1])
    expect(keys(context, { ...query(all()), chat: { account, chatId: "hidden" } })).toEqual([3])
    expect(() => keys(context, { ...query(all()), accounts: [] })).toThrow("query.invalid-scope")
  })

  it("evaluates the whole bounded Boolean detector set before aggregation", async () => {
    const context = await opened()
    const root: QueryExecution["root"] = {
      kind: "boolean",
      span: { start: 0, end: 0 },
      clauses: [
        { occur: "should", node: leaf("body", "alpha", "regex") },
        { occur: "should", node: leaf("body", "beta") },
        { occur: "must_not", node: leaf("body", "beta", "regex") },
      ],
    }
    expect(keys(context, query(root))).toEqual([1])
  })

  it("fails closed on detector candidates and body bytes, without calling the aggregator", async () => {
    const context = await opened()
    context.database.exec("UPDATE messages SET text=printf('%200s','x') WHERE id=1")
    const consume = vi.fn()
    expect(() => withQuerySelection(context, query(leaf("body", ".*", "regex")), consume)).toThrow("body bytes")
    context.database.exec(`
      UPDATE messages SET text='alpha' WHERE id=1;
      INSERT INTO messages (id,account_id,chat_id,external_id,sent_at,text,created_at,source,updated_at)
      VALUES (5,1,1,'5',5,'x',0,'history',0),(6,1,1,'6',6,'x',0,'history',0),(7,1,1,'7',7,'x',0,'history',0);
    `)
    expect(() => withQuerySelection(context, query(leaf("body", ".*", "regex")), consume)).toThrow("candidate rows")
    expect(consume).not.toHaveBeenCalled()
  })

  it("bounds filename intermediates for ranking while preserving ordinary statistics behavior", async () => {
    const context = await opened()
    context.database.exec(`
      INSERT INTO messages (id,account_id,chat_id,external_id,sent_at,text,created_at,source,updated_at)
      VALUES (5,1,1,'5',5,'x',0,'history',0),(6,1,1,'6',6,'x',0,'history',0),(7,1,1,'7',7,'x',0,'history',0);
      INSERT INTO attachments (attachable_type,attachable_id,position,kind,name,created_at,updated_at) SELECT 'message',id,0,'file','sample.pdf',0,0 FROM messages WHERE chat_id=1;
      INSERT INTO attachments (attachable_type,attachable_id,position,kind,name,created_at,updated_at) VALUES ('message',1,1,'file','sample.pdf',0,0);
    `)
    const execution = query(leaf("filename", "*.pdf", "wildcard"))
    expect(() => keys(context, execution)).toThrow("attachment message keys")
    const groups = await countQuery(context, execution, "chat")
    expect(groups).toMatchObject([{ id: "room", count: 5 }])
  })

  it("uses the word/stem index as a key driver instead of scanning the account", async () => {
    const context = await opened()
    withQuerySelection(context, { ...query(leaf("text", "running")), stemmer: createStemmer() }, (selection) => {
      const plan = context.database
        .prepare(`EXPLAIN QUERY PLAN ${selection.sql}`)
        .all(...selection.params)
        .map(({ detail }) => String(detail))
      expect(plan.some((line) => /message_words|message_stems/.test(line))).toBe(true)
      expect(plan.filter((line) => / m\b/.test(line))).toEqual(["SEARCH m USING INTEGER PRIMARY KEY (rowid=?)"])
    })
  })

  it("applies an explicit chat before collecting filename keys", async () => {
    const context = await opened()
    context.database.exec(`
      INSERT INTO messages (id,account_id,chat_id,external_id,sent_at,text,created_at,source,updated_at)
      VALUES (5,1,1,'5',5,'x',0,'history',0),(6,1,1,'6',6,'x',0,'history',0),(7,1,1,'7',7,'x',0,'history',0);
      INSERT INTO attachments (attachable_type,attachable_id,position,kind,name,created_at,updated_at) SELECT 'message',id,0,'file','sample.pdf',0,0 FROM messages;
    `)
    expect(
      keys(context, { ...query(leaf("filename", "*.pdf", "wildcard")), chat: { account, chatId: "hidden" } }),
    ).toEqual([3])
  })

  it("holds one read snapshot while a second connection commits a new matching message", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ranking-snapshot-")), "fixture.db")
    const context = await opened(path)
    const writer = { ...(await openSqlite(path)), now: () => 0 }
    live.push(writer)
    withQuerySelection(context, query(all()), (selection) => {
      const count = () =>
        context.database.prepare(`SELECT count(*) AS total FROM (${selection.sql})`).get(...selection.params)?.total
      expect(count()).toBe(2)
      writer.database.exec(
        "INSERT INTO messages (id,account_id,chat_id,external_id,sent_at,text,created_at,source,updated_at) VALUES (5,1,1,'5',5,'synthetic',0,'history',0)",
      )
      expect(count()).toBe(2)
    })
    expect(keys(context, query(all()))).toEqual([1, 2, 5])
  })

  it("rolls back a failed consumer and checks abort/time before committing the read", async () => {
    const context = await opened()
    expect(() =>
      withQuerySelection(context, query(all()), () => {
        throw new Error("fixture failure")
      }),
    ).toThrow("fixture failure")
    expect(keys(context, query(all()))).toEqual([1, 2])
    expect(() => withQuerySelection(context, query(all()), () => Promise.resolve(1))).toThrow("synchronously")
    expect(() => withQuerySelection(context, { ...query(all()), signal: AbortSignal.abort() }, vi.fn())).toThrow(
      "aborted",
    )
    let now = 0
    expect(() =>
      withQuerySelection({ ...context, now: () => now }, query(all()), (_selection, check) => {
        now = 2001
        check()
      }),
    ).toThrow("time")
    expect(keys(context, query(all()))).toEqual([1, 2])
  })
})
