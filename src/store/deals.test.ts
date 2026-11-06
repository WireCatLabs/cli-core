import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "deals-")), "store.db") })
  stores.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  const buyer = await store.people.add({ name: "Анна" })
  await store.deals.addPipeline({ name: "Продажи", stages: ["Звонок", "КП", "Договор"], by: "owner" })
  return { store, client, buyer }
}

it("keeps the owner's deal and its people, moves it within its pipeline and closes it apart from the stage", async () => {
  const { store, client, buyer } = await fixture()
  const deal = await store.deals.add({
    by: "owner",
    title: "Сайт для клиники",
    stage: "звонок",
    organization: client.ref,
    amount: "500000",
    currency: "RUB",
    closeDate: "2026-12-01",
    people: [{ person: `person:${buyer.uid}`, role: "decision-maker" }],
  })
  expect(deal).toMatchObject({
    review: "confirmed",
    status: "open",
    pipeline: "Продажи",
    stage: "Звонок",
    amount: "500000.00",
    organization: { ref: client.ref },
    people: [{ ref: `person:${buyer.uid}`, name: "Анна", role: "decision-maker" }],
    summary: "Сайт для клиники · Звонок, 500 000.00 RUB",
  })

  expect((await store.deals.move(deal.ref, { stage: "КП", by: "owner" })).stage).toBe("КП")
  await expect(store.deals.move(deal.ref, { stage: "Нет такой", by: "owner" })).rejects.toMatchObject({
    details: { reason: "deal.stage" },
  })
  await expect(store.deals.move(deal.ref, { stage: "Договор", by: { bot: "claude-code" } })).rejects.toMatchObject({
    code: "permission_error",
  })

  const won = await store.deals.close(deal.ref, { status: "won", date: "2026-11-20", reason: "signed", by: "owner" })
  expect(won).toMatchObject({ status: "won", stage: "КП", closedDate: "2026-11-20", closedReason: "signed" })
  await expect(store.deals.move(deal.ref, { stage: "Договор", by: "owner" })).rejects.toMatchObject({
    details: { reason: "deal.closed" },
  })
  expect(await store.deals.list({ status: "open" })).toEqual([])
  expect((await store.refs.summaries([deal.ref])).get(deal.ref)).toMatchObject({
    title: "Сайт для клиники · КП, 500 000.00 RUB (won)",
  })
})

it("keeps an agent's deal proposed for the owner alone, and names the pipeline when a stage name is shared", async () => {
  const { store } = await fixture()
  await store.deals.addPipeline({ name: "Partners", stages: ["КП"], by: "owner" })
  await expect(store.deals.addPipeline({ name: "продажи", stages: ["A"], by: "owner" })).rejects.toMatchObject({
    details: { reason: "pipeline.duplicate" },
  })
  await expect(store.deals.addPipeline({ name: "Bots", stages: ["A"], by: { bot: "x" } })).rejects.toMatchObject({
    code: "permission_error",
  })
  await expect(store.deals.add({ by: "owner", title: "X", stage: "КП" })).rejects.toMatchObject({
    details: { reason: "deal.stage" },
  })
  await expect(store.deals.add({ by: "owner", title: "X", stage: "Звонок", amount: "10" })).rejects.toMatchObject({
    details: { reason: "deal.field" },
  })

  const proposed = await store.deals.add({
    by: { bot: "claude-code" },
    reason: "the client asked for a quote",
    title: "Поддержка",
    stage: "КП",
    pipeline: "partners",
  })
  expect(proposed).toMatchObject({ review: "proposed", pipeline: "Partners" })

  const registry = proposalRegistry(store)
  expect((await registry.list({ status: "proposed", limit: 10, offset: 0 })).items.map((row) => row.id)).toContain(
    proposed.ref,
  )
  const refused = await registry.decide([proposed.ref], { confirm: true, by: { bot: "other", reason: "ok" } })
  expect(refused.refused).toHaveLength(1)
  await registry.decide([proposed.ref], { confirm: true, by: "owner" })
  expect(await store.deals.list({ pipeline: "PARTNERS" })).toMatchObject([{ ref: proposed.ref, review: "confirmed" }])
  expect((await store.deals.pipelines()).find((one) => one.name === "Partners")?.stages).toEqual([
    { name: "КП", position: 1, outcome: "open", externalId: null, open: 1 },
  ])
})

it("keeps a lead pipeline apart from the deal pipeline of the same name, with the outcome of each stage", async () => {
  const { store } = await fixture()
  const leads = await store.deals.addPipeline({
    name: "продажи",
    kind: "lead",
    stages: ["Новый", { name: "Спам", outcome: "lost" }],
    by: "owner",
  })
  expect(leads).toMatchObject({ kind: "lead", account: null, externalId: null })
  expect(leads.stages.map((stage) => stage.outcome)).toEqual(["open", "lost"])
  await expect(
    store.deals.addPipeline({ name: "Продажи", kind: "lead", stages: ["A"], by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "pipeline.duplicate" } })
  await expect(store.deals.add({ by: "owner", title: "X", stage: "Новый" })).rejects.toMatchObject({
    details: { reason: "deal.stage" },
  })

  const lead = await store.deals.add({ by: "owner", kind: "lead", title: "Заявка с сайта", stage: "Новый" })
  expect(lead).toMatchObject({ ref: `lead:${lead.id}`, kind: "lead", pipeline: "продажи", rank: null })
  expect(await store.deals.list()).toEqual([])
  expect((await store.deals.list({ kind: "lead" })).map((one) => one.ref)).toEqual([lead.ref])
  expect((await store.deals.move(lead.ref, { stage: "Спам", by: "owner" })).stage).toBe("Спам")
  expect((await store.refs.summaries([lead.ref])).get(lead.ref)).toMatchObject({
    kind: "lead",
    title: "Заявка с сайта · Спам",
  })
})
