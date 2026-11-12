import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
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
  const sales = await store.deals.addPipeline({
    name: "Продажи",
    stages: ["Звонок", "КП", "Договор", { name: "Успех", outcome: "won" }, { name: "Отказ", outcome: "lost" }],
    by: "owner",
  })
  return { store, client, buyer, sales }
}

it("keeps a deal with its people, moves it within its pipeline, and closes it into the stage of that outcome", async () => {
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
    kind: "deal",
    status: "open",
    pipelineName: "Продажи",
    stage: "Звонок",
    amount: "500000.00",
    organization: { ref: client.ref },
    people: [{ ref: `person:${buyer.uid}`, name: "Анна", role: "decision-maker" }],
    summary: "Сайт для клиники · Звонок, 500 000.00 RUB",
  })
  expect((await store.deals.move(deal.ref, { stage: "КП", by: { bot: "claude-code" } })).stage).toBe("КП")
  await expect(store.deals.move(deal.ref, { stage: "Нет такой", by: "owner" })).rejects.toMatchObject({
    details: { reason: "deal.stage" },
  })
  const won = await store.deals.close(deal.ref, { status: "won", date: "2026-11-20", reason: "signed", by: "owner" })
  expect(won).toMatchObject({ status: "won", stage: "Успех", closedDate: "2026-11-20", closedReason: "signed" })
  expect((await store.deals.list({ status: "open" })).items).toEqual([])
  expect((await store.refs.summaries([deal.ref])).get(deal.ref)).toMatchObject({
    title: "Сайт для клиники · Успех, 500 000.00 RUB (won)",
  })
})

it("counts how far deals got through a pipeline from the stages they entered", async () => {
  const { store, sales } = await fixture()
  const add = (title: string) => store.deals.add({ by: { bot: "claude-code" }, title, stage: "Звонок" })
  const [a, b, c, d] = [await add("a"), await add("b"), await add("c"), await add("d")]
  await store.deals.move(a.ref, { stage: "КП", by: "owner" })
  await store.deals.move(a.ref, { stage: "Договор", by: "owner" })
  await store.deals.close(a.ref, { status: "won", by: "owner" })
  await store.deals.move(b.ref, { stage: "КП", by: "owner" })
  await store.deals.close(b.ref, { status: "lost", by: "owner" })
  await store.deals.move(c.ref, { stage: "КП", by: "owner" })
  expect(d.status).toBe("open")

  const report = await store.deals.pipeline(sales.ref)
  expect(report.stages.map(({ name, reached, conversion, open }) => ({ name, reached, conversion, open }))).toEqual([
    { name: "Звонок", reached: 4, conversion: 0.75, open: 1 },
    { name: "КП", reached: 3, conversion: 0.333, open: 1 },
    { name: "Договор", reached: 1, conversion: 1, open: 0 },
    { name: "Успех", reached: 1, conversion: null, open: 0 },
    { name: "Отказ", reached: 1, conversion: null, open: 0 },
  ])
  expect(report.totals).toEqual({ items: 4, open: 2, won: 1, lost: 1, winRate: 0.5 })
})

it("sums what stands in each stage per currency, from the same rows a since day counts", async () => {
  let now = Date.parse("2026-10-01T09:00:00Z")
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "deals-")), "store.db"), now: () => now })
  stores.push(store)
  const sales = await store.deals.addPipeline({
    name: "Sales",
    stages: ["Call", { name: "Won", outcome: "won" }],
    by: "owner",
  })
  const add = (title: string, amount?: string, currency?: string) =>
    store.deals.add({ by: "owner", title, stage: "Call", ...(amount && currency ? { amount, currency } : {}) })
  await add("old", "1000", "EUR")
  now = Date.parse("2026-11-01T09:00:00Z")
  await add("a", "0.10", "EUR")
  await add("b", "0.20", "EUR")
  await add("c", "5", "JPY")
  await add("d")
  const all = await store.deals.pipeline(sales.ref)
  expect(all.stages.map(({ name, items, amounts }) => ({ name, items, amounts }))).toEqual([
    {
      name: "Call",
      items: 5,
      amounts: [
        { amount: "1000.30", currency: "EUR", items: 3 },
        { amount: "5", currency: "JPY", items: 1 },
      ],
    },
    { name: "Won", items: 0, amounts: [] },
  ])
  const recent = await store.deals.pipeline(sales.ref, { since: "2026-10-15" })
  expect(recent.stages[0]).toMatchObject({
    items: 4,
    amounts: [{ amount: "0.30", currency: "EUR", items: 2 }, { currency: "JPY" }],
  })
  expect(recent.totals.items).toBe(4)
})

it("starts a lead in the seeded lead pipeline, and asks for a reference when a name is shared", async () => {
  const { store } = await fixture()
  const lead = await store.deals.add({ kind: "lead", by: { bot: "claude-code" }, title: "Звонок с сайта" })
  expect(lead).toMatchObject({ ref: expect.stringMatching(/^lead:/), pipelineName: "Leads", stage: "new" })
  expect((await store.deals.pipelines({ kind: "lead" }))[0]?.stages.map((stage) => stage.name)).toEqual([
    "new",
    "contacted",
    "qualified",
    "won",
    "lost",
  ])
  await expect(store.deals.get(lead.ref.replace("lead:", "deal:"))).rejects.toThrow()
  expect((await store.deals.list()).items).toEqual([])
  expect((await store.deals.list({ kind: "lead" })).items).toMatchObject([{ ref: lead.ref }])

  await store.deals.addPipeline({ name: "Продажи", kind: "lead", stages: ["Звонок"], by: "owner" })
  await expect(store.deals.pipeline("продажи")).rejects.toMatchObject({ details: { reason: "pipeline.ambiguous" } })
  await expect(
    store.deals.addPipeline({ name: "продажи", stages: ["A"], by: { bot: "claude-code" } }),
  ).rejects.toMatchObject({ details: { reason: "pipeline.duplicate" } })
  await expect(store.deals.add({ kind: "lead", by: "owner", title: "x" })).rejects.toMatchObject({
    details: { reason: "deal.stage" },
  })
})
