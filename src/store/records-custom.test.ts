import { afterEach, expect, it } from "vitest"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const PIPELINE = upsert("pipeline", "sales", { name: "Sales", stages: [{ external_id: "new", name: "New" }] })
const DEAL = upsert("deal", "D-7", { title: "Rental fleet", pipeline: "sales", stage: "new" })

it("keeps a custom record's nested JSON as sent, and resolves its relation to a deal's record", async () => {
  const fields = {
    valid_until: "2026-11-30",
    options: [{ bikes: 12, insurance: { kind: "full", extras: [null, true, 1.5, "ключ"] } }],
    empty: {},
  }
  const quote = upsert("custom:quote", "Q-7", fields, {
    relations: [{ role: "quoted-for", type: "deal", external_id: "D-7" }],
  })
  const { store } = await recordsFixture(handles)
  const first = await take(store, envelopeOf([quote, PIPELINE, DEAL]))
  expect(first).toMatchObject({ created: 3, errors: [] })
  const stored = await store.records.get({ ...SOURCE, type: "custom:quote", externalId: "Q-7" })
  expect(stored).toMatchObject({ fields, entity: null })
  expect(stored?.relations).toEqual([
    { role: "quoted-for", type: "deal", externalId: "D-7", ref: null, as: null, amount: null, resolved: true },
  ])
  const reordered = { ...quote, fields: { empty: {}, options: fields.options, valid_until: fields.valid_until } }
  expect(await take(store, envelopeOf([reordered]))).toMatchObject({ unchanged: 1, updated: 0 })
})

it("writes an envelope's deal on the row CRM sync keeps for the same account: one deal, not two", async () => {
  const { store } = await recordsFixture(handles)
  const key = { provider: SOURCE.provider, account: SOURCE.account }
  await store.crm.savePipelines(key, "deal", [
    { externalId: "sales", name: "Sales", stages: [{ externalId: "new", name: "New", position: 1, outcome: "open" }] },
  ])
  await store.crm.saveItems(key, "deal", [{ externalId: "D-7", title: "From sync", pipeline: "sales", stage: "new" }])
  const synced = await store.crm.refOf(key, "deal", "D-7")

  const receipt = await take(
    store,
    envelopeOf([{ ...DEAL, fields: { ...DEAL.fields, amount: "5.00", currency: "EUR" } }]),
  )
  expect(receipt).toMatchObject({ created: 1, waiting: [], errors: [] })
  expect((await store.records.get({ ...SOURCE, type: "deal", externalId: "D-7" }))?.entity).toBe(synced)
  expect((await store.deals.list({ account: key })).items).toEqual([
    expect.objectContaining({ ref: synced, title: "Rental fleet", amount: "5.00" }),
  ])
})

it("names a store entity by a typed ref, and keeps the part a relationship gives it", async () => {
  const { store } = await recordsFixture(handles)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "Client" })
  const receipt = await take(
    store,
    envelopeOf([
      PIPELINE,
      upsert(
        "deal",
        "D-8",
        { title: "By ref", pipeline: "sales", stage: "new" },
        {
          relations: [{ role: "organization", ref: client.ref }],
        },
      ),
      upsert(
        "contract",
        "K-1",
        { name: "Frame", kind: "service" },
        {
          relations: [{ role: "party", ref: client.ref, as: "customer" }],
        },
      ),
    ]),
  )
  expect(receipt).toMatchObject({ created: 3, errors: [] })
  const deal = await store.records.get({ ...SOURCE, type: "deal", externalId: "D-8" })
  expect((await store.deals.get(deal?.entity as string)).organization?.ref).toBe(client.ref)
  expect((await store.records.get({ ...SOURCE, type: "contract", externalId: "K-1" }))?.relations).toEqual([
    {
      role: "party",
      type: "organization",
      externalId: null,
      ref: client.ref,
      as: "customer",
      amount: null,
      resolved: true,
    },
  ])
})
