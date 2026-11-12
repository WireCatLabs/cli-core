import { afterEach, expect, it } from "vitest"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"
import type { SourceRecord } from "./index.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const client = upsert("organization", "c", { name: "Client" })
const invoice = upsert(
  "invoice",
  "i1",
  { direction: "receivable", currency: "RUB", lines: [{ description: "Rent", amount: "100.00" }] },
  { relations: [{ role: "counterparty", type: "organization", external_id: "c" }] },
)
const payment = upsert(
  "payment",
  "p1",
  { direction: "in", currency: "RUB", date: "2026-11-01", amount: "100.00" },
  { relations: [{ role: "settles", type: "invoice", external_id: "i1", amount: "100.00" }] },
)
const keyOf = (type: string, externalId: string) => ({
  provider: SOURCE.provider,
  account: SOURCE.account,
  type,
  externalId,
})
const idsOf = ({ items: records }: { items: { type: string; externalId: string }[] }) =>
  records.map(({ type, externalId }) => `${type} ${externalId}`)

it("lists one account's records by entity, batch and deletion", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, envelopeOf([client, invoice]))
  await take(store, envelopeOf([payment], { batch: "second" }))
  await take(store, envelopeOf([upsert("custom:note", "n", { text: "x" })], { batch: "second" }))
  await take(
    store,
    envelopeOf([{ key: "gone", type: "custom:note", external_id: "n", operation: "delete" }], { batch: "third" }),
  )
  const entity = (await store.records.get(keyOf("organization", "c")))?.entity as string

  expect(idsOf(await store.records.list({ ...SOURCE, entity }))).toEqual(["organization c"])
  expect(idsOf(await store.records.list({ ...SOURCE, batch: SOURCE.batch_id }))).toEqual([
    "invoice i1",
    "organization c",
  ])
  expect(idsOf(await store.records.list({ ...SOURCE, deleted: true }))).toEqual(["custom:note n"])
  expect((await store.records.list({ ...SOURCE, deleted: false })).items).toHaveLength(3)
  expect((await store.records.list(SOURCE)).items).toHaveLength(4)
  expect((await store.records.list({ ...SOURCE, batch: "second", type: "payment" })).items).toHaveLength(1)
  await expect(store.records.list({ ...SOURCE, entity: "organization:999" })).rejects.toMatchObject({
    code: "not_found",
  })
})

it("lists the relations pointing at a record, and at an entity by its ref or through its records", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, envelopeOf([client, invoice, payment]))
  const entity = (await store.records.get(keyOf("organization", "c")))?.entity as string
  await take(
    store,
    envelopeOf([upsert("custom:note", "n", { text: "x" }, { relations: [{ role: "about", ref: entity }] })], {
      account: "other",
    }),
    { account: "other" },
  )

  expect(await store.records.incoming(keyOf("invoice", "i1"))).toEqual([
    { record: keyOf("payment", "p1"), role: "settles", as: null, amount: "100.00" },
  ])
  const record = await store.records.get(keyOf("invoice", "i1"))
  expect(await store.records.incoming(record as SourceRecord)).toEqual(
    await store.records.incoming(keyOf("invoice", "i1")),
  )
  expect(await store.records.incoming({ entity })).toEqual([
    { record: keyOf("invoice", "i1"), role: "counterparty", as: null, amount: null },
    { record: { ...keyOf("custom:note", "n"), account: "other" }, role: "about", as: null, amount: null },
  ])
  expect(await store.records.incoming({ entity }, { limit: 1 })).toHaveLength(1)
  expect(await store.records.incoming(keyOf("invoice", "nothing"))).toEqual([])

  await take(store, envelopeOf([{ key: "gone", type: "payment", external_id: "p1", operation: "delete" }]))
  expect(await store.records.incoming(keyOf("invoice", "i1"))).toEqual([])
})
