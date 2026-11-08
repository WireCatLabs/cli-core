import { afterEach, expect, it } from "vitest"
import { recordFingerprint } from "../domain/records.js"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

/** A person the store already has, known by an e-mail or a phone identity, as mail and messengers write them. */
const knownPerson = (sql: Awaited<ReturnType<typeof recordsFixture>>["sql"], name: string) => {
  const db = sql()
  const person = Number(
    db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES (?, 1, 1) RETURNING id").get(name)?.id,
  )
  const give = (provider: string, externalId: string) => {
    const identity = Number(
      db
        .prepare(
          "INSERT INTO identities (provider, external_id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1) RETURNING id",
        )
        .get(provider, externalId, name, provider === "email" ? externalId : null)?.id,
    )
    db.prepare(
      "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
        "VALUES (?, ?, 'initial', 1, 1, 'ingest', 1)",
    ).run(identity, person)
  }
  return { ref: `person:${person}`, give }
}

it("links a person by one exact e-mail, in any letter case, and adds nothing to the person it linked", async () => {
  const { store, sql } = await recordsFixture(handles)
  const anna = knownPerson(sql, "Анна")
  anna.give("email", "anna@example.com")
  const receipt = await take(
    store,
    envelopeOf([
      upsert("person", "p-1", { name: "A. Obraztsova", email: [" Anna@Example.com ", "other@example.com"] }),
    ]),
  )
  expect(receipt).toMatchObject({ created: 1, unmatched: [] })
  expect(await store.records.get({ ...SOURCE, type: "person", externalId: "p-1" })).toMatchObject({
    entity: anna.ref,
    createdEntity: false,
  })
  const added = sql().prepare("SELECT count(*) AS n FROM identities WHERE external_id = 'other@example.com'").get()
  expect(added?.n).toBe(0)
})

it("links a person by one exact phone, read to E.164 as the phone_countries setting reads it", async () => {
  const { store, sql } = await recordsFixture(handles)
  const ivan = knownPerson(sql, "Иван")
  ivan.give("phone", "+79000000001")
  await take(store, envelopeOf([upsert("person", "p-2", { name: "Иван", phone: "8 (900) 000-00-01" })]))
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "p-2" }))?.entity).toBe(ivan.ref)
})

it("leaves a person whose identifiers name two people unmatched, with both as candidates", async () => {
  const { store, sql } = await recordsFixture(handles)
  const one = knownPerson(sql, "One")
  one.give("email", "shared@example.com")
  const two = knownPerson(sql, "Two")
  two.give("phone", "+79000000002")
  const receipt = await take(
    store,
    envelopeOf([upsert("person", "p-3", { name: "Both", email: "shared@example.com", phone: "+7 900 000 00 02" })]),
  )
  expect(receipt.unmatched).toEqual([
    {
      key: "person-p-3",
      pointer: "/records/0/fields",
      reason: "record.ambiguous",
      candidates: [one.ref, two.ref],
    },
  ])
  expect(receipt.waiting).toEqual([])
  expect(await store.records.list({ ...SOURCE, unmatched: true })).toEqual([
    expect.objectContaining({ externalId: "p-3", entity: null }),
  ])
})

it("makes a person, an organization and a project nobody matches, with their identifiers, once", async () => {
  const { store, sql } = await recordsFixture(handles)
  const records = [
    upsert("person", "p-4", { name: "Новый", email: "new@example.com", phone: "+34 600 000 001" }),
    upsert("organization", "c-4", {
      name: "Пример",
      identifiers: [
        { scheme: "tax-id:ru", value: "7700000000" },
        { scheme: "domain", value: "WWW.Primer.Example" },
      ],
    }),
    upsert("project", "pr-4", { name: "Rental fleet", key: "flt" }),
  ]
  const first = await take(store, envelopeOf(records))
  expect(first).toMatchObject({ created: 3, errors: [] })
  const person = await store.records.get({ ...SOURCE, type: "person", externalId: "p-4" })
  expect(person).toMatchObject({ createdEntity: true })
  const identities = sql()
    .prepare(
      "SELECT i.provider, i.external_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE l.person_id = ? ORDER BY i.provider",
    )
    .all(Number(person?.entity?.split(":")[1]))
  expect(identities).toEqual([
    { provider: "email", external_id: "new@example.com" },
    { provider: "phone", external_id: "+34600000001" },
    { provider: "sheet", external_id: "demo-rent/contact/p-4" },
  ])
  const organization = await store.records.get({ ...SOURCE, type: "organization", externalId: "c-4" })
  const schemes = sql()
    .prepare(
      "SELECT i.provider, i.external_id FROM organization_identities o JOIN identities i ON i.id = o.identity_id " +
        "WHERE o.organization_id = ? ORDER BY i.provider",
    )
    .all(Number(organization?.entity?.split(":")[1]))
  expect(schemes).toEqual([
    { provider: "domain", external_id: "primer.example" },
    { provider: "tax-id:ru", external_id: "7700000000" },
  ])
  const project = await store.records.get({ ...SOURCE, type: "project", externalId: "pr-4" })
  expect(
    sql()
      .prepare("SELECT key FROM projects WHERE id = ?")
      .get(Number(project?.entity?.split(":")[1])),
  ).toEqual({
    key: "FLT",
  })

  // Another account's record with the same tax id is that organization, not a second one.
  const other = await take(
    store,
    envelopeOf([upsert("organization", "x-9", { identifiers: [{ scheme: "tax-id:ru", value: "7700000000" }] })], {
      account: "erp",
    }),
    { account: "erp" },
  )
  expect(other.created).toBe(1)
  expect(await store.records.get({ ...SOURCE, account: "erp", type: "organization", externalId: "x-9" })).toMatchObject(
    {
      entity: organization?.entity,
      createdEntity: false,
    },
  )
})

