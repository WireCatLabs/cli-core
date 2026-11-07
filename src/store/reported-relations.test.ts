import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { usableLinkSql } from "../domain/relations.js"
import { openCache } from "./open.js"
import { crmSettingKey, parseCrmSetting, parseCrmSettingValue } from "./sqlite/crm-settings.js"
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

it("counts what an account reports until the owner sets that account to review", async () => {
  const { path, store, acme, alice } = await fixture()
  await store.relations.syncReported(SOURCE, [{ from: alice, to: acme, kind: "member-of", role: "contact" }], {
    from: [alice],
    kinds: ["member-of"],
  })
  const database = await openCache(path)
  try {
    const usable = () =>
      Number(database.prepare(`SELECT count(*) AS n FROM links l WHERE ${usableLinkSql("l", Date.now())}`).get()?.n)
    expect(usable()).toBe(1)
    database
      .prepare("INSERT INTO store_settings (key, value, at) VALUES (?, ?, 1)")
      .run(crmSettingKey(SOURCE, "links"), JSON.stringify("review"))
    expect(usable()).toBe(0)
  } finally {
    database.close()
  }
})
