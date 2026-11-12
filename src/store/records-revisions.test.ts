import { afterEach, expect, it } from "vitest"
import { recordFingerprint } from "../domain/records.js"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

it("keeps every fingerprint a v1 build stored, so an old file re-imports as unchanged", () => {
  // Written by the v1 code (cli-core 0.604.0) before refs and `as` existed.
  expect(recordFingerprint({ name: "ООО Ромашка" }, [])).toBe(
    "9639d35e48ac6ba8b5be1efc1880efd08a210b0ad55873bfca0670a48de7028e",
  )
  expect(
    recordFingerprint({ direction: "in", amount: "10.00", nested: { b: 1, a: [2, { z: 1, y: 2 }] } }, [
      { role: "payer", type: "organization", external_id: "c-1" },
      { role: "settles", type: "invoice", external_id: "i-2" },
    ]),
  ).toBe("2adf6e869e98d376320ca97ae49041d998172a2746bf45cbd4ee7ffd3391bf80")
  expect(
    recordFingerprint({ amount: "30000.00" }, [
      { role: "settles", type: "invoice", external_id: "i-1", amount: "13000.00" },
      { role: "settles", type: "invoice", external_id: "i-2" },
    ]),
  ).toBe("2d49134a1629c9ba1bf3ebb9e127f6a217d12dc8ebadaffb756837147bdd7e86")
  const plain = [{ role: "party", type: "organization", external_id: "c-1" }]
  expect(recordFingerprint({}, [{ ...plain[0], as: "customer" } as never])).not.toBe(recordFingerprint({}, plain))
  expect(recordFingerprint({}, [{ role: "party", ref: "organization:1" }])).not.toBe(
    recordFingerprint({}, [{ role: "party", type: "ref", external_id: "organization:1" }]),
  )
})

const customer = upsert("organization", "c-1", {
  name: "Client",
  identifiers: [{ scheme: "domain", value: "c.example" }],
})
const order = (quantity: string, revision: number) =>
  upsert(
    "order",
    "o-1",
    {
      number: "O-1",
      direction: "sale",
      currency: "EUR",
      lines: [{ description: "Bike", quantity, unit_price: "10.00" }],
    },
    { revision, relations: [{ role: "customer", type: "organization", external_id: "c-1" }] },
  )

it("re-proposes a changed order in place while it is the import's proposal, and only flags it once decided", async () => {
  const { store } = await recordsFixture(handles)
  const first = await take(store, envelopeOf([customer, order("1", 1)]))
  const [ref] = first.proposed
  expect((await store.orders.get(ref as string)).total).toBe("10.00")

  const again = await take(store, envelopeOf([order("3", 2)], { batch: "second" }))
  expect(again).toMatchObject({ updated: 1, proposed: [ref], flagged: [] })
  expect(await store.orders.get(ref as string)).toMatchObject({ review: "proposed", total: "30.00" })
  expect((await store.orders.list()).items).toHaveLength(1)

  await store.orders.confirm(ref as string, "owner")
  const late = await take(store, envelopeOf([order("5", 3)], { batch: "third" }))
  expect(late).toMatchObject({ updated: 1, proposed: [], flagged: [{ key: "order-o-1", entity: ref }] })
  expect(await store.orders.get(ref as string)).toMatchObject({ review: "confirmed", total: "30.00" })
})

it("keeps v1's rule for invoices: a change after projection is flagged, never re-proposed", async () => {
  const { store } = await recordsFixture(handles)
  const invoice = (amount: string) =>
    upsert(
      "invoice",
      "i-1",
      { direction: "receivable", currency: "EUR", lines: [{ description: "SEO", amount }] },
      { relations: [{ role: "counterparty", type: "organization", external_id: "c-1" }] },
    )
  const first = await take(store, envelopeOf([customer, invoice("10.00")]))
  const again = await take(store, envelopeOf([invoice("12.00")]))
  expect(again).toMatchObject({ updated: 1, proposed: [], flagged: [{ entity: first.proposed[0] }] })
  expect((await store.finance.invoice(first.proposed[0] as string)).total).toBe("10.00")
})

