import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { CrmDepartment, CrmUser } from "../domain/crm.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { syncCrm } from "./index.js"
import { fakeCrmSource } from "./testing/index.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "northstar.example" }

const USERS: CrmUser[] = [
  { externalId: "u1", name: "Emma", email: "emma@northstar.example", position: "Sales owner", departments: ["10"] },
  { externalId: "u2", name: "Grace", email: "grace@northstar.example", departments: ["1"] },
  { externalId: "u3", name: "Sam", email: "sam@northstar.example", departments: ["10"] },
]
const DEPARTMENTS: CrmDepartment[] = [
  { externalId: "1", name: "Board", head: "u2" },
  { externalId: "10", name: "Sales", parent: "1", head: "u1" },
]

/** Acme is the client, Northstar the own company; Emma owns the Acme renewal, Alice is Acme's contact on it. */
const acme = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-relations-")), "store.db")
  const store = await openStore({ path })
  stores.push(store)
  const crm = fakeCrmSource({ traits: { removedInChanges: true } })
  crm.put("organization", { externalId: "c1", name: "Acme Ltd" })
  crm.put("organization", { externalId: "my1", name: "Northstar Consulting", own: true })
  crm.put("person", {
    externalId: "7",
    name: "Alice",
    email: "alice@acme.example",
    position: "Procurement manager",
    organizations: [{ externalId: "c1", primary: true }],
  })
  crm.put("person", { externalId: "8", name: "Bob", email: "bob@acme.example", organizations: [{ externalId: "c1" }] })
  crm.put("deal", {
    externalId: "d1",
    title: "Acme renewal",
    pipeline: "deal-1",
    stage: "new",
    organization: "c1",
    people: [{ externalId: "7", role: "contact", primary: true }],
    assignee: "u1",
  })
  const source = Object.assign(crm, {
    users: async () => USERS,
    departments: async () => DEPARTMENTS,
  })
  const sync = () => syncCrm(source, store, PORTAL, { rescan: true })
  const person = async (email: string) => {
    const found = await store.people.personOf({ provider: "email", id: email })
    return `person:${found?.uid}`
  }
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) ?? "deal:1"
  return { path, store, crm, sync, person, deal }
}

const revisions = async (path: string) => {
  const database = await openCache(path)
  try {
    return Number(database.prepare("SELECT count(*) AS n FROM link_revisions").get()?.n)
  } finally {
    database.close()
  }
}

it("puts Alice on the deal as its contact and Emma as its owner, beside the owner's Bob, each once after three syncs", async () => {
  const { path, store, sync, person } = await acme()
  const first = await sync()
  expect(first.issues).toEqual([])
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  const [alice, bob, emma, grace, sam] = await Promise.all(
    [
      "alice@acme.example",
      "bob@acme.example",
      "emma@northstar.example",
      "grace@northstar.example",
      "sam@northstar.example",
    ].map(person),
  )
  await store.knowledge.relate(null, {
    by: "owner",
    from: deal,
    to: bob as string,
    kind: "related-to",
    role: "decision-maker",
  })
  const after = await revisions(path)
  await sync()
  await sync()
  expect(await revisions(path)).toBe(after)

  const people = (await store.deals.get(deal)).people.map(({ ref, role }) => [ref, role])
  expect(people.sort()).toEqual(
    [
      [alice, "contact"],
      [bob, "decision-maker"],
      [emma, "owner"],
    ].sort(),
  )
  const standing = (await store.knowledge.relations(null, deal)).map(({ to, standing }) => [to, standing])
  expect(standing).toEqual(
    expect.arrayContaining([
      [alice, "reported"],
      [bob, "confirmed"],
      [emma, "reported"],
    ]),
  )

  const acmeRef = `organization:${(await store.knowledge.organizations()).find(({ name }) => name === "Acme Ltd")?.id}`
  const own = (await store.knowledge.organizations()).find(({ name }) => name === "Northstar Consulting")
  expect(await store.knowledge.relations(null, alice)).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "member-of", to: acmeRef, role: "contact" })]),
  )
  const emmaLinks = await store.knowledge.relations(null, emma)
  expect(emmaLinks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "member-of", to: `organization:${own?.id}`, role: "employee" }),
      expect.objectContaining({ kind: "reports-to", from: emma, to: grace, standing: "reported" }),
      expect.objectContaining({ kind: "reports-to", from: sam, to: emma }),
    ]),
  )
  expect(
    (await store.knowledge.relations(null, grace)).filter((one) => one.from === grace && one.kind === "reports-to"),
  ).toEqual([])
  const database = await openCache(path)
  try {
    const keys = database
      .prepare(
        "SELECT count(*) AS n, count(DISTINCT kind || from_type || from_id || to_type || to_id || ifnull(role, '')) AS d " +
          "FROM links WHERE kind IN ('member-of', 'related-to', 'reports-to')",
      )
      .get()
    expect(keys?.n).toBe(keys?.d)
    expect(
      database
        .prepare("SELECT json_extract(metadata, '$.derived') AS derived FROM links WHERE kind = 'reports-to'")
        .all(),
    ).toEqual([{ derived: "department-head" }, { derived: "department-head" }])
    expect(
      database
        .prepare(
          "SELECT json_extract(metadata, '$.position') AS position FROM links WHERE kind = 'member-of' AND role = 'contact' AND from_id = ?",
        )
        .get(Number(alice?.slice("person:".length)))?.position,
    ).toBe("Procurement manager")
  } finally {
    database.close()
  }
})

