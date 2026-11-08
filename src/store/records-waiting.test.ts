import { afterEach, expect, it } from "vitest"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

it("keeps records whose references are not imported yet, and projects them when a later batch brings them", async () => {
  const { store } = await recordsFixture(handles)
  const first = await take(
    store,
    envelopeOf(
      [
        upsert(
          "order",
          "o-1",
          { direction: "sale", currency: "EUR", lines: [{ product: "sku", quantity: "2" }] },
          { relations: [{ role: "customer", type: "organization", external_id: "c" }] },
        ),
        upsert("deal", "d-1", { title: "Deal", pipeline: "sales", stage: "new" }),
        upsert(
          "transaction",
          "t-1",
          { direction: "out", amount: "5.00", date: "2026-11-01" },
          { relations: [{ role: "wallet", type: "wallet", external_id: "w" }] },
        ),
      ],
      { batch: "one" },
    ),
  )
  expect(first.proposed).toEqual([])
  expect(first.waiting).toEqual([
    { key: "order-o-1", pointer: "/records/0/relations", missing: ["customer", "fields.lines.product"] },
    { key: "deal-d-1", pointer: "/records/1/relations", missing: ["fields.pipeline"] },
    { key: "transaction-t-1", pointer: "/records/2/relations", missing: ["wallet"] },
  ])
  expect(await store.records.list({ ...SOURCE, waiting: true })).toHaveLength(3)

  const second = await take(
    store,
    envelopeOf(
      [
        upsert("organization", "c", { name: "Client" }),
        upsert("product", "sku", { name: "Bike", unit_price: "7.00", currency: "EUR" }),
        upsert("pipeline", "sales", { name: "Sales", stages: [{ external_id: "new", name: "New" }] }),
        upsert("wallet", "w", { name: "Cash", currency: "EUR", kind: "cash" }),
      ],
      { batch: "two" },
    ),
  )
  expect(second).toMatchObject({ created: 4, waiting: [], errors: [] })
  expect(second.proposed).toHaveLength(2)
  const orderRef = (await store.records.get({ ...SOURCE, type: "order", externalId: "o-1" }))?.entity as string
  expect(await store.orders.get(orderRef)).toMatchObject({
    total: "14.00",
    lines: [expect.objectContaining({ description: "Bike" })],
  })
  expect((await store.records.get({ ...SOURCE, type: "deal", externalId: "d-1" }))?.entity).toMatch(/^deal:/)
  expect(await store.records.list({ ...SOURCE, waiting: true })).toEqual([])
})

it("never resolves a reference to another account's record, and keeps the same external ids apart", async () => {
  const { store } = await recordsFixture(handles)
  const records = [
    upsert("organization", "c", { name: "Same id" }),
    upsert("pipeline", "sales", { name: "Sales", stages: [{ external_id: "new", name: "New" }] }),
    upsert(
      "deal",
      "d",
      { title: "Deal", pipeline: "sales", stage: "new" },
      {
        relations: [{ role: "organization", type: "organization", external_id: "c" }],
      },
    ),
  ]
  await take(store, envelopeOf(records))
  const lonely = await take(store, envelopeOf([records[2]], { account: "other" }), { account: "other" })
  expect(lonely.waiting).toEqual([
    { key: "deal-d", pointer: "/records/0/relations", missing: ["organization", "fields.pipeline"] },
  ])
  await take(store, envelopeOf(records, { account: "other" }), { account: "other" })
  const mine = await store.records.get({ ...SOURCE, type: "deal", externalId: "d" })
  const theirs = await store.records.get({ ...SOURCE, account: "other", type: "deal", externalId: "d" })
  expect(mine?.entity).not.toBe(theirs?.entity)
  const orgs = [
    (await store.records.get({ ...SOURCE, type: "organization", externalId: "c" }))?.entity,
    (await store.records.get({ ...SOURCE, account: "other", type: "organization", externalId: "c" }))?.entity,
  ]
  expect(new Set(orgs).size).toBe(2)
  expect((await store.deals.get(theirs?.entity as string)).organization?.ref).toBe(orgs[1])
})
