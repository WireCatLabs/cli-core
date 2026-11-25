import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import type { EmailInput } from "./sqlite/emails.js"
import { type AccountKey, openStore } from "./store.js"

const MAIL: AccountKey = { provider: "email", account: "me@acme.example.com" }
const NOW = Date.parse("2026-11-25T12:00:00Z")

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const count = (db: CacheDatabase, sql: string) => Number(db.prepare(sql).get()?.n)

const email = (n: number, newsletter: boolean): EmailInput => ({
  externalId: `<m${n}@acme.example.com>`,
  subject: `Issue ${n}`,
  from: newsletter
    ? { address: "author@letters.example.com", name: "Author" }
    : { address: `friend${n % 7}@friends.example.com`, name: `Friend ${n % 7}` },
  to: [{ address: MAIL.account, name: null }],
  sentAt: NOW - n * 60_000,
  receivedAt: NOW - n * 60_000,
  bodyText: null,
  headers: newsletter ? { "list-id": "letters.example.com", "list-unsubscribe": true } : {},
})

it("types a version 75 store's mail on the first read that asks, in batches, and keeps it current", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-76-")), "store.db")
  const store = await openStore({ path })
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  const emails = Array.from({ length: 4_500 }, (_, n) => email(n, n % 3 === 0))
  await store.mail.saveThreads(
    Array.from({ length: 45 }, (_, t) => ({
      accountId,
      externalId: `t${t}`,
      now: NOW,
      emails: emails.slice(t * 100, t * 100 + 100),
    })),
  )
  await store.close()
  const old = await openCache(path)
  rollBackTo(old, 76)
  expect(old.prepare("SELECT 1 FROM pragma_table_info('emails') WHERE name = 'mail_type'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  handles.push(upgraded)
  const after = await openCache(path)
  handles.push(after)
  expect(count(after, "SELECT count(*) AS n FROM emails WHERE mail_type IS NULL")).toBe(4_500)

  const newsletters = await upgraded.mail.emails({ types: ["newsletter"], reaches: ["broadcast"] })
  expect(newsletters).toHaveLength(1_500)
  expect(count(after, "SELECT count(*) AS n FROM emails WHERE mail_type IS NULL")).toBe(0)
  expect(count(after, "SELECT count(*) AS n FROM emails WHERE mail_type = 'personal' AND reach = 'direct'")).toBe(3_000)

  // A 1.0 build knows no type: what it writes is worked out on the next read that asks.
  after
    .prepare("UPDATE emails SET headers = json_object('list-id', 'letters.example.com') WHERE external_id = ?")
    .run("<m1@acme.example.com>")
  expect(count(after, "SELECT count(*) AS n FROM emails WHERE mail_type IS NULL")).toBe(1)
  expect(await upgraded.mail.emails({ types: ["newsletter"] })).toHaveLength(1_501)
  const plan = after
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM emails e WHERE e.mail_type IN (SELECT value FROM json_each(?))")
    .all('["order"]')
    .map((row) => String(row.detail))
  expect(plan.join(" ")).toContain("emails_by_mail_type")
})
