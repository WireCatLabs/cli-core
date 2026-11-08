import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { CrmPipeline, CrmStage } from "../domain/crm.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "portal-a" }
const OTHER = { provider: "example-crm", account: "portal-b" }

const stage = (externalId: string, name: string, outcome: CrmStage["outcome"] = "open"): CrmStage => ({
  externalId,
  name,
  position: Number(externalId.slice(1)) * 10,
  outcome,
})

const SALES: CrmPipeline = {
  externalId: "p1",
  name: "Sales",
  stages: [
    stage("s1", "Inbox"),
    stage("s2", "Proposal"),
    stage("s3", "Contract"),
    stage("s4", "Paid", "won"),
    stage("s5", "Refused", "lost"),
  ],
}

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "base-stages-")), "store.db") })
  stores.push(store)
  return store
}

const mapped = async (store: MessageStore, pipeline?: string) =>
  Object.fromEntries(
    (await store.baseStages.mappings(pipeline === undefined ? {} : { pipeline })).map((row) => [
      row.name,
      `${row.baseStage?.name ?? "-"}${row.confirmed ? "" : "?"}`,
    ]),
  )

const refOf = async (store: MessageStore, name: string) =>
  (await store.baseStages.mappings()).find((row) => row.name === name)?.ref as string

it("makes the default sets on first use, each base stage its own, and suggests for pipelines synced before", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  const deals = await store.baseStages.show("deal")
  expect(deals.stages.map(({ name, outcome }) => `${name}:${outcome}`)).toEqual([
    "New:open",
    "Qualification:open",
    "Proposal:open",
    "Negotiation:open",
    "Won:won",
    "Lost:lost",
  ])
  expect((await store.deals.pipelines({ kind: "deal", account: "own" })).map(({ name }) => name)).toEqual([
    "Base stages",
  ])
  // Open stages by relative place: 3 open onto 4, the middle one between Qualification and Proposal takes its name.
  expect(await mapped(store)).toEqual({
    Inbox: "New?",
    Proposal: "Proposal?",
    Contract: "Negotiation?",
    Paid: "Won?",
    Refused: "Lost?",
  })
  expect(deals.unsorted).toEqual({ open: 0, stages: 5 })
})

it("takes the store's own Leads pipeline as the lead set, so a lead still starts in its first stage", async () => {
  const store = await open()
  const [seeded] = await store.deals.pipelines({ kind: "lead", account: "own" })
  const leads = await store.baseStages.show("lead")
  expect(leads.pipeline).toBe(seeded?.ref)
  expect(leads.stages.map(({ name, outcome }) => `${name}:${outcome}`)).toEqual([
    "new:open",
    "contacted:open",
    "qualified:open",
    "won:won",
    "lost:lost",
  ])
  const lead = await store.deals.add({ by: "owner", kind: "lead", title: "Call from the site" })
  expect(lead).toMatchObject({ stage: "new", baseStage: { ref: leads.stages[0]?.ref, name: "new" } })
  expect(await store.deals.pipelines({ kind: "lead", account: "own" })).toHaveLength(1)
})

it("makes a deal set of its own beside several own deal pipelines", async () => {
  const store = await open()
  for (const name of ["Retail", "Wholesale"])
    await store.deals.addPipeline({ by: "owner", name, stages: ["Call", { name: "Done", outcome: "won" }] })
  const deals = await store.baseStages.show("deal")
  expect(deals.stages.map(({ name }) => name)).toEqual([
    "New",
    "Qualification",
    "Proposal",
    "Negotiation",
    "Won",
    "Lost",
  ])
  expect(deals.unsorted).toEqual({ open: 0, stages: 0 })
})

it("between two base stages without a name in common, takes the nearer, and suggests on every later sync", async () => {
  const store = await open()
  await store.baseStages.show("deal")
  await store.crm.savePipelines(OTHER, "deal", [
    {
      externalId: "q",
      name: "Wide",
      stages: [stage("s1", "A"), stage("s2", "B"), stage("s3", "C"), stage("s4", "D"), stage("s5", "E")],
    },
  ])
  // Five open onto four: places 0, 0.75, 1.5, 2.25, 3.
  expect(await mapped(store)).toEqual({
    A: "New?",
    B: "Qualification?",
    C: "Proposal?",
    D: "Proposal?",
    E: "Negotiation?",
  })
})

