import { createReadStream } from "node:fs"
import { afterEach, expect, it } from "vitest"
import { ingestLines, linesOf } from "../services/ingest.js"
import { recordsFixture } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const EXAMPLE = new URL("../../schemas/examples/records-business.jsonl", import.meta.url)
const run = (store: Parameters<typeof ingestLines>[0], dryRun = false) =>
  ingestLines(store, linesOf(createReadStream(EXAMPLE)), { account: "demo", dryRun })
const KEY = { provider: "example-erp", account: "demo" }

it("takes the plan's example file end to end, and a second run changes nothing", async () => {
  const { store } = await recordsFixture(handles)
  const first = await run(store)
  expect(first).toMatchObject({ created: 10, refused: 0, errors: [], waiting: [], unmatched: [], truncated: false })

  const org = await store.records.get({ ...KEY, type: "organization", externalId: "C-1" })
  const anna = await store.records.get({ ...KEY, type: "person", externalId: "P-1" })
  expect(org).toMatchObject({ createdEntity: true, entity: expect.stringMatching(/^organization:/) })
  expect(anna).toMatchObject({ createdEntity: true, entity: expect.stringMatching(/^person:/) })
  expect(anna?.relations).toEqual([
    expect.objectContaining({ role: "member-of", type: "organization", externalId: "C-1", resolved: true }),
  ])

  const deal = await store.records.get({ ...KEY, type: "deal", externalId: "D-7" })
  expect(await store.deals.get(deal?.entity as string)).toMatchObject({
    title: "Rental fleet 2027",
    stage: "New",
    amount: "120000.00",
    organization: { ref: org?.entity },
    people: [expect.objectContaining({ ref: anna?.entity, role: "decision-maker" })],
  })

  const refOf = async (type: string, externalId: string) =>
    (await store.records.get({ ...KEY, type, externalId }))?.entity as string
  const contract = await store.contracts.get(await refOf("contract", "K-2026-14"))
  expect(contract).toMatchObject({ review: "proposed", value: "120000.00", deal: deal?.entity, noticeDays: 30 })
  const order = await store.orders.get(await refOf("order", "O-55"))
  expect(order).toMatchObject({
    review: "proposed",
    direction: "sale",
    total: "120000.00",
    contract: contract.ref,
    customer: { ref: org?.entity },
    supplier: { owner: true },
    lines: [expect.objectContaining({ quantity: "12", product: await refOf("product", "SKU-RENT") })],
  })
  const invoice = await store.finance.invoice(await refOf("invoice", "INV-901"))
  expect(invoice).toMatchObject({ review: "proposed", contract: contract.ref, total: "10000.00" })
  const payment = await store.finance.payment(await refOf("payment", "PAY-3"))
  expect(payment).toMatchObject({
    review: "proposed",
    allocations: [expect.objectContaining({ invoice: invoice.ref, amount: "10000.00" })],
  })
  expect([...first.proposed].sort()).toEqual([contract.ref, order.ref, invoice.ref, payment.ref].sort())

  const quote = await store.records.get({ ...KEY, type: "custom:quote", externalId: "Q-7" })
  expect(quote).toMatchObject({
    entity: null,
    fields: { options: [{ bikes: 12, insurance: { kind: "full" } }] },
    relations: [expect.objectContaining({ role: "quoted-for", type: "deal", externalId: "D-7", resolved: true })],
  })

  const again = await run(store)
  expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 10, proposed: [], flagged: [], errors: [] })
})

it("dry-runs the example: the receipt is the real one, and nothing is written", async () => {
  const { store } = await recordsFixture(handles)
  const dry = await run(store, true)
  expect(dry).toMatchObject({ dryRun: true, created: 10, refused: 0, waiting: [], errors: [] })
  expect(dry.proposed).toHaveLength(4)
  expect(await store.records.get({ ...KEY, type: "deal", externalId: "D-7" })).toBeUndefined()
  expect(await store.finance.invoices()).toEqual([])
})
