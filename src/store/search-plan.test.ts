import { describe, expect, it } from "vitest"
import { createStemmer } from "../search/stem.js"
import { migrate } from "./migrations.js"
import { matchQuery } from "./sqlite/lucene.js"
import { openSqlite } from "./sqlite/open.js"
import { matching, newestHits } from "./sqlite/search.js"
import { readiness } from "./sqlite/vectors.js"

const opened = async () => {
  const sqlite = await openSqlite(":memory:")
  migrate(sqlite.database)
  return { ...sqlite, now: () => 0 }
}

const planOf = (context: Awaited<ReturnType<typeof opened>>, sql: string, params: unknown[]) =>
  context.database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as never[]))
    .map((row) => String(row.detail))

/** The shape the benchmark found slow: the index searched again for every message row, by its rowid. */
const perRow = (plan: string[]) => plan.some((line) => /VIRTUAL TABLE INDEX \d+:=/.test(line))

describe("the search query plan", () => {
  it("**reads the text index once**, not once per message, with text and chat filters", async () => {
    const context = await opened()
    const where = matching(context, {
      account: { provider: "telegram", account: "1" },
      chatId: "-100",
      text: "valencia",
    })
    const { sql, params } = newestHits(context, where, 21).toSQL()

    expect(perRow(planOf(context, sql, params))).toBe(false)
    context.database.close()
  })

  it("**reads the stems and words once** for a stemmed search, and never scans every message", async () => {
    const context = await opened()
    context.database.exec(
      `INSERT INTO accounts (id, provider, external_id, created_at,updated_at) VALUES (1, 'telegram', '1', 0,0)`,
    )
    context.database.exec(
      `INSERT INTO chats (id, account_id, external_id, kind, updated_at,created_at) VALUES (1, 1, '-100', 'group', 0,0)`,
    )
    const statements: { sql: string; params: unknown[] }[] = []
    const recording = {
      ...context,
      database: {
        ...context.database,
        prepare: (sql: string) => {
          const statement = context.database.prepare(sql)
          return {
            ...statement,
            all: (...params: never[]) => {
              statements.push({ sql, params })
              return statement.all(...params)
            },
          }
        },
      },
    }
    const account = { provider: "telegram", account: "1" }
    const span = { start: 0, end: 0 }
    const word = (value: string) => ({
      kind: "predicate" as const,
      field: "text",
      operator: "term" as const,
      value,
      span,
    })
    const root = {
      kind: "boolean" as const,
      clauses: [
        { occur: "must" as const, node: word("квартира") },
        { occur: "must" as const, node: word("сдали") },
      ],
      span,
    }
    const stemmer = createStemmer()
    await matchQuery(recording as never, { root, accounts: [account], limit: 20, stemmer })
    await matchQuery(recording as never, {
      root,
      accounts: [account],
      chat: { account, chatId: "-100" },
      limit: 20,
      stemmer,
    })

    // Per search: the exact page, then the rest from the stems.
    const searches = statements.filter(({ sql }) => /message_stems MATCH/.test(sql))
    expect(searches).toHaveLength(4)
    for (const { sql, params } of searches) {
      const plan = planOf(context, sql, params)
      expect(perRow(plan), plan.join("\n")).toBe(false)
      // The messages are read by key from the index sets, never walked by account or chat.
      expect(plan.filter((line) => / m\b/.test(line))).toEqual(["SEARCH m USING INTEGER PRIMARY KEY (rowid=?)"])
    }
    context.database.close()
  })

  it("would notice the slow shape", async () => {
    const context = await opened()
    const forced = `SELECT m.id FROM chats c CROSS JOIN messages m CROSS JOIN messages_fts f
                    WHERE m.chat_id = c.id AND f.rowid = m.id AND messages_fts MATCH ? AND c.external_id = ?`

    expect(perRow(planOf(context, forced, ['"valencia"', "-100"]))).toBe(true)
    context.database.close()
  })
})

describe("the readiness a conversation search reports", () => {
  it("**reads only the chat's chunks**, never every chunk of the store", async () => {
    const context = await opened()
    context.database.exec(`
      INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'telegram', '1', 0, 0);
      INSERT INTO chats (id, account_id, external_id, kind, updated_at, created_at) VALUES (1, 1, '-100', 'group', 0, 0);
      INSERT INTO conversation_state (chat_id, enabled_at, built_at, algorithm_version, current_build) VALUES (1, 0, 1, 1, 1);
    `)
    const statements: { sql: string; params: unknown[] }[] = []
    const { orm } = context
    const dialect = (orm as unknown as { dialect: { sqlToQuery: (query: unknown) => (typeof statements)[number] } })
      .dialect
    const recording = {
      ...context,
      orm: {
        get: (query: unknown) => {
          statements.push(dialect.sqlToQuery(query))
          return orm.get(query as never)
        },
      },
    }

    readiness(recording as never, 1, "e5-small")

    expect(statements).toHaveLength(3)
    for (const { sql, params } of statements) {
      const plan = planOf(context, sql, params)
      expect(plan, plan.join("\n")).not.toContain("SEARCH k USING INDEX sqlite_autoindex_chunks_1 (chunkable_type=?)")
    }
    context.database.close()
  })
})