it("deals show their base stage only once its mapping is confirmed, one stage or a whole pipeline", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  await store.crm.saveItems(PORTAL, "deal", [
    { externalId: "d1", title: "Kitchen", pipeline: "p1", stage: "s2" },
    { externalId: "d2", title: "Office", pipeline: "p1", stage: "s1" },
  ])
  const [pipeline] = await store.deals.pipelines({ account: PORTAL })
  const base = await store.baseStages.show("deal")
  const negotiation = base.stages.find(({ name }) => name === "Negotiation")?.ref as string
  expect((await store.deals.list()).map(({ baseStage }) => baseStage)).toEqual([null, null])

  const one = await store.baseStages.map(await refOf(store, "Proposal"), negotiation)
  expect(one).toMatchObject({ baseStage: { ref: negotiation, name: "Negotiation" }, confirmed: true })
  const kitchen = (await store.deals.list()).find(({ title }) => title === "Kitchen")
  expect(kitchen?.baseStage).toEqual({ ref: negotiation, name: "Negotiation" })
  expect(kitchen?.stage).toBe("Proposal")

  expect(await store.baseStages.confirm({ pipeline: pipeline?.ref as string })).toBe(4)
  expect(await mapped(store)).toEqual({
    Inbox: "New",
    Proposal: "Negotiation",
    Contract: "Negotiation",
    Paid: "Won",
    Refused: "Lost",
  })
  const board = await store.baseStages.show("deal")
  expect(board.stages.map(({ name, open, mapped }) => `${name}:${open}/${mapped}`)).toEqual([
    "New:1/1",
    "Qualification:0/0",
    "Proposal:0/0",
    "Negotiation:1/2",
    "Won:0/1",
    "Lost:0/1",
  ])
  expect(board.unsorted).toEqual({ open: 0, stages: 0 })
})

it("a sync never changes a confirmed mapping, and a stage new after the confirm waits unconfirmed", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  const base = await store.baseStages.show("deal")
  await store.baseStages.map(await refOf(store, "Inbox"), base.stages[2]?.ref as string)
  await store.baseStages.confirm({ all: true })
  await store.crm.savePipelines(PORTAL, "deal", [
    {
      ...SALES,
      stages: [stage("s1", "Inbox renamed"), stage("s6", "Brand new"), ...SALES.stages.slice(1)],
    },
  ])
  expect(await mapped(store)).toEqual({
    "Inbox renamed": "Proposal",
    "Brand new": "Negotiation?",
    Proposal: "Proposal",
    Contract: "Negotiation",
    Paid: "Won",
    Refused: "Lost",
  })
  expect((await store.baseStages.show("deal")).unsorted.stages).toBe(1)
  expect((await store.baseStages.mappings({ unconfirmed: true })).map(({ name }) => name)).toEqual(["Brand new"])
})

it("a move to a base stage takes the one stage of the row's pipeline mapped there, or names the candidates", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "Kitchen", pipeline: "p1", stage: "s1" }])
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  await store.baseStages.confirm({ all: true })

  expect(await store.baseStages.resolve(deal, "won")).toEqual({
    stage: { ref: await refOf(store, "Paid"), name: "Paid", externalId: "s4", outcome: "won" },
  })

  await store.baseStages.map(await refOf(store, "Proposal"), "Negotiation")
  const many = store.baseStages.resolve(deal, "Negotiation")
  await expect(many).rejects.toMatchObject({
    code: "validation_error",
    details: {
      reason: "stage.choice-required",
      candidates: [
        { ref: await refOf(store, "Proposal"), name: "Proposal", external_id: "s2", outcome: "open" },
        { ref: await refOf(store, "Contract"), name: "Contract", external_id: "s3", outcome: "open" },
      ],
    },
  })

  const contract = await refOf(store, "Contract")
  expect((await store.baseStages.resolve(deal, contract)).stage).toMatchObject({ ref: contract, externalId: "s3" })

  await expect(store.baseStages.resolve(deal, "Qualification")).rejects.toMatchObject({
    code: "validation_error",
    details: { reason: "stage.unmapped" },
    message: expect.stringContaining("`stages set <stage:id>"),
  })
})

