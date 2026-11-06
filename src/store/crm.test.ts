import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { CrmPipeline } from "../domain/crm.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "portal-a" }
const OTHER = { provider: "example-crm", account: "portal-b" }

const SALES: CrmPipeline = {
  externalId: "p1",
  name: "Sales",
  stages: [
    { externalId: "s1", name: "New", position: 10, outcome: "open" },
    { externalId: "s2", name: "Quote", position: 20, outcome: "open" },
    { externalId: "s3", name: "Won", position: 30, outcome: "won" },
    { externalId: "s4", name: "Lost", position: 40, outcome: "lost" },
  ],
}

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-")), "store.db") })
  stores.push(store)
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  return store
}

it("copies a CRM's pipeline with its stages in the CRM's order, apart from the owner's own", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  const [pipeline] = await store.deals.pipelines({ kind: "deal", account: PORTAL })
  expect(pipeline).toMatchObject({
    name: "Sales",
    kind: "deal",
    account: PORTAL,
    externalId: "p1",
    stages: [
      { name: "New", position: 1, outcome: "open", externalId: "s1" },
      { name: "Quote", position: 2, outcome: "open", externalId: "s2" },
      { name: "Won", position: 3, outcome: "won", externalId: "s3" },
      { name: "Lost", position: 4, outcome: "lost", externalId: "s4" },
    ],
  })
  expect(await store.deals.pipelines({ kind: "deal", account: "own" })).toEqual([])
})

it("takes two stages swapping names, and two stages of one name, without breaking the unique name", async () => {
  const store = await open()
  const swapped = SALES.stages.map((stage) =>
    stage.externalId === "s1"
      ? { ...stage, name: "Quote" }
      : stage.externalId === "s2"
        ? { ...stage, name: "New" }
        : stage,
  )
  await store.crm.savePipelines(PORTAL, "deal", [{ ...SALES, stages: swapped }])
  const [pipeline] = await store.deals.pipelines({ account: PORTAL })
  expect(pipeline?.stages.slice(0, 2).map(({ externalId, name }) => [externalId, name])).toEqual([
    ["s1", "Quote"],
    ["s2", "New"],
  ])
  const twice = SALES.stages.map((stage) => (stage.externalId === "s2" ? { ...stage, name: "new" } : stage))
  await store.crm.savePipelines(PORTAL, "deal", [{ ...SALES, stages: twice }])
  expect((await store.deals.pipelines({ account: PORTAL }))[0]?.stages.map(({ name }) => name)).toEqual([
    "New",
    "new",
    "Won",
    "Lost",
  ])
})

it("saves a deal with its status from its stage, its company as an organization of its own, and its contacts", async () => {
  const store = await open()
  const same = await store.knowledge.addOrganization({ kind: "company", name: "Example LLC" })
  await store.crm.saveOrganizations(PORTAL, [{ externalId: "c1", name: "Example LLC" }])
  await store.crm.savePeople(PORTAL, [{ externalId: "5", name: "Ana Example", email: "Ana@Example.com" }])
  const saved = await store.crm.saveItems(PORTAL, "deal", [
    {
      externalId: "d1",
      title: "Website",
      pipeline: "p1",
      stage: "s3",
      amount: "1500.50",
      currency: "EUR",
      organization: "c1",
      people: [{ externalId: "5", role: "decision-maker" }],
      createdAt: Date.UTC(2026, 9, 1),
      updatedAt: Date.UTC(2026, 9, 20),
    },
  ])
  expect(saved).toEqual({ saved: 1, skipped: [] })
  const [deal] = await store.deals.list({ account: PORTAL, kind: "deal" })
  expect(deal).toMatchObject({
    title: "Website",
    stage: "Won",
    status: "won",
    amount: "1500.50",
    currency: "EUR",
    closedDate: "2026-10-20",
    externalId: "d1",
    account: PORTAL,
    source: "crm",
    author: { type: "bot", name: "example-crm", kind: "rule" },
    people: [{ role: "decision-maker", name: "Ana Example" }],
  })
  expect(deal?.organization?.ref).not.toBe(same.ref)
  expect(deal?.organization?.name).toBe("Example LLC")
  const person = await store.people.personOf({ provider: "email", id: "ana@example.com" })
  expect(person?.uid).toBe(deal?.people[0]?.ref.replace("person:", ""))
})

