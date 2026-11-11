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
  const {
    items: [deal],
  } = await store.deals.list({ account: PORTAL, kind: "deal" })
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
  const ana = await store.people.personOf({ provider: "example-crm", id: "portal-a/contact/5" })
  const boris = await store.people.personOf({ provider: "example-crm", id: "portal-b/contact/5" })
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
  expect((await store.deals.list({ account: PORTAL })).items.map(({ externalId }) => externalId)).toEqual(["d3"])
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
  const {
    items: [deal],
  } = await store.deals.list({ account: PORTAL })
  expect(deal?.organization?.name).toBe("New name")
})

it("leaves a CRM's copies to the CRM: the owner's writes neither find its stages nor move its deals", async () => {
  const store = await open()
  await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "x", pipeline: "p1", stage: "s1" }])
  await expect(store.deals.add({ by: "owner", title: "Mine", stage: "Quote" })).rejects.toThrow(/no stage named Quote/)
  const {
    items: [copy],
  } = await store.deals.list({ account: PORTAL })
  await expect(store.deals.move(copy?.ref as string, { stage: "Quote", by: "owner" })).rejects.toThrow(
    /change it there/,
  )
})

it("takes a deal's own status over its stage's outcome, as a CRM that keeps won and lost on the deal gives it", async () => {
  const store = await open()
  await store.crm.saveItems(PORTAL, "deal", [
    {
      externalId: "d1",
      title: "Won in an open stage",
      pipeline: "p1",
      stage: "s2",
      status: "won",
      closedDate: "2026-10-30",
    },
    {
      externalId: "d2",
      title: "Lost in an open stage",
      pipeline: "p1",
      stage: "s2",
      status: "lost",
      updatedAt: Date.UTC(2026, 9, 31),
    },
    { externalId: "d3", title: "No status of its own", pipeline: "p1", stage: "s3" },
  ])
  const byId = Object.fromEntries(
    (await store.deals.list({ account: PORTAL })).items.map((one) => [one.externalId, one]),
  )
  expect(byId.d1).toMatchObject({ stage: "Quote", status: "won", closedDate: "2026-10-30" })
  expect(byId.d2).toMatchObject({ stage: "Quote", status: "lost", closedDate: "2026-10-31" })
  expect(byId.d3).toMatchObject({ stage: "Won", status: "won" })
})

it("keeps a deal pipeline and a lead pipeline with the same id apart", async () => {
  const store = await open()
  await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "x", pipeline: "p1", stage: "s1" }])
  const leads = await store.crm.savePipelines(PORTAL, "lead", [
    { ...SALES, name: "Leads", stages: [{ externalId: "l1", name: "New", position: 1, outcome: "open" }] },
  ])
  expect(leads).toEqual({ saved: 1, skipped: [] })
  expect((await store.deals.pipelines({ account: PORTAL })).map(({ kind, name }) => [kind, name])).toEqual([
    ["lead", "Leads"],
    ["deal", "Sales"],
  ])
  const lead = await store.crm.saveItems(PORTAL, "lead", [
    { externalId: "x1", title: "x", pipeline: "p1", stage: "l1" },
  ])
  expect(lead).toEqual({ saved: 1, skipped: [] })
  expect(
    (await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d2", title: "y", pipeline: "p1", stage: "s2" }])).saved,
  ).toBe(1)
})

it("leaves out a pipeline the CRM no longer lists, keeps its deals, lists it again when the CRM does, and an empty list marks nothing", async () => {
  const store = await open()
  await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "x", pipeline: "p1", stage: "s1" }])
  await store.crm.savePipelines(PORTAL, "deal", [])
  expect(await store.deals.pipelines({ account: PORTAL })).toHaveLength(1)
  await store.crm.savePipelines(PORTAL, "deal", [{ ...SALES, externalId: "p2", name: "Other" }])
  expect((await store.deals.pipelines({ account: PORTAL })).map(({ name }) => name)).toEqual(["Other"])
  const {
    items: [deal],
  } = await store.deals.list({ account: PORTAL })
  expect(deal).toMatchObject({ externalId: "d1", pipelineName: "Sales" })
  expect((await store.deals.pipeline(deal?.pipeline as string)).name).toBe("Sales")
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  expect((await store.deals.pipelines({ account: PORTAL })).map(({ name }) => name)).toEqual(["Sales"])
})

it("keeps a CRM's fields in its order and names a code it lists twice instead of keeping both", async () => {
  const store = await open()
  const field = (code: string, label: string) => ({ code, label, type: "string", multiple: false, filterable: true })
  const saved = await store.crm.saveFields(PORTAL, "organization", [
    field("B", "Second"),
    field("A", "First"),
    field("B", "Again"),
  ])
  expect(saved).toMatchObject({ saved: 2, skipped: [{ externalId: "B", reason: "crm.item-invalid" }] })
  expect((await store.crm.fields(PORTAL, "organization")).map(({ code, label }) => [code, label])).toEqual([
    ["B", "Second"],
    ["A", "First"],
  ])
  expect(await store.crm.fields({ provider: "example-crm", account: "other" }, "organization")).toEqual([])
})

it("keeps every phone and address of a contact, the first ones as its phone and email", async () => {
  const store = await open()
  await store.crm.savePeople(PORTAL, [
    {
      externalId: "7",
      name: "Lev Orlov",
      phone: "+34 600 000 001",
      email: "lev@acme.ru",
      phones: ["+34 600 000 001", "+34 600 000 002", " "],
      emails: ["lev@acme.ru", "Lev.Home@Mail.ru"],
    },
  ])
  const ref = { provider: "example-crm", id: "portal-a/contact/7" }

  const contactOf = async () =>
    (await store.people.personOf(ref))?.identities.find(({ provider }) => provider === "example-crm")
  const identity = await contactOf()

  expect(identity).toMatchObject({
    phone: "+34 600 000 001",
    phones: ["+34 600 000 001", "+34 600 000 002"],
    emails: ["lev@acme.ru", "lev.home@mail.ru"],
  })
  await store.crm.savePeople(PORTAL, [{ externalId: "7", name: "Lev Orlov", phones: ["+34 600 000 003"] }])
  expect(await contactOf()).toMatchObject({
    phones: ["+34 600 000 001", "+34 600 000 003"],
    emails: ["lev@acme.ru", "lev.home@mail.ru"],
  })
})