it("a suggestion is no candidate for a move until the owner confirms it", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  await store.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "Kitchen", pipeline: "p1", stage: "s1" }])
  await store.baseStages.show("deal")
  await expect(
    store.baseStages.resolve((await store.crm.refOf(PORTAL, "deal", "d1")) as string, "Won"),
  ).rejects.toMatchObject({ details: { reason: "stage.unmapped" } })
})

it("edits a base set and keeps at least one stage of each outcome", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  const names = (set: { stages: { name: string }[] }) => set.stages.map(({ name }) => name)

  const added = await store.baseStages.add("deal", { name: "Demo" })
  expect(names(added)).toEqual(["New", "Qualification", "Proposal", "Negotiation", "Demo", "Won", "Lost"])
  const ended = await store.baseStages.add("deal", { name: "Paused", outcome: "lost" })
  expect(names(ended).at(-1)).toBe("Paused")
  const moved = await store.baseStages.move("deal", "Demo", 2)
  expect(names(moved).slice(0, 3)).toEqual(["New", "Demo", "Qualification"])
  expect(moved.stages.map(({ position }) => position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  const renamed = await store.baseStages.rename("deal", "demo", "Presentation")
  expect(names(renamed)[1]).toBe("Presentation")

  await expect(store.baseStages.rename("deal", "Presentation", "new")).rejects.toMatchObject({
    details: { reason: "stage.base-field" },
  })
  await expect(store.baseStages.remove("deal", "Won")).rejects.toMatchObject({
    details: { reason: "stage.base-outcome" },
  })
  await expect(store.baseStages.remove("deal", "Missing")).rejects.toMatchObject({ code: "not_found" })

  // Removing a column sends what was confirmed onto it back to a suggestion.
  await store.baseStages.confirm({ all: true })
  const removed = await store.baseStages.remove("deal", "Lost")
  expect(names(removed).at(-1)).toBe("Paused")
  expect((await mapped(store)).Refused).toBe("Paused?")
})

it("keeps a base stage the owner's own deals stood in", async () => {
  const store = await open()
  const base = await store.baseStages.show("deal")
  const own = await store.deals.add({ by: "owner", title: "Own", stage: "Qualification", pipeline: base.pipeline })
  expect(own.baseStage).toEqual({ ref: base.stages[1]?.ref, name: "Qualification" })
  await store.baseStages.add("deal", { name: "Spare" })
  await expect(store.baseStages.remove("deal", "Qualification")).rejects.toMatchObject({
    details: { reason: "stage.base-in-use" },
  })
  expect(await store.baseStages.resolve(own.ref, "Proposal")).toMatchObject({ stage: { name: "Proposal" } })
})

it("counts and maps only the accounts in scope, with the owner's own", async () => {
  const store = await open()
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  await store.crm.savePipelines(OTHER, "deal", [{ ...SALES, name: "Elsewhere" }])
  await store.crm.saveItems(OTHER, "deal", [{ externalId: "d9", title: "Far", pipeline: "p1", stage: "s1" }])
  await store.baseStages.confirm({ all: true }, { accounts: [PORTAL] })
  expect((await store.baseStages.mappings({ accounts: [OTHER] })).every(({ confirmed }) => !confirmed)).toBe(true)
  expect((await store.baseStages.show("deal", { accounts: [PORTAL] })).unsorted).toEqual({ open: 0, stages: 0 })
  expect((await store.baseStages.show("deal", { accounts: [OTHER] })).unsorted).toEqual({ open: 1, stages: 5 })
  const far = (await store.baseStages.mappings({ accounts: [OTHER] }))[0]?.ref as string
  await expect(store.baseStages.map(far, "New", { accounts: [PORTAL] })).rejects.toMatchObject({ code: "not_found" })
})
