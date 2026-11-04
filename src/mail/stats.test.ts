import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { prepareLucene } from "../services/messages-search.js"
import type { EmailInput } from "../store/index.js"
import { countQuery } from "../store/sqlite/lucene.js"
import { openSqlite } from "../store/sqlite/open.js"
import { type AccountKey, openStore } from "../store/store.js"
import { mailStats, mailStatsItem } from "./stats.js"

const MINE: AccountKey = { provider: "email", account: "me@example.com" }
const OTHER: AccountKey = { provider: "email", account: "other@example.com" }
const at = (day: number, hour = 9) => Date.UTC(2026, 9, day, hour)

const email = (externalId: string, sentAt: number, fields: Partial<EmailInput> = {}): EmailInput => ({
  externalId,
  subject: "Invented invoice",
  from: { address: "ann@example.com", name: "Ann" },
  to: [{ address: MINE.account, name: null }],
  sentAt,
  receivedAt: sentAt,
  bodyText: "An invented body.",
  ...fields,
})

const seeded = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "mail-stats-")), "store.db")
  const store = await openStore({ path })
  const mine = await store.accounts.saveAccount(MINE, { name: null })
  const other = await store.accounts.saveAccount(OTHER, { name: null })
  await store.mail.saveThread({
    accountId: mine,
    externalId: "thread-1",
    now: at(20),
    emails: [
      // Thursday 23:30 in UTC is Friday in Madrid: the day and the week follow the timezone.
      email("<a@example.com>", at(1, 23)),
      email("<b@example.com>", at(5)),
      email("<c@example.com>", at(5), { from: { address: "bob@example.com", name: "Bob" } }),
      email("<d@example.com>", at(6), {
        from: { address: MINE.account, name: "Me" },
        to: [{ address: "ann@example.com", name: "Ann" }],
        outgoing: true,
      }),
    ],
  })
  await store.mail.saveThread({
    accountId: other,
    externalId: "thread-2",
    now: at(20),
    emails: [email("<e@example.com>", at(7), { to: [{ address: OTHER.account, name: null }] })],
  })
  return { path, store }
}

describe("mail stats", () => {
  it("**counts mail received and sent** per day, week and sender, in the timezone, and records no search", async () => {
    const { store } = await seeded()
    const runAs = { provider: "memo", account: "local" }
    const searches = async () => (await store.searches.searchHistory(100)).length
    const before = await searches()

    const days = await mailStats(store, runAs, { by: "day", timezone: "Europe/Madrid", limit: 30 })
    expect(mailStatsItem(days)).toEqual({
      by: "day",
      received: 4,
      sent: 1,
      rows: [
        { key: "2026-10-02", name: null, received: 1, sent: 0 },
        { key: "2026-10-05", name: null, received: 2, sent: 0 },
        { key: "2026-10-06", name: null, received: 0, sent: 1 },
        { key: "2026-10-07", name: null, received: 1, sent: 0 },
      ],
    })
    expect((await mailStats(store, runAs, { by: "day", timezone: "UTC", limit: 30 })).rows[0]?.key).toBe("2026-10-01")
    const weeks = await mailStats(store, runAs, { by: "week", timezone: "Europe/Madrid", limit: 1 })
    expect([weeks.rows, weeks.hasMore]).toEqual([[{ key: "2026-10-05", name: null, received: 3, sent: 1 }], true])

    const senders = await mailStats(store, runAs, { by: "sender", mailAccount: MINE.account, limit: 10 })
    expect(mailStatsItem(senders)).toEqual({
      by: "sender",
      received: 3,
      sent: 1,
      rows: [
        { key: "ann@example.com", name: "Ann", received: 2, sent: 0 },
        { key: "bob@example.com", name: "Bob", received: 1, sent: 0 },
      ],
    })
    const asked = await mailStats(store, runAs, { by: "day", text: "from:bob@example.com", limit: 30 })
    expect([asked.received, asked.sent]).toEqual([1, 0])
    expect(await searches()).toBe(before)
    await store.close()
  })

  it("reads mail through each mailbox's time index, never every email", async () => {
    const { path, store } = await seeded()
    const prepared = await prepareLucene(
      store,
      MINE,
      { kind: "mail", text: "date>=2026-10-03 from:ann@example.com", limit: 1 },
      {},
    )
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
    const execution = { ...prepared.execution, accounts: [MINE, OTHER], corpus: "mail" as const }
    for (const by of ["time_direction", "sender_direction"] as const)
      expect((await countQuery(recording as never, execution, by)).length).toBeGreaterThan(0)
    const plans = statements.flatMap((sql) =>
      sqlite.database
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null))
        .map(({ detail }) => String(detail)),
    )
    expect(plans.some((line) => /emails USING .*INDEX emails_by_time/.test(line))).toBe(true)
    expect(plans.filter((line) => /^SCAN (messages|emails|meetings)\b(?! USING)/.test(line))).toEqual([])
    sqlite.database.close()
  })
})
