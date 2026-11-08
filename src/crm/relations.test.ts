import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { afterEach, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import type { CrmDepartment, CrmUser } from "../domain/crm.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { type CrmCallContext, crmGapsOf, syncCrm } from "./index.js"
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
const acme = async ({ now }: { now?: () => number } = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-relations-")), "store.db")
  const store = await openStore({ path, ...(now ? { now } : {}) })
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

it("takes a CRM role beside the owner's confirmed one as another relationship, and proposes nothing", async () => {
  const { path, store, crm, sync, person } = await acme()
  await sync()
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  const alice = await person("alice@acme.example")
  const [reported] = (await store.knowledge.relations(null, deal)).filter(({ to }) => to === alice)
  expect(await store.knowledge.confirmRelation(null, reported?.id as string, "owner")).toMatchObject({
    standing: "confirmed",
  })
  const before = await revisions(path)
  for (const _ of [1, 2, 3]) await sync()
  expect(await revisions(path)).toBe(before)
  expect((await store.knowledge.relations(null, deal)).filter(({ to }) => to === alice)).toEqual([
    expect.objectContaining({ id: reported?.id, role: "contact", standing: "confirmed" }),
  ])
  crm.put("deal", {
    externalId: "d1",
    title: "Acme renewal",
    pipeline: "deal-1",
    stage: "new",
    people: [{ externalId: "7", role: "decision-maker" }],
    assignee: "u1",
  })
  await sync()
  const roles = (await store.knowledge.relations(null, deal))
    .filter(({ to }) => to === alice)
    .map(({ role, standing }) => [role, standing])
  expect(roles.sort()).toEqual([
    ["contact", "confirmed"],
    ["decision-maker", "reported"],
  ])
  expect(await store.proposedActions.list({ kinds: ["relationship_update"] })).toEqual([])
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
  expect((await sync()).issues).toEqual([])
  await sync()
  expect((await store.people.personOf(contact))?.uid).toBe(apart.uid)
  expect((await store.people.personOf({ provider: "email", id: "alice@acme.example" }))?.uid).not.toBe(apart.uid)
})

it("with the account set to review, writes what the CRM reports as proposals, once each", async () => {
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
  expect(report).toMatchObject({ issues: [], skippedOwnerRejected: 1 })
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

it("gives a deal the contact it named before the contact was synced, on a later run of changes only", async () => {
  const { store, crm } = await acme()
  const changes = () => syncCrm(crm, store, PORTAL)
  crm.put("deal", {
    externalId: "d2",
    title: "Acme pilot",
    pipeline: "deal-1",
    stage: "new",
    people: [{ externalId: "9", role: "contact" }],
  })
  await changes()
  const deal = (await store.crm.refOf(PORTAL, "deal", "d2")) as string
  expect((await store.deals.get(deal)).people).toEqual([])
  crm.put("person", { externalId: "9", name: "Dana", email: "dana@acme.example" })
  expect((await changes()).issues).toEqual([])
  expect((await store.deals.get(deal)).people).toEqual([expect.objectContaining({ name: "Dana", role: "contact" })])
})

it("keeps users and their employment when departments cannot be read, and withdraws an inactive user's", async () => {
  const { store, crm, person } = await acme()
  const refused = {
    departments: async () => Promise.reject(new CliError("permission_error", "https://x/?auth=s3cret")),
  }
  const first = await syncCrm(Object.assign(crm, { users: async () => USERS, ...refused }), store, PORTAL)
  expect(first.issues).toEqual([expect.objectContaining({ kind: "user", reason: "crm.not-reported" })])
  expect(JSON.stringify(first.issues)).not.toContain("s3cret")
  const sam = await person("sam@northstar.example")
  const employed = async () =>
    (await store.knowledge.relations(null, sam)).filter(
      ({ kind, standing }) => kind === "member-of" && standing === "reported",
    )
  expect(await employed()).toHaveLength(1)
  const gone = USERS.map((user) => (user.externalId === "u3" ? { ...user, active: false } : user))
  await syncCrm(Object.assign(crm, { users: async () => gone, departments: async () => DEPARTMENTS }), store, PORTAL)
  expect(await employed()).toEqual([])
})

it("keeps reporting lines of a user whose departments the CRM did not give", async () => {
  const { store, crm, sync, person } = await acme()
  await sync()
  const sam = await person("sam@northstar.example")
  const lines = async () =>
    (await store.knowledge.relations(null, sam)).filter(
      ({ kind, from, standing }) => kind === "reports-to" && from === sam && standing === "reported",
    )
  expect(await lines()).toHaveLength(1)
  const unknown = USERS.map(({ departments: _, ...user }) => user)
  await syncCrm(Object.assign(crm, { users: async () => unknown }), store, PORTAL, { rescan: true })
  expect(await lines()).toHaveLength(1)
})

it("makes a company of a mapped type a customer, a supplier or a partner of the own company", async () => {
  const { path, store, crm, sync } = await acme()
  const database = await openCache(path)
  database
    .prepare("INSERT INTO store_settings (key, value, at) VALUES (?, ?, 1)")
    .run(
      `crm.${PORTAL.provider}:${PORTAL.account}.company-types`,
      JSON.stringify({ CUSTOMER: "customer-of", SUPPLIER: "supplier", PARTNER: "partner-of" }),
    )
  database.close()
  await sync()
  crm.put("organization", { externalId: "c1", name: "Acme Ltd", type: "CUSTOMER" })
  crm.put("organization", { externalId: "c2", name: "Paperco", type: "SUPPLIER" })
  crm.put("organization", { externalId: "c3", name: "Allied", type: "PARTNER" })
  await sync()
  const named = new Map((await store.knowledge.organizations()).map(({ name, ref }) => [name, ref]))
  const own = named.get("Northstar Consulting")
  const links = async () =>
    (await store.knowledge.relations(null, own))
      .filter(({ kind, standing }) => kind !== "member-of" && standing === "reported")
      .map(({ from, to, kind }) => [from, kind, to])
  // Allied is stored after Northstar, so the partnership's lower id is Northstar's.
  expect((await links()).sort()).toEqual(
    [
      [named.get("Acme Ltd"), "customer-of", own],
      [own, "customer-of", named.get("Paperco")],
      [own, "partner-of", named.get("Allied")],
    ].sort(),
  )
  crm.put("organization", { externalId: "c2", name: "Paperco", type: null })
  await sync()
  expect((await links()).some(([, , to]) => to === named.get("Paperco"))).toBe(false)
})

it("never withdraws what another account of the same CRM reports", async () => {
  const { store, sync, person } = await acme()
  await sync()
  const alice = await person("alice@acme.example")
  const acmeRef = `organization:${(await store.knowledge.organizations()).find(({ name }) => name === "Acme Ltd")?.id}`
  const other = { provider: PORTAL.provider, account: "other.example" }
  const scope = { from: [alice], kinds: ["member-of" as const], roles: ["contact"] }
  await store.relations.syncReported(other, [{ from: alice, to: acmeRef, kind: "member-of", role: "contact" }], scope)
  await store.relations.syncReported(other, [], scope)
  await sync()
  expect(
    (await store.knowledge.relations(null, alice)).filter(
      ({ to, standing }) => to === acmeRef && standing === "reported",
    ),
  ).toHaveLength(1)
})

const setting = async (path: string, name: string, value: unknown) => {
  const database = await openCache(path)
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, 1)")
    .run(`crm.${PORTAL.provider}:${PORTAL.account}.${name}`, JSON.stringify(value))
  database.close()
}

const pendingCount = async (store: MessageStore) =>
  (JSON.parse((await store.sync.syncState(PORTAL, "crm:pending-relations"))?.value ?? "[]") as unknown[]).length

it("gives a customer listed before the own company its meaning, and a setting made later applies on the next sync", async () => {
  const { path, store, crm } = await acme()
  const changes = () => syncCrm(crm, store, PORTAL)
  crm.put("organization", { externalId: "c1", name: "Acme Ltd", type: "CUSTOMER" })
  await changes()
  const named = new Map((await store.knowledge.organizations()).map(({ name, ref }) => [name, ref]))
  const customers = async () =>
    (await store.knowledge.relations(null, named.get("Acme Ltd"))).filter(({ kind }) => kind === "customer-of")
  expect(await customers()).toEqual([])
  await setting(path, "company-types", { CUSTOMER: "customer-of" })
  await changes()
  expect(await customers()).toEqual([
    expect.objectContaining({ to: named.get("Northstar Consulting"), standing: "reported" }),
  ])
})

it("waits for no deal owner when the CRM lists no users, and says so once", async () => {
  const { store, crm } = await acme()
  delete (crm as { users?: unknown }).users
  delete (crm as { departments?: unknown }).departments
  for (const id of ["d2", "d3"])
    crm.put("deal", { externalId: id, title: id, pipeline: "deal-1", stage: "new", people: [], assignee: "u9" })
  const report = await syncCrm(crm, store, PORTAL)
  expect(report.issues.filter(({ reason }) => reason === "crm.not-reported")).toEqual([
    expect.objectContaining({ kind: "deal", message: expect.stringMatching(/^3 deal owner/) }),
  ])
  expect(await pendingCount(store)).toBe(0)
  expect(await crmGapsOf(store, PORTAL)).toEqual([expect.objectContaining({ kind: "users", reason: "not-listed" })])
})

it("drops what a deleted deal was waiting for, and never writes it", async () => {
  const { store, crm, sync } = await acme()
  crm.put("deal", {
    externalId: "d2",
    title: "Pilot",
    pipeline: "deal-1",
    stage: "new",
    people: [{ externalId: "9", role: "contact" }],
  })
  await sync()
  expect(await pendingCount(store)).toBe(1)
  const deal = (await store.crm.refOf(PORTAL, "deal", "d2")) as string
  crm.delete("deal", "d2")
  crm.put("person", { externalId: "9", name: "Dana", email: "dana@acme.example" })
  await syncCrm(crm, store, PORTAL)
  expect(await pendingCount(store)).toBe(0)
  expect(await store.knowledge.relations(null, deal)).toEqual([])
})

it("drops a relationship that waited past its time, with one issue", async () => {
  let clock = Date.UTC(2026, 10, 1)
  const { store, crm, sync } = await acme({ now: () => clock })
  crm.put("deal", {
    externalId: "d2",
    title: "Pilot",
    pipeline: "deal-1",
    stage: "new",
    people: [{ externalId: "9", role: "contact" }],
  })
  await sync()
  expect(await pendingCount(store)).toBe(1)
  clock += 31 * 86_400_000
  crm.put("person", { externalId: "8", name: "Bob", email: "bob@acme.example" })
  const report = await syncCrm(crm, store, PORTAL)
  expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "crm.pending-dropped" })]))
  expect(await pendingCount(store)).toBe(0)
})