it("keeps two portals' contacts of one id apart", async () => {
  const store = await open()
  await store.crm.savePeople(PORTAL, [{ externalId: "5", name: "Ana" }])
  await store.crm.savePeople(OTHER, [{ externalId: "5", name: "Boris" }])
  const ana = await store.people.personOf({ provider: "example-crm", id: "portal-a/5" })
  const boris = await store.people.personOf({ provider: "example-crm", id: "portal-b/5" })
  expect(ana?.uid).toBeDefined()
  expect(ana?.uid).not.toBe(boris?.uid)
  expect(await store.crm.count(PORTAL, "person")).toBe(1)
})

it("skips and names an item whose stage is not stored or whose money the store refuses", async () => {
  const store = await open()
  const saved = await store.crm.saveItems(PORTAL, "deal", [
    { externalId: "d1", title: "Unknown stage", pipeline: "p1", stage: "s9" },
    { externalId: "d2", title: "Odd money", pipeline: "p1", stage: "s1", amount: "10", currency: "XXZ" },
    { externalId: "d3", title: "Fine", pipeline: "p1", stage: "s1" },
  ])
  expect(saved.saved).toBe(1)
  expect(saved.skipped.map(({ externalId, reason }) => [externalId, reason])).toEqual([
    ["d1", "crm.stage-unknown"],
    ["d2", "crm.item-invalid"],
  ])
})

it("marks deleted what the CRM deleted or no longer lists, never a row changed since the list began", async () => {
  const store = await open()
  const item = (externalId: string, updatedAt: number) => ({
    externalId,
    title: externalId,
    pipeline: "p1",
    stage: "s1",
    updatedAt,
  })
  await store.crm.saveItems(PORTAL, "deal", [item("d1", 1_000), item("d2", 1_000), item("d3", 9_000)])
  expect(await store.crm.remove(PORTAL, "deal", ["d1"])).toBe(1)
  expect(await store.crm.removeUnlisted(PORTAL, "deal", [], 5_000, { dryRun: true })).toBe(1)
  expect(await store.crm.count(PORTAL, "deal")).toBe(2)
  expect(await store.crm.removeUnlisted(PORTAL, "deal", [], 5_000)).toBe(1)
  expect((await store.deals.list({ account: PORTAL })).map(({ externalId }) => externalId)).toEqual(["d3"])
  await store.crm.saveItems(PORTAL, "deal", [item("d1", 10_000)])
  expect(await store.crm.count(PORTAL, "deal")).toBe(2)
})

it("follows a company's new name on the organization it made for it", async () => {
  const store = await open()
  await store.crm.saveOrganizations(PORTAL, [{ externalId: "c1", name: "Old name" }])
  await store.crm.saveItems(PORTAL, "deal", [
    { externalId: "d1", title: "x", pipeline: "p1", stage: "s1", organization: "c1" },
  ])
  await store.crm.saveOrganizations(PORTAL, [{ externalId: "c1", name: "New name" }])
  const [deal] = await store.deals.list({ account: PORTAL })
  expect(deal?.organization?.name).toBe("New name")
})

it("leaves a CRM's copies to the CRM: the owner's writes neither find its stages nor move its deals", async () => {
  const store = await open()
  await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "x", pipeline: "p1", stage: "s1" }])
  await expect(store.deals.add({ by: "owner", title: "Mine", stage: "Quote" })).rejects.toThrow(/no stage named Quote/)
  const [copy] = await store.deals.list({ account: PORTAL })
  await expect(store.deals.move(copy?.ref as string, { stage: "Quote", by: "owner" })).rejects.toThrow(
    /change it there/,
  )
})