it("matches or makes a person an earlier version left waiting, on its next import or by records.match", async () => {
  const { store, sql } = await recordsFixture(handles)
  const kept = knownPerson(sql, "Kept")
  kept.give("email", "kept@example.com")
  // Rows as a v1 build stored them: a person record with no entity, waiting for the owner's map.
  const v1 = (externalId: string, fields: Record<string, unknown>) => {
    const db = sql()
    db.prepare(
      "INSERT OR IGNORE INTO accounts (provider, external_id, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run(SOURCE.provider, SOURCE.account)
    db.prepare(
      "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, created_at, updated_at) " +
        "VALUES ((SELECT id FROM accounts WHERE provider = ? AND external_id = ?), 'person', ?, ?, ?, 'v1', 1, 1)",
    ).run(SOURCE.provider, SOURCE.account, externalId, JSON.stringify(fields), recordFingerprint(fields, []))
  }
  v1("old-1", { name: "Kept", email: "kept@example.com" })
  v1("old-2", { name: "Fresh" })

  const again = await take(store, envelopeOf([upsert("person", "old-1", { name: "Kept", email: "kept@example.com" })]))
  expect(again).toMatchObject({ unchanged: 1, created: 0 })
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "old-1" }))?.entity).toBe(kept.ref)

  const matched = await store.records.match({ provider: SOURCE.provider, account: SOURCE.account })
  expect(matched).toMatchObject({ linked: 0, created: 1, unmatched: [], errors: [] })
  expect(await store.records.get({ ...SOURCE, type: "person", externalId: "old-2" })).toMatchObject({
    createdEntity: true,
  })
})

it("lets the owner map an unmatched person, and projects what waited on it", async () => {
  const { store, sql } = await recordsFixture(handles)
  const one = knownPerson(sql, "One")
  one.give("email", "shared@example.com")
  knownPerson(sql, "Two").give("phone", "+79000000002")
  const receipt = await take(
    store,
    envelopeOf([
      upsert("person", "p-5", { name: "Both", email: "shared@example.com", phone: "89000000002" }),
      upsert(
        "payment",
        "pay-5",
        { direction: "in", amount: "10.00", currency: "EUR", date: "2026-11-01" },
        { relations: [{ role: "payer", type: "person", external_id: "p-5" }] },
      ),
    ]),
  )
  expect(receipt.unmatched).toHaveLength(1)
  expect(receipt.waiting).toEqual([{ key: "payment-pay-5", pointer: "/records/1/relations", missing: ["payer"] }])

  const mapped = await store.records.map({ ...SOURCE, type: "person", externalId: "p-5" }, one.ref, "owner")
  expect(mapped).toMatchObject({ entity: one.ref, createdEntity: false, unused: null })
  const [payment] = await store.finance.payments()
  expect(payment).toMatchObject({ review: "proposed", payer: { ref: one.ref } })
  await expect(
    store.records.map({ ...SOURCE, type: "person", externalId: "p-5" }, "person:999", "owner"),
  ).rejects.toMatchObject({ code: "not_found" })
})

it("remaps an import-made organization after the owner confirmed the invoice and payment that name it", async () => {
  const { store } = await recordsFixture(handles)
  const ours = await store.knowledge.addOrganization({ kind: "company", name: "Our client" })
  const first = await take(
    store,
    envelopeOf([
      upsert("organization", "c-6", { name: "Client" }),
      upsert(
        "invoice",
        "i-6",
        { direction: "receivable", currency: "EUR", lines: [{ description: "Rent", amount: "10.00" }] },
        { relations: [{ role: "counterparty", type: "organization", external_id: "c-6" }] },
      ),
      upsert(
        "payment",
        "pay-6",
        { direction: "in", amount: "10.00", currency: "EUR", date: "2026-11-01" },
        {
          relations: [
            { role: "payer", type: "organization", external_id: "c-6" },
            { role: "settles", type: "invoice", external_id: "i-6" },
          ],
        },
      ),
    ]),
  )
  const [invoice, payment] = first.proposed as [string, string]
  await store.finance.confirm(invoice, "owner")
  await store.finance.confirm(payment, "owner")
  const made = (await store.records.get({ ...SOURCE, type: "organization", externalId: "c-6" }))?.entity

  const mapped = await store.records.map({ ...SOURCE, type: "organization", externalId: "c-6" }, ours.ref, "owner")
  expect(mapped).toMatchObject({ entity: ours.ref, unused: made })
  expect(await store.finance.invoice(invoice)).toMatchObject({ review: "confirmed", counterparty: { ref: ours.ref } })
  expect(await store.finance.payment(payment)).toMatchObject({ review: "confirmed", payer: { ref: ours.ref } })
  await expect(
    store.records.map({ ...SOURCE, type: "organization", externalId: "c-6" }, made as string, "owner"),
  ).rejects.toMatchObject({ details: { reason: "record.mapped" } })
})