it("keeps the owner's word on an own company through every sync", async () => {
  const { store, sync } = await acme()
  await sync()
  const named = new Map((await store.knowledge.organizations()).map(({ name, ref }) => [name, ref]))
  const northstar = named.get("Northstar Consulting") as string
  const acmeRef = named.get("Acme Ltd") as string
  expect(await store.knowledge.setOwnOrganization(northstar, false)).toEqual({ ref: northstar, own: false })
  expect(await store.knowledge.setOwnOrganization(acmeRef, true)).toEqual({ ref: acmeRef, own: true })
  await sync()
  const emma = await store.people.personOf({ provider: "email", id: "emma@northstar.example" })
  const employers = (await store.knowledge.relations(null, `person:${emma?.uid}`))
    .filter(({ kind, standing }) => kind === "member-of" && standing === "reported")
    .map(({ to }) => to)
  expect(employers).toEqual([acmeRef])
})

it("records which lists the last sync could not read, replaced by the next", async () => {
  const { store, crm, sync } = await acme()
  await syncCrm(
    Object.assign(crm, { departments: async () => Promise.reject(new CliError("permission_error", "no scope")) }),
    store,
    PORTAL,
  )
  expect(await crmGapsOf(store, PORTAL)).toEqual([
    expect.objectContaining({ kind: "departments", reason: "refused", code: "permission_error" }),
  ])
  Object.assign(crm, { departments: async () => DEPARTMENTS })
  await sync()
  expect(await crmGapsOf(store, PORTAL)).toEqual([])
})

