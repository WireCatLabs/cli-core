import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { expect, it } from "vitest"
import { meetingStoreOver } from "./sqlite/meetings.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

it("lists an account's meetings by title through meetings_by_time, newest first, without sorting them all", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-title-plan-")), "wirecat.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  const accountId = await store.accounts.saveAccount({ provider: "zoom", account: "zm-profile:alice" }, { name: null })
  await store.close()
  const sqlite = await openSqlite(path)
  const statements: string[] = []
  const recording = {
    ...sqlite,
    now: () => 0,
    database: {
      ...sqlite.database,
      prepare: (sql: string) => {
        statements.push(sql)
        return sqlite.database.prepare(sql)
      },
    },
  }
  try {
    await meetingStoreOver(recording as never).meetings({ accountId, query: parseLucene("title:plan*"), limit: 10 })
    const plan = statements.flatMap((sql) =>
      sqlite.database
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null))
        .map(({ detail }) => String(detail)),
    )
    expect(plan.some((line) => /meetings USING INDEX meetings_by_time/.test(line))).toBe(true)
    expect(plan.filter((line) => /USE TEMP B-TREE FOR ORDER BY/.test(line))).toEqual([])
  } finally {
    sqlite.database.close()
  }
})
