import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { isUsable, RELATION_KINDS, usableLinkSql } from "../domain/relations.js"
import { openCache } from "./open.js"
import { crmSettingKey, parseCrmSetting, parseCrmSettingValue } from "./sqlite/crm-settings.js"
import { KEYED, type ReportedOutcome } from "./sqlite/reported-relations.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const SOURCE = { provider: "example-records", account: "ledger" }

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "reported-")), "store.db")
  const store = await openStore({ path })
  stores.push(store)
  const acme = (await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })).ref
  const northstar = (await store.knowledge.addOrganization({ kind: "company", name: "Northstar Consulting" })).ref
  const alice = `person:${(await store.people.add({ name: "Alice" })).uid}`
  return { path, store, acme, northstar, alice }
}

it("adds, keeps, withdraws and restores what a source reports, inside the scope it covers only", async () => {
  const { store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const], roles: ["contact"] }
  const contact = { from: alice, to: acme, kind: "member-of" as const, role: "contact" }
  await store.knowledge.relate(null, { by: "owner", from: alice, to: northstar, kind: "member-of", role: "adviser" })
  expect(await store.relations.syncReported(SOURCE, [contact], scope)).toMatchObject({ added: 1, issues: [] })
  expect(await store.relations.syncReported(SOURCE, [contact], scope)).toMatchObject({ added: 0, kept: 1 })
  expect(await store.relations.syncReported(SOURCE, [], scope)).toMatchObject({ withdrawn: 1 })
  const standings = (await store.knowledge.relations(null, alice)).map(({ to, role, standing }) => [to, role, standing])
  expect(standings).toEqual([
    [northstar, "adviser", "confirmed"],
    [acme, "contact", "ended"],
  ])
  expect(await store.relations.syncReported(SOURCE, [contact], scope)).toMatchObject({ restored: 1 })
})

it("names a ref it does not hold or ends the registry refuses, and writes nothing for them", async () => {
  const { store, acme, alice } = await fixture()
  const done = await store.relations.syncReported(
    SOURCE,
    [
      { from: "person:999999", to: acme, kind: "member-of", role: "contact" },
      { from: acme, to: alice, kind: "reports-to" },
      { from: alice, to: acme, kind: "member-of", role: "author" },
    ],
    { from: [alice], kinds: ["member-of"] },
  )
  expect(done.issues.map(({ reason }) => reason)).toEqual([
    "relationship.reference-unknown",
    "relationship.invalid",
    "relationship.invalid",
  ])
  expect(await store.knowledge.relations(null, alice)).toEqual([])
})

it("reads a CRM account's settings by its key, whatever dots its account holds", () => {
  expect(parseCrmSetting("crm.bitrix24:acme.bitrix24.example.links")).toEqual({
    key: { provider: "bitrix24", account: "acme.bitrix24.example" },
    name: "links",
  })
  expect(parseCrmSetting("crm.bitrix24:acme.example.other")).toBeUndefined()
  expect(parseCrmSettingValue("company-types", "CUSTOMER=customer-of, SUPPLIER=supplier")).toEqual({
    CUSTOMER: "customer-of",
    SUPPLIER: "supplier",
  })
  expect(() => parseCrmSettingValue("links", "auto")).toThrow(/reported or review/)
  expect(() => parseCrmSettingValue("company-types", "CUSTOMER=client")).toThrow(/TYPE=meaning/)
})

