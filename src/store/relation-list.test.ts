import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const CRM = { provider: "example-crm", account: "acme.example" }
const OTHER = { provider: "example-crm", account: "other.example" }

/** Alice and Bob at Acme, Bob over Alice, a deal with Alice on it, CRM claims from two accounts and one suggestion. */
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "relation-list-")), "store.db")
  const store = await openStore({ path })
  stores.push(store)
  const acme = (await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })).ref
  const northstar = (await store.knowledge.addOrganization({ kind: "company", name: "Northstar" })).ref
  const alice = `person:${(await store.people.add({ name: "Alice" })).uid}`
  const bob = `person:${(await store.people.add({ name: "Bob" })).uid}`
  await store.deals.addPipeline({ name: "Sales", stages: ["Call"], by: "owner" })
  const deal = (await store.deals.add({ by: "owner", title: "Acme renewal", stage: "Call" })).ref
  const employee = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: acme,
    kind: "member-of",
    role: "employee",
    startsAt: Date.UTC(2024, 0, 1),
    endsAt: Date.UTC(2025, 0, 1),
  })
  const manager = await store.knowledge.relate(null, { by: "owner", from: alice, to: bob, kind: "reports-to" })
  await store.knowledge.relate(null, { by: "owner", from: deal, to: alice, kind: "related-to", role: "contact" })
  const scope = { from: [bob], kinds: ["member-of" as const] }
  await store.relations.syncReported(CRM, [{ from: bob, to: acme, kind: "member-of", role: "contact" }], scope)
  await store.relations.syncReported(OTHER, [{ from: bob, to: northstar, kind: "member-of", role: "contact" }], scope)
  const proposal = await store.knowledge.proposeRelation(
    null,
    { from: bob, to: northstar, kind: "customer-of" },
    { bot: "claude" },
  )
  return { path, store, acme, northstar, alice, bob, deal, employee, manager, proposal }
}

it("filters by kind, role, ends and standing, and leaves ended ones out unless asked", async () => {
  const { store, acme, alice, bob, employee, proposal } = await fixture()
  const ids = async (filter: Parameters<typeof store.knowledge.listRelations>[0]) =>
    (await store.knowledge.listRelations(filter)).items.map(({ id }) => id)
  expect(await ids({ kind: "reports-to" })).toHaveLength(1)
  expect(await ids({ role: "contact", kind: "member-of" })).toHaveLength(2)
  expect(await ids({ from: bob, to: acme })).toHaveLength(1)
  expect(await ids({ standing: "reported" })).toHaveLength(2)
  expect(await ids({ standing: "proposed" })).toEqual([proposal.id])
  expect(await ids({ from: alice })).not.toContain(employee.id)
  expect(await ids({ from: alice, includeEnded: true })).toContain(employee.id)
  expect(await ids({ standing: "ended" })).toEqual([employee.id])
  expect(await ids({ from: alice, at: Date.UTC(2024, 5, 1), includeEnded: true })).toContain(employee.id)
  expect(await ids({ from: alice, at: Date.UTC(2023, 5, 1), includeEnded: true })).not.toContain(employee.id)
})

it("reads a ref both ways with direction and the inverse label", async () => {
  const { store, bob } = await fixture()
  const { items } = await store.knowledge.listRelations({ about: bob, kind: "reports-to" })
  expect(items).toEqual([expect.objectContaining({ to: bob, direction: "incoming", inverse: "manages" })])
  const outgoing = await store.knowledge.listRelations({ about: bob, standing: "proposed" })
  expect(outgoing.items).toEqual([
    expect.objectContaining({ source: "proposal", kind: "customer-of", direction: "outgoing" }),
  ])
})

it("keeps a source's relationships to the accounts in scope, and the owner's always", async () => {
  const { store, bob } = await fixture()
  const { items } = await store.knowledge.listRelations({ from: bob, kind: "member-of", accounts: [CRM] })
  expect(items).toEqual([expect.objectContaining({ standing: "reported" })])
  expect((await store.knowledge.listRelations({ kind: "reports-to", accounts: [] })).items).toHaveLength(1)
})

it("leaves out every row touching a denied kind", async () => {
  const { store, alice } = await fixture()
  const { items } = await store.knowledge.listRelations({ about: alice, deniedKinds: ["deal", "lead"] })
  expect(items.some(({ from, to }) => from.startsWith("deal:") || to.startsWith("deal:"))).toBe(false)
  expect(
    (await store.knowledge.listRelations({ about: alice })).items.some(({ from }) => from.startsWith("deal:")),
  ).toBe(true)
})

it("pages links and proposals in one order", async () => {
  const { store } = await fixture()
  const first = await store.knowledge.listRelations({ limit: 3 })
  const second = await store.knowledge.listRelations({ limit: 3, page: 2 })
  const all = await store.knowledge.listRelations({ limit: 500 })
  expect(first.hasMore).toBe(true)
  expect(second.hasMore).toBe(false)
  expect([...first.items, ...second.items].map(({ id, source }) => `${source}:${id}`)).toEqual(
    all.items.map(({ id, source }) => `${source}:${id}`),
  )
  expect(all.items.some(({ source }) => source === "proposal")).toBe(true)
})

it("flags a stored role off the list its ends take", async () => {
  const { path, store, alice, employee } = await fixture()
  const database = await openCache(path)
  database.prepare("UPDATE links SET role = 'author' WHERE id = ?").run(Number(employee.id))
  database.close()
  const { items } = await store.knowledge.listRelations({ from: alice, includeEnded: true })
  expect(items.find(({ id }) => id === employee.id)).toMatchObject({ role: "author", custom: true })
  expect(items.find(({ kind }) => kind === "reports-to")).toMatchObject({ custom: false })
})