it("names the scope a refusal carries, and keeps a gap the source reports without failing", async () => {
  const { store, crm } = await acme()
  const scoped = new CliError("permission_error", "denied", { scope: "department" })
  Object.assign(crm, {
    users: async (context?: CrmCallContext) => {
      context?.gap({ kind: "users", message: "user_basic scope missing: no e-mails", scope: "user_basic" })
      return USERS
    },
    departments: async () => Promise.reject(scoped),
  })
  const report = await syncCrm(crm, store, PORTAL)
  expect(report.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "crm.not-reported",
        message: "department scope missing: reporting lines unknown",
      }),
    ]),
  )
  expect(await crmGapsOf(store, PORTAL)).toEqual([
    { kind: "users", reason: "partial", scope: "user_basic", message: "user_basic scope missing: no e-mails" },
    {
      kind: "departments",
      reason: "refused",
      code: "permission_error",
      scope: "department",
      message: "department scope missing: reporting lines unknown",
    },
  ])
})

it("stops a source that pages its users itself as partial once the budget is spent, saving nothing half-read", async () => {
  const { store, crm } = await acme()
  let pages = 0
  Object.assign(crm, {
    users: async (context?: CrmCallContext) => {
      for (const _ of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        context?.spend()
        pages += 1
      }
      return USERS
    },
  })
  const report = await syncCrm(crm, store, PORTAL, { budget: runBudget({ requests: 9 }) })
  expect(report).toMatchObject({ state: "partial", stopped: "requests" })
  expect(pages).toBeLessThan(10)
  expect(report.users).toBeUndefined()
  expect(await store.people.personOf({ provider: "email", id: "emma@northstar.example" })).toBeUndefined()
})