it("keeps counting what an account reported after the owner sets it to review, and proposes what it reports next", async () => {
  const { path, store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  const contact = { from: alice, to: acme, kind: "member-of" as const, role: "contact" }
  await store.relations.syncReported(SOURCE, [contact], scope)
  const database = await openCache(path)
  try {
    database
      .prepare("INSERT INTO store_settings (key, value, at) VALUES (?, ?, 1)")
      .run(crmSettingKey(SOURCE, "links"), JSON.stringify("review"))
    const adviser = { from: alice, to: northstar, kind: "member-of" as const, role: "adviser" }
    const done = await store.relations.syncReported(SOURCE, [contact, adviser, { ...adviser, role: "owner" }], scope)
    expect(done).toMatchObject({ kept: 1, proposed: 2 })
    expect(await store.proposedActions.list({ kinds: ["relationship"], status: "proposed" })).toHaveLength(2)
  } finally {
    database.close()
  }
})

it("says the same through usableLinkSql and usableLink about the same rows", async () => {
  const { path, store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  await store.knowledge.relate(null, { by: "owner", from: alice, to: northstar, kind: "member-of", role: "adviser" })
  await store.relations.syncReported(SOURCE, [{ from: alice, to: acme, kind: "member-of", role: "contact" }], scope)
  await store.relations.syncReported(SOURCE, [{ from: alice, to: acme, kind: "member-of", role: "owner" }], scope)
  const now = Date.now()
  const database = await openCache(path)
  try {
    const rows = database.prepare(`SELECT id, ${usableLinkSql("l", now)} AS usable FROM links l ORDER BY id`).all()
    const relations = await store.knowledge.relations(null, alice)
    expect(relations).toHaveLength(3)
    for (const relation of relations)
      expect(Boolean(rows.find((row) => String(row.id) === relation.id)?.usable)).toBe(isUsable(relation.standing))
  } finally {
    database.close()
  }
})

it("refuses a role change to a role the pair already holds, with a reason", async () => {
  const { store, acme, alice } = await fixture()
  await store.knowledge.relate(null, { by: "owner", from: alice, to: acme, kind: "member-of", role: "adviser" })
  const second = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: acme,
    kind: "member-of",
    role: "owner",
  })
  await expect(store.knowledge.updateRelation(null, second.id, { role: "adviser", by: "owner" })).rejects.toMatchObject(
    {
      details: { reason: "relationship.exists" },
    },
  )
})

it("lists live relationships before withdrawn ones", async () => {
  const { store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  await store.relations.syncReported(SOURCE, [{ from: alice, to: acme, kind: "member-of", role: "contact" }], scope)
  await store.relations.syncReported(
    SOURCE,
    [{ from: alice, to: northstar, kind: "member-of", role: "contact" }],
    scope,
  )
  expect((await store.knowledge.relations(null, alice)).map(({ to, standing }) => [to, standing])).toEqual([
    [northstar, "reported"],
    [acme, "ended"],
  ])
})

it("finds a reported relationship by its unique key, not by every link of its busier end", async () => {
  const { path, store, acme, alice } = await fixture()
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare")
  const contact = { from: alice, to: acme, kind: "member-of" as const, role: "contact" }
  const scope = { from: [alice], kinds: ["member-of" as const] }
  await store.relations.syncReported(SOURCE, [contact], scope)
  await store.relations.syncReported(SOURCE, [contact], scope)
  const lookups = [...new Set(prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("anchor IS NULL")))]
  prepare.mockRestore()
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    expect(lookups).toHaveLength(2)
    for (const sql of lookups)
      expect(
        database
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => row.detail),
      ).toEqual([expect.stringContaining("USING INDEX links_relationship_key (kind=? AND from_type=? AND from_id=?")])
  } finally {
    database.close()
  }
})

