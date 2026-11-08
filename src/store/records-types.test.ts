import { afterEach, expect, it } from "vitest"
import { RECORD_ENTITY_TYPES, RECORD_TYPES } from "../domain/record-types.js"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const org = { role: "organization", type: "organization", external_id: "c-1" }
const party = (role: string) => ({ role, type: "organization", external_id: "c-1" })

/** One record of every registered type, each naming the others by external id. */
const EVERY_TYPE = [
  upsert("organization", "c-1", {
    name: "ООО Ромашка",
    identifiers: [{ scheme: "domain", value: "romashka.example" }],
  }),
  upsert("person", "p-1", { name: "Иван", phone: "+7 900 000-00-01" }),
  upsert("project", "pr-1", { name: "Rental", key: "RNT" }, { relations: [org] }),
  upsert("product", "sku-1", { name: "Bike, month", kind: "service", unit_price: "100.00", currency: "EUR" }),
  upsert("pipeline", "funnel", { name: "Sales", stages: [{ external_id: "s1", name: "New" }] }),
  upsert("pipeline", "leads", { kind: "lead", name: "Leads", stages: [{ external_id: "l1", name: "Fresh" }] }),
  upsert("deal", "d-1", { title: "Fleet", pipeline: "funnel", stage: "s1" }, { relations: [org] }),
  upsert(
    "lead",
    "l-1",
    { title: "Inbound", pipeline: "leads", stage: "l1" },
    {
      relations: [org, { role: "deal", type: "deal", external_id: "d-1" }],
    },
  ),
  upsert("contract", "k-1", { name: "Frame", kind: "service" }, { relations: [party("party")] }),
  upsert(
    "order",
    "o-1",
    { number: "O-1", direction: "sale", currency: "EUR", lines: [{ product: "sku-1", quantity: "2" }] },
    { relations: [party("customer")] },
  ),
  upsert(
    "invoice",
    "i-1",
    { direction: "receivable", currency: "EUR", lines: [{ description: "Rent", amount: "200.00" }] },
    { relations: [party("counterparty"), { role: "contract", type: "contract", external_id: "k-1" }] },
  ),
  upsert(
    "payment",
    "pay-1",
    { direction: "in", amount: "200.00", currency: "EUR", date: "2026-11-01" },
    { relations: [party("payer"), { role: "settles", type: "invoice", external_id: "i-1" }] },
  ),
  upsert(
    "subscription",
    "sub-1",
    {
      direction: "receivable",
      interval: "1-month",
      start_date: "2026-11-01",
      prices: [{ amount: "100.00", currency: "EUR" }],
    },
    { relations: [party("customer"), { role: "product", type: "product", external_id: "sku-1" }] },
  ),
  upsert("wallet", "w-1", { name: "Main", currency: "EUR", number_hint: "1234", opening_balance: "-5.00" }),
  upsert(
    "transaction",
    "t-1",
    { direction: "in", amount: "200.00", date: "2026-11-01", splits: [{ amount: "150.00", category: "rent" }] },
    { relations: [{ role: "wallet", type: "wallet", external_id: "w-1" }] },
  ),
]

it("imports one record of every type into its entity: a proposal where money counts, a direct row elsewhere", async () => {
  const { store } = await recordsFixture(handles)
  expect(new Set(EVERY_TYPE.map((record) => record.type))).toEqual(new Set(RECORD_ENTITY_TYPES))
  const receipt = await take(store, envelopeOf(EVERY_TYPE))
  expect(receipt).toMatchObject({ refused: 0, errors: [], waiting: [], unmatched: [] })
  expect(receipt.created).toBe(EVERY_TYPE.length)

  for (const record of EVERY_TYPE) {
    const stored = await store.records.get({ ...SOURCE, type: record.type, externalId: record.external_id })
    expect([record.key, stored?.entity?.split(":")[0]]).toEqual([record.key, record.type])
    const review = RECORD_TYPES[record.type as keyof typeof RECORD_TYPES].review
    const proposed = receipt.proposed.includes(stored?.entity as string)
    // A contract without a value feeds no total: it is written confirmed.
    expect([record.key, proposed]).toEqual([record.key, review === "proposal"])
  }

  const ref = async (type: string, externalId: string) =>
    (await store.records.get({ ...SOURCE, type, externalId }))?.entity as string
  expect(await store.wallets.get(await ref("wallet", "w-1"))).toMatchObject({
    openingBalance: null,
    numberHint: "1234",
  })
  expect(await store.transactions.get(await ref("transaction", "t-1"))).toMatchObject({
    review: "proposed",
    splits: [expect.objectContaining({ category: "rent", amount: "150.00" })],
    uncategorized: "50.00",
  })
  expect(await store.subscriptions.get(await ref("subscription", "sub-1"))).toMatchObject({
    review: "proposed",
    product: await ref("product", "sku-1"),
    prices: [expect.objectContaining({ amount: "100.00", review: "proposed" })],
  })
  expect(await store.deals.get(await ref("lead", "l-1"))).toMatchObject({
    kind: "lead",
    deal: await ref("deal", "d-1"),
  })
  const project = await ref("project", "pr-1")
  expect(project).toMatch(/^project:/)
  expect(await store.contracts.get(await ref("contract", "k-1"))).toMatchObject({ review: "confirmed", value: null })
})

it("refuses what the registry rules out, each at its pointer with a stable code", async () => {
  const { store } = await recordsFixture(handles)
  const receipt = await take(
    store,
    envelopeOf([
      upsert("product", "a", { name: "X", unit_price: "ten" }),
      upsert("transaction", "b", { direction: "in", amount: "1.00", date: "2026-11-01" }),
      upsert(
        "deal",
        "c",
        { title: "T", pipeline: "p", stage: "s" },
        {
          relations: [{ role: "organization", type: "person", external_id: "x" }],
        },
      ),
      upsert(
        "invoice",
        "d",
        { direction: "receivable", currency: "EUR", lines: [] },
        {
          relations: [{ role: "counterparty", type: "organization", external_id: "x", as: "customer" }],
        },
      ),
      upsert("organization", "e", { name: "Gmail fan", identifiers: [{ scheme: "domain", value: "gmail.com" }] }),
      upsert("person", "f", { name: "Nobody", phone: "12" }),
      upsert(
        "custom:note",
        "g",
        { text: "ok" },
        { relations: [{ role: "about", ref: "deal:1", type: "deal" } as never] },
      ),
      { key: "h", type: "task", external_id: "1", operation: "upsert", fields: {} },
      upsert(
        "contract",
        "i",
        { name: "C", kind: "nda" },
        {
          relations: [
            { role: "deal", type: "deal", external_id: "a" },
            { role: "deal", type: "deal", external_id: "b" },
          ],
        },
      ),
    ]),
  )
  expect(receipt.refused).toBe(9)
  expect(receipt.errors.map(({ pointer, code }) => `${pointer} ${code}`)).toEqual([
    "/records/0/fields/unit_price record.invalid",
    "/records/1/relations record.invalid",
    "/records/2/relations/0 record.invalid",
    "/records/3/relations/0/as record.invalid",
    "/records/4/fields/identifiers/0/value record.identifier",
    "/records/5/fields/phone/0 record.identifier",
    "/records/6/relations/0/ref record.invalid",
    "/records/7/type record.type",
    "/records/8/relations/1 record.relation-ambiguous",
  ])
})