it("makes Bob Alice's manager only when the owner or a source says so", async () => {
  const { store, sync, person } = await acme()
  await sync()
  const [alice, bob] = await Promise.all(["alice@acme.example", "bob@acme.example"].map(person))
  expect((await store.knowledge.relations(null, alice)).filter(({ kind }) => kind === "reports-to")).toEqual([])
  await store.knowledge.relate(null, { by: "owner", from: alice as string, to: bob as string, kind: "reports-to" })
  await sync()
  expect((await store.knowledge.relations(null, alice)).filter(({ kind }) => kind === "reports-to")).toEqual([
    expect.objectContaining({ from: alice, to: bob, standing: "confirmed" }),
  ])
})

it("never overwrites the owner's role: a different role from the CRM waits as one relationship_update proposal", async () => {
  const { store, crm, sync, person } = await acme()
  await sync()
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  const alice = await person("alice@acme.example")
  const [reported] = (await store.knowledge.relations(null, deal)).filter(({ to }) => to === alice)
  await store.knowledge.confirmRelation(null, reported?.id as string, "owner")
  crm.put("deal", {
    externalId: "d1",
    title: "Acme renewal",
    pipeline: "deal-1",
    stage: "new",
    people: [{ externalId: "7", role: "decision-maker" }],
    assignee: "u1",
  })
  const again = await sync()
  await sync()
  expect(again.conflicts).toBe(1)
  expect((await store.deals.get(deal)).people.filter(({ ref }) => ref === alice)).toEqual([
    expect.objectContaining({ role: "contact" }),
  ])
  const pending = await store.proposedActions.list({ kinds: ["relationship_update"], status: "proposed" })
  expect(pending).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ changes: { role: "decision-maker" } }) }),
  ])
})

it("keeps a contact the owner separated apart through every sync, and names the person after the contact", async () => {
  const { store, sync } = await acme()
  await store.people.savePeople({ provider: "email", account: "owner@example.com" }, [
    { id: "alice@acme.example", name: null, email: "alice@acme.example" },
  ])
  await sync()
  const contact = { provider: PORTAL.provider, id: `${PORTAL.account}/contact/7` }
  const joined = await store.people.personOf(contact)
  expect(joined).toMatchObject({ name: "Alice" })
  expect(joined?.identities.map(({ provider }) => provider).sort()).toEqual(["email", "example-crm"])
  const apart = await store.people.unlinkIdentity(contact, { method: "manual", by: "owner" })
  expect((await sync()).issues).toEqual([
    expect.objectContaining({ kind: "person", externalId: "7", reason: "crm.email-ambiguous" }),
  ])
  await sync()
  expect((await store.people.personOf(contact))?.uid).toBe(apart.uid)
  expect((await store.people.personOf({ provider: "email", id: "alice@acme.example" }))?.uid).not.toBe(apart.uid)
})

it("with the account set to review, writes what the CRM reports as proposals, and a removed one stays out", async () => {
  const { path, store, sync, person } = await acme()
  const database = await openCache(path)
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, 1)")
    .run(`crm.${PORTAL.provider}:${PORTAL.account}.links`, JSON.stringify("review"))
  database.close()
  await sync()
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  expect(await store.knowledge.relations(null, deal)).toEqual([])
  const proposed = await store.proposedActions.list({ kinds: ["relationship"], status: "proposed" })
  expect(proposed.map(({ payload }) => (payload as { kind: string }).kind).sort()).toEqual([
    "member-of",
    "member-of",
    "member-of",
    "member-of",
    "member-of",
    "related-to",
    "related-to",
    "reports-to",
    "reports-to",
  ])
  await sync()
  expect(await store.proposedActions.list({ kinds: ["relationship"], status: "proposed" })).toHaveLength(9)
  const alice = await person("alice@acme.example")
  expect(alice).toMatch(/^person:/)
})

it("withdraws what the CRM stops reporting and leaves out a pair the owner removed", async () => {
  const { store, crm, sync, person } = await acme()
  await sync()
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  const [alice, emma] = await Promise.all(["alice@acme.example", "emma@northstar.example"].map(person))
  crm.put("deal", {
    externalId: "d1",
    title: "Acme renewal",
    pipeline: "deal-1",
    stage: "new",
    people: [],
    assignee: "u1",
  })
  await sync()
  const relations = await store.knowledge.relations(null, deal)
  expect(relations.map(({ to, standing }) => [to, standing]).sort()).toEqual([
    [alice, "ended"],
    [emma, "reported"],
  ])
  expect((await store.deals.get(deal)).people.map(({ ref }) => ref)).toEqual([emma])
  const owner = relations.find(({ to }) => to === emma)
  await store.knowledge.removeRelation(null, owner?.id as string, "owner")
  const report = await sync()
  expect(report.issues).toEqual([expect.objectContaining({ kind: "deal", reason: "relationship.owner-rejected" })])
  expect((await store.deals.get(deal)).people).toEqual([])
})

it("names a deal's contact the CRM never synced instead of dropping it silently", async () => {
  const { store, crm, sync } = await acme()
  crm.put("deal", {
    externalId: "d2",
    title: "Acme pilot",
    pipeline: "deal-1",
    stage: "new",
    people: [{ externalId: "404", role: "contact" }],
  })
  const report = await sync()
  expect(report.issues).toEqual([
    expect.objectContaining({ kind: "deal", externalId: "d2", reason: "crm.reference-unknown" }),
  ])
  expect(await store.crm.count(PORTAL, "deal")).toBe(2)
})