it("repeats the relationship key's index condition exactly, over every relationship kind (RISK-2204)", async () => {
  const { path } = await fixture()
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const index = String(
      database.prepare("SELECT sql FROM sqlite_master WHERE name='links_relationship_key'").get()?.sql,
    )
    expect(index.slice(index.indexOf(" WHERE ") + " WHERE ".length)).toBe(KEYED)
  } finally {
    database.close()
  }
  const kinds = [...(KEYED.match(/kind IN \(([^)]*)\)/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map(([, kind]) => kind)
  expect(kinds.sort()).toEqual([...RELATION_KINDS].sort())
})

it.each([
  ["confirmed", "board-member"],
  ["confirmed", ["chair", "board-member"]],
  ["overrode", ["board-member"]],
])("keeps the owner's link when the owner %s the no-role link its source called %j", async (how, sourceRole) => {
  const { store, acme, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  const bare = { from: alice, to: acme, kind: "member-of" as const, metadata: { source_role: sourceRole } }
  await store.relations.syncReported(SOURCE, [bare], scope)
  const [reported] = await store.knowledge.relations(null, alice)
  if (how === "confirmed") await store.knowledge.confirmRelation(null, reported?.id as string, "owner")
  else await store.knowledge.updateRelation(null, reported?.id as string, { role: "adviser", by: "owner" })
  await store.knowledge.addRole("organization", "board-member")
  const done = await store.relations.syncReported(SOURCE, [{ ...bare, role: "board-member" }], scope)
  expect(done).toMatchObject({ added: 0, proposed: 0, withdrawn: 0 })
  expect((await store.knowledge.relations(null, alice)).filter(({ role }) => role === "board-member")).toEqual([])
})

it("withdraws only the links its own writer wrote, so a CRM sync and an import on one account keep apart", async () => {
  const { store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  const crm = { source: "crm" }
  const imported = { source: "import:example" }
  await store.relations.syncReported(
    SOURCE,
    [{ from: alice, to: acme, kind: "member-of", role: "contact" }],
    scope,
    crm,
  )
  await store.relations.syncReported(
    SOURCE,
    [{ from: alice, to: northstar, kind: "member-of", role: "adviser" }],
    scope,
    imported,
  )
  expect(await store.relations.syncReported(SOURCE, [], scope, crm)).toMatchObject({ withdrawn: 1 })
  expect(await store.relations.syncReported(SOURCE, [], scope, imported)).toMatchObject({ withdrawn: 1 })
  expect((await store.knowledge.relations(null, alice)).map(({ to, standing }) => [to, standing])).toEqual([
    [acme, "ended"],
    [northstar, "ended"],
  ])
})

it("lets the owner remove a role that only withdrawn links still hold", async () => {
  const { store, acme, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  await store.knowledge.addRole("organization", "board-member")
  await store.relations.syncReported(
    SOURCE,
    [{ from: alice, to: acme, kind: "member-of", role: "board-member" }],
    scope,
  )
  await expect(store.knowledge.removeRole("organization", "board-member")).rejects.toMatchObject({
    details: { reason: "relationship.role-in-use" },
  })
  await store.relations.syncReported(SOURCE, [], scope)
  await expect(store.knowledge.removeRole("organization", "board-member")).resolves.toBeDefined()
})

it("writes the caller's author on a reported link, and leaves an unchanged one untouched", async () => {
  const { path, store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  const contact = { from: alice, to: acme, kind: "member-of" as const, role: "contact" }
  const adviser = { from: alice, to: northstar, kind: "member-of" as const, role: "adviser" }
  await store.relations.syncReported(SOURCE, [contact], scope)
  await store.relations.syncReported(SOURCE, [contact, adviser], scope, { by: { bot: "importer", kind: "agent" } })
  const database = await openCache(path)
  try {
    const authors = database.prepare("SELECT role, author FROM links WHERE kind = 'member-of' ORDER BY id").all()
    expect(authors).toEqual([
      { role: "contact", author: "rule" },
      { role: "adviser", author: "agent" },
    ])
    database.prepare("UPDATE links SET updated_at = 1").run()
    expect(await store.relations.syncReported(SOURCE, [contact, adviser], scope)).toMatchObject({ kept: 2 })
    expect(database.prepare("SELECT DISTINCT updated_at AS at FROM links").all()).toEqual([{ at: 1 }])
  } finally {
    database.close()
  }
})

it("tells the caller what it did to each relationship once, by its key and link", async () => {
  const { store, acme, northstar, alice } = await fixture()
  const scope = { from: [alice], kinds: ["member-of" as const] }
  const contact = { from: alice, to: acme, kind: "member-of" as const, role: "contact" }
  const adviser = { from: alice, to: northstar, kind: "member-of" as const, role: "adviser" }
  const outcomes: ReportedOutcome[] = []
  const sync = (relationships: (typeof contact)[]) =>
    store.relations.syncReported(SOURCE, relationships, scope, { onOutcome: (one) => outcomes.push(one) })
  await sync([contact, adviser])
  const [added, other] = outcomes.splice(0)
  expect(added).toMatchObject({
    outcome: "added",
    key: expect.stringMatching(/^member-of\|person:\d+\|organization:\d+\|contact$/),
  })
  await sync([contact])
  expect(outcomes.splice(0)).toEqual([
    { ...added, outcome: "kept" },
    { ...other, outcome: "withdrawn" },
  ])
  await store.knowledge.confirmRelation(null, added?.id as string, "owner")
  await store.knowledge.removeRelation(null, other?.id as string, "owner")
  const done = await sync([contact, adviser])
  expect(done).toMatchObject({ kept: 1, skippedOwnerRejected: 1 })
  expect(outcomes.map(({ outcome, id }) => [outcome, id])).toEqual([
    ["kept", added?.id],
    ["skipped", null],
  ])
})

it("gives an older row's single source_role word to readers as a list", async () => {
  const { store, acme, alice } = await fixture()
  const bare = { from: alice, to: acme, kind: "member-of" as const, metadata: { source_role: "rainmaker" } }
  await store.relations.syncReported(SOURCE, [bare], { from: [alice], kinds: ["member-of"] })
  expect(await store.knowledge.relations(null, alice)).toMatchObject([{ role: null, sourceRoles: ["rainmaker"] }])
})
