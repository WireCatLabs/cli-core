import { afterEach, expect, it } from "vitest"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const remove = (type: string, externalId: string) => ({
  key: `gone-${externalId}`,
  type,
  external_id: externalId,
  operation: "delete",
})

it("deletes softly: the entity stays, a proposed or confirmed one is flagged, a rejected one is not", async () => {
  const { store } = await recordsFixture(handles)
  const client = upsert("organization", "c", { name: "Client" })
  const contract = (id: string) =>
    upsert("contract", id, { name: `K ${id}`, kind: "service", value: "100.00", currency: "EUR" })
  const product = upsert("product", "sku", { name: "Bike" })
  const made = await take(store, envelopeOf([client, contract("k1"), contract("k2"), contract("k3"), product]))
  const [k1, k2, k3] = made.proposed as [string, string, string]
  await store.contracts.confirm(k2, "owner")
  await store.contracts.reject(k3, "owner")

  const gone = await take(
    store,
    envelopeOf([
      remove("contract", "k1"),
      remove("contract", "k2"),
      remove("contract", "k3"),
      remove("product", "sku"),
    ]),
  )
  expect(gone.deleted).toBe(4)
  expect(gone.flagged.map(({ key, entity }) => `${key} ${entity}`)).toEqual([
    `gone-k1 ${k1}`,
    `gone-k2 ${k2}`,
    expect.stringMatching(/^gone-sku product:\d+$/),
  ])
  expect(await store.contracts.get(k1)).toMatchObject({ review: "proposed" })
  const record = await store.records.get({ ...SOURCE, type: "product", externalId: "sku" })
  expect(record).toMatchObject({ deletedAt: expect.any(String), flagged: true })
  expect(await store.products.get(record?.entity as string)).toMatchObject({ name: "Bike" })

  const again = await take(store, envelopeOf([remove("product", "sku")]))
  expect(again).toMatchObject({ unchanged: 1, deleted: 0 })
})