it("answers the owner's edits of a CRM contact with one override, changed in place, and keeps the CRM's row", async () => {
  const { path, store, sync, person } = await acme()
  await sync()
  const alice = await person("alice@acme.example")
  const acmeRef = `organization:${(await store.knowledge.organizations()).find(({ name }) => name === "Acme Ltd")?.id}`
  const toAcme = async () => (await store.knowledge.relations(null, alice)).filter(({ to }) => to === acmeRef)
  const [reported] = await toAcme()
  const crm = reported?.id as string
  const first = await store.knowledge.updateRelation(null, crm, { role: "manager", by: "owner" })
  const second = await store.knowledge.updateRelation(null, crm, { position: "Head of buying", by: "owner" })
  const third = await store.knowledge.updateRelation(null, first.id, { startsAt: Date.UTC(2024, 0, 1), by: "owner" })
  expect(new Set([first.id, second.id, third.id]).size).toBe(1)
  expect(third).toMatchObject({ role: "manager", position: "Head of buying", standing: "confirmed" })
  expect((await toAcme()).map(({ id }) => id)).toEqual([first.id])
  await sync()
  const before = await revisions(path)
  await sync()
  await sync()
  expect(await revisions(path)).toBe(before)
  expect((await toAcme()).map(({ id }) => id)).toEqual([first.id])
  expect((await store.knowledge.listRelations({ from: alice, to: acmeRef })).items.map(({ id }) => id)).toEqual([
    first.id,
  ])

  const ended = await store.knowledge.endRelation(null, crm, Date.UTC(2025, 0, 1), "owner")
  expect(ended).toMatchObject({ id: first.id, standing: "ended" })
  expect((await toAcme()).map(({ id, standing }) => [id, standing])).toEqual([[first.id, "ended"]])

  await store.knowledge.removeRelation(null, first.id, "owner")
  await sync()
  expect((await toAcme()).map(({ id, role, standing }) => [id, role, standing])).toEqual([[crm, "contact", "reported"]])
})

it("keeps a contact's company role off the role list as a list of the CRM's words", async () => {
  const { path, store, crm, sync, person } = await acme()
  crm.put("person", {
    externalId: "7",
    name: "Alice",
    email: "alice@acme.example",
    organizations: [{ externalId: "c1", sourceRole: "Buyer" }],
  })
  await sync()
  const [member] = (await store.knowledge.relations(null, await person("alice@acme.example"))).filter(
    ({ kind }) => kind === "member-of",
  )
  expect(member).toMatchObject({ role: "contact", sourceRoles: ["Buyer"] })
  const database = await openCache(path)
  try {
    const stored = database.prepare("SELECT json_type(metadata, '$.source_role') AS type FROM links WHERE id = ?")
    expect(stored.get(Number(member?.id))).toEqual({ type: "array" })
  } finally {
    database.close()
  }
})