it("updates a direct row in place, and an import-made organization's name unless the owner renamed it", async () => {
  const { store, sql } = await recordsFixture(handles)
  const product = (price: string) => upsert("product", "sku", { name: "Bike", unit_price: price, currency: "EUR" })
  await take(store, envelopeOf([customer, product("10.00")]))
  const changed = await take(store, envelopeOf([product("12.00"), { ...customer, fields: { name: "Client Ltd" } }]))
  expect(changed).toMatchObject({ updated: 2, flagged: [] })
  const ref = (await store.records.get({ ...SOURCE, type: "product", externalId: "sku" }))?.entity as string
  expect((await store.products.get(ref)).unitPrice).toBe("12.00")
  const org = (await store.records.get({ ...SOURCE, type: "organization", externalId: "c-1" }))?.entity as string
  const nameOf = () =>
    sql()
      .prepare("SELECT name FROM organizations WHERE id = ?")
      .get(Number(org.split(":")[1]))?.name
  expect(nameOf()).toBe("Client Ltd")
  sql()
    .prepare("UPDATE organizations SET name = 'Our client' WHERE id = ?")
    .run(Number(org.split(":")[1]))
  await take(store, envelopeOf([{ ...customer, fields: { name: "Client GmbH" } }]))
  expect(nameOf()).toBe("Our client")
})

it("refuses a stale or missing revision, and a same revision with other content, at its pointer", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, envelopeOf([customer, order("1", 2)]))
  const stale = await take(
    store,
    envelopeOf([
      order("2", 1),
      { ...order("2", 2), key: "same" },
      { ...order("2", 2), key: "none", revision: undefined },
    ]),
  )
  expect(stale.errors.map(({ pointer, code }) => `${pointer} ${code}`)).toEqual([
    "/records/0/revision record.stale-revision",
    "/records/1/external_id record.duplicate",
    "/records/2/external_id record.duplicate",
  ])
  const alone = await take(store, envelopeOf([{ ...order("2", 2), key: "same" }]))
  expect(alone.errors).toEqual([
    expect.objectContaining({ pointer: "/records/0/revision", code: "record.stale-revision" }),
  ])
})

it("re-proposes a subscription with a new price, and a transaction with new splits, while the import owns them", async () => {
  const { store } = await recordsFixture(handles)
  const subscription = (prices: { amount: string; currency: string; effective_from?: string }[], revision: number) =>
    upsert(
      "subscription",
      "s-1",
      { name: "Hosting", direction: "payable", interval: "1-month", start_date: "2026-11-01", prices },
      { revision, relations: [{ role: "supplier", type: "organization", external_id: "c-1" }] },
    )
  const wallet = upsert("wallet", "w", { name: "Bank", currency: "EUR" })
  const transaction = (splits: { amount: string; category: string }[], revision: number) =>
    upsert(
      "transaction",
      "t-1",
      { direction: "out", amount: "50.00", date: "2026-11-02", splits },
      { revision, relations: [{ role: "wallet", type: "wallet", external_id: "w" }] },
    )
  const euro = { amount: "9.00", currency: "EUR" }
  const first = await take(
    store,
    envelopeOf([customer, wallet, subscription([euro], 1), transaction([{ amount: "50.00", category: "rent" }], 1)]),
  )
  expect(first.errors).toEqual([])
  const [sub, tx] = first.proposed as [string, string]
  const again = await take(
    store,
    envelopeOf([
      subscription([euro, { amount: "11.00", currency: "EUR", effective_from: "2027-01-01" }], 2),
      transaction(
        [
          { amount: "30.00", category: "rent" },
          { amount: "20.00", category: "fees" },
        ],
        2,
      ),
    ]),
  )
  expect(again.errors).toEqual([])
  expect(again).toMatchObject({ updated: 2, flagged: [] })
  expect(new Set(again.proposed)).toEqual(new Set([sub, tx]))
  expect((await store.subscriptions.get(sub)).prices.map((one) => `${one.effectiveFrom} ${one.amount}`)).toEqual([
    "2026-11-01 9.00",
    "2027-01-01 11.00",
  ])
  expect((await store.transactions.get(tx)).splits.map((one) => `${one.category} ${one.amount}`)).toEqual([
    "rent 30.00",
    "fees 20.00",
  ])
})
