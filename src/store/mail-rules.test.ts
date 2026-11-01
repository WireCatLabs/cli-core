import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { type EmailInput, mailStoreOver } from "./sqlite/emails.js"
import { openSqlite } from "./sqlite/open.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const seeded = async () => {
  const { database, orm } = await openSqlite(join(mkdtempSync(join(tmpdir(), "mail-rules-")), "store.db"))
  opened.push(database)
  migrate(database)
  const account = database.prepare(
    "INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (?, 'email', ?, ?, 1, 1)",
  )
  account.run(1, "owner@example.com", "Owner Example")
  account.run(2, "other@example.com", "Other Example")
  return { database, mail: mailStoreOver({ database, orm, now: () => 1 }) }
}

const envelope = (id: string, size: number, mailRuleId: number | null, overrides: Partial<EmailInput> = {}) => ({
  externalId: id,
  subject: null,
  from: { address: "news@shop.example", name: null },
  sentAt: null,
  bodyText: null,
  size,
  mailRuleId,
  ...overrides,
})

const shop = { domain: "shop.example" }
const rule = (overrides = {}) => ({
  conditions: shop,
  actions: { store: "envelope" },
  source: "owner",
  decidedAt: 100,
  ...overrides,
})

describe("mail rules", () => {
  it("replaces a rule with the same conditions in any key order and keeps its id", async () => {
    const { mail } = await seeded()
    const first = await mail.rules.upsert(1, rule({ conditions: { listId: "weekly.example", from: "a@x.example" } }), 1)
    const again = await mail.rules.upsert(
      1,
      rule({ conditions: { from: "a@x.example", listId: "weekly.example" }, actions: { store: "full" } }),
      2,
    )
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ actions: { store: "full" }, protected: false, createdAt: 1, updatedAt: 2 })
    expect(await mail.rules.list(1)).toHaveLength(1)
    expect(await mail.rules.list(2)).toEqual([])
  })

  it("keeps the protected flag, the source and the reason", async () => {
    const { mail } = await seeded()
    await mail.rules.upsert(
      1,
      rule({ conditions: { domain: "gov.example" }, actions: { store: "full" }, protected: true, reason: "never" }),
      1,
    )
    expect(await mail.rules.list(1)).toEqual([
      expect.objectContaining({ protected: true, source: "owner", reason: "never", decidedAt: 100 }),
    ])
  })

  it("counts every rule's live emails and bytes in one answer", async () => {
    const { mail } = await seeded()
    const envelopes = await mail.rules.upsert(1, rule(), 1)
    const other = await mail.rules.upsert(1, rule({ conditions: { from: "alerts@ops.example" } }), 1)
    await mail.saveThread({
      accountId: 1,
      externalId: "t1",
      now: 5,
      emails: [
        envelope("<a@shop>", 300, envelopes.id),
        envelope("<b@shop>", 200, envelopes.id),
        envelope("<c@ops>", 50, other.id),
      ],
    })
    await mail.markDeleted(1, ["<b@shop>"], 6)
    expect(await mail.rules.counts(1)).toEqual([
      { ruleId: envelopes.id, emails: 1, bytes: 300 },
      { ruleId: other.id, emails: 1, bytes: 50 },
    ])
  })

  it("assigns older emails to a rule and clears them when the rule is removed", async () => {
    const { mail } = await seeded()
    const saved = await mail.rules.upsert(1, rule(), 1)
    await mail.saveThread({
      accountId: 1,
      externalId: "t1",
      now: 5,
      emails: [envelope("<a@shop>", 10, null), envelope("<b@shop>", 20, null)],
    })
    expect(await mail.rules.assign(1, saved.id, ["<a@shop>", "<b@shop>", "<missing@shop>"], 7)).toBe(2)
    expect((await mail.email(1, "<a@shop>"))?.mailRuleId).toBe(saved.id)

    expect(await mail.rules.remove(1, { domain: "shop.example" })).toBe(true)
    expect(await mail.rules.remove(1, { domain: "shop.example" })).toBe(false)
    expect((await mail.email(1, "<a@shop>"))?.mailRuleId).toBeNull()
    expect(await mail.rules.counts(1)).toEqual([])
  })

  it("refuses to assign another account's rule", async () => {
    const { mail } = await seeded()
    const theirs = await mail.rules.upsert(2, rule(), 1)
    await expect(mail.rules.assign(1, theirs.id, ["<a@shop>"], 2)).rejects.toThrow(/not a rule of account 1/)
  })

  it("keeps the rule when an email is saved again without one, and clears it on null", async () => {
    const { mail } = await seeded()
    const saved = await mail.rules.upsert(1, rule(), 1)
    const save = (input: EmailInput) => mail.saveThread({ accountId: 1, externalId: "t1", now: 5, emails: [input] })
    await save(envelope("<a@shop>", 10, saved.id))
    const { mailRuleId: _, ...withoutRule } = envelope("<a@shop>", 10, null)
    await save(withoutRule)
    expect((await mail.email(1, "<a@shop>"))?.mailRuleId).toBe(saved.id)
    await save(envelope("<a@shop>", 10, null, { bodyText: "The whole text" }))
    expect((await mail.email(1, "<a@shop>"))?.mailRuleId).toBeNull()
  })
})

it("filters mail rules without crossing account scope", async () => {
  const { mail } = await seeded()
  const selected = await mail.rules.upsert(1, rule({ protected: true }), 1)
  await mail.rules.upsert(1, rule({ conditions: { domain: "other.example" }, source: "probe" }), 1)
  await mail.rules.upsert(2, rule({ protected: true }), 1)
  expect(await mail.rules.list(1, parseLucene(`protected:true AND source:owner AND id:${selected.id}`))).toEqual([
    selected,
  ])
  expect(await mail.rules.list(2, parseLucene(`id:${selected.id}`))).toEqual([])
  expect(await mail.rules.list(1)).toHaveLength(2)
})
