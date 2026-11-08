import { Readable } from "node:stream"
import { afterEach, expect, it } from "vitest"
import { envelopeOfText } from "../domain/records.js"
import { ingest, ingestLines, jsonlLines } from "../services/ingest.js"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"
import { orphanPointers } from "./sqlite/entity-types.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

type Sql = Awaited<ReturnType<typeof recordsFixture>>["sql"]

const knownPerson = (sql: Sql, name: string, email: string) => {
  const db = sql()
  const id = Number(
    db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES (?, 1, 1) RETURNING id").get(name)?.id,
  )
  const identity = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, name, email, created_at, updated_at) " +
          "VALUES ('email', ?, ?, ?, 1, 1) RETURNING id",
      )
      .get(email, name, email)?.id,
  )
  db.prepare(
    "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
      "VALUES (?, ?, 'initial', 1, 1, 'ingest', 1)",
  ).run(identity, id)
  return { ref: `person:${id}`, identity }
}

it("never takes back an allocation the owner made on an imported payment: the change is flagged instead", async () => {
  const { store } = await recordsFixture(handles)
  const org = await store.knowledge.addOrganization({ kind: "company", name: "Client" })
  const invoice = (description: string, amount: string) =>
    store.finance.addInvoice({
      by: "owner",
      direction: "receivable",
      counterparty: org.ref,
      currency: "EUR",
      lines: [{ description, amount }],
    })
  const [first, second] = [await invoice("x", "40.00"), await invoice("y", "60.00")]
  const pay = (amount: string | undefined, revision: number) =>
    upsert(
      "payment",
      "pay",
      { direction: "in", amount: "100.00", currency: "EUR", date: "2026-11-03" },
      {
        revision,
        relations: [
          { role: "payer", ref: org.ref },
          { role: "settles", ref: first.ref, ...(amount ? { amount } : {}) },
        ],
      },
    )
  const made = await take(store, envelopeOf([pay(undefined, 1)]))
  const ref = made.proposed[0] as string
  await store.finance.allocate({ payment: ref, invoice: second.ref, amount: "60.00", by: "owner" })
  const again = await take(store, envelopeOf([pay("40.00", 2)], { batch: "b2" }))
  expect(again.flagged).toEqual([expect.objectContaining({ entity: ref })])
  expect((await store.finance.payment(ref)).allocations.map((one) => one.invoice).sort()).toEqual(
    [first.ref, second.ref].sort(),
  )
})

it("never overwrites the owner's edit of an imported order or transaction: the change is flagged instead", async () => {
  const { store } = await recordsFixture(handles)
  const customer = upsert("organization", "c", { name: "Client" })
  const order = (quantity: string, revision: number) =>
    upsert(
      "order",
      "o",
      { direction: "sale", currency: "EUR", lines: [{ description: "Bike", quantity, unit_price: "10.00" }] },
      { revision, relations: [{ role: "customer", type: "organization", external_id: "c" }] },
    )
  const wallet = upsert("wallet", "w", { name: "Bank", currency: "EUR" })
  const transaction = (category: string, revision: number) =>
    upsert(
      "transaction",
      "t",
      { direction: "out", amount: "5.00", date: "2026-11-02", splits: [{ amount: "5.00", category }] },
      { revision, relations: [{ role: "wallet", type: "wallet", external_id: "w" }] },
    )
  const made = await take(store, envelopeOf([customer, wallet, order("1", 1), transaction("rent", 1)]))
  const [orderRef, transactionRef] = made.proposed as [string, string]
  await store.orders.addLine(orderRef, { description: "Helmet", amount: "5.00", by: "owner" })
  await store.transactions.removeSplit(transactionRef, { position: 1, by: "owner" })
  const again = await take(store, envelopeOf([order("3", 2), transaction("fees", 2)], { batch: "b2" }))
  expect(again.flagged.map((one) => one.entity).sort()).toEqual([orderRef, transactionRef].sort())
  expect((await store.orders.get(orderRef)).total).toBe("15.00")
  expect((await store.transactions.get(transactionRef)).splits).toEqual([])
})

it("refuses another read or write of the store while a dry run streams, and keeps nothing of the run", async () => {
  const { store, sql } = await recordsFixture(handles)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  async function* lines() {
    yield JSON.stringify({ schema_version: 1, source: SOURCE })
    yield JSON.stringify(upsert("organization", "o1", { name: "Dry" }))
    await gate
    yield JSON.stringify(upsert("organization", "o2", { name: "Dry 2" }))
  }
  const dry = ingestLines(store, lines(), { account: SOURCE.account, dryRun: true, chunk: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await expect(store.knowledge.addOrganization({ kind: "company", name: "Meanwhile" })).rejects.toMatchObject({
    code: "conflict",
    details: { reason: "store.dry-run" },
  })
  await expect(store.records.get({ ...SOURCE, type: "organization", externalId: "o1" })).rejects.toMatchObject({
    code: "conflict",
  })
  release()
  expect(await dry).toMatchObject({ dryRun: true, created: 2 })
  expect(sql().prepare("SELECT count(*) AS n FROM organizations").get()?.n).toBe(0)
  expect(await store.knowledge.addOrganization({ kind: "company", name: "After" })).toMatchObject({ name: "After" })
})

it("takes a source's role named like an object property as its own word", async () => {
  const { store } = await recordsFixture(handles)
  const receipt = await take(
    store,
    envelopeOf([
      upsert("organization", "o0", { name: "First" }),
      upsert(
        "organization",
        "x1",
        { name: "B" },
        {
          relations: [{ role: "constructor", type: "organization", external_id: "o0" }],
        },
      ),
      upsert(
        "invoice",
        "i1",
        { direction: "receivable", currency: "EUR", lines: [{ description: "a", amount: "1.00" }] },
        {
          relations: [
            { role: "counterparty", type: "organization", external_id: "o0" },
            { role: "constructor", type: "organization", external_id: "o0" },
          ],
        },
      ),
    ]),
  )
  expect(receipt).toMatchObject({ created: 3, errors: [] })
})

it("keeps two accounts' contacts apart when an account or an id holds a slash", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, envelopeOf([upsert("person", "b/contact/c", { name: "One" })], { account: "a" }), {
    account: "a",
  })
  await take(store, envelopeOf([upsert("person", "c", { name: "Two" })], { account: "a/contact/b" }), {
    account: "a/contact/b",
  })
  const one = await store.records.get({ provider: "sheet", account: "a", type: "person", externalId: "b/contact/c" })
  const two = await store.records.get({ provider: "sheet", account: "a/contact/b", type: "person", externalId: "c" })
  expect(two).toMatchObject({ createdEntity: true })
  expect(one?.entity).not.toBe(two?.entity)
})

it("reads v1 organization identifiers leniently: only a known scheme with text is an identifier", async () => {
  const { store, sql } = await recordsFixture(handles)
  const receipt = await take(
    store,
    envelopeOf([
      upsert("organization", "o1", { name: "A", identifiers: ["INN 7701", null, 5] }),
      upsert("organization", "o2", {
        name: "B",
        identifiers: [{ scheme: "telegram", value: "42" }, { scheme: "domain" }],
      }),
      upsert("organization", "o3", { name: "C", identifiers: { scheme: "domain", value: "c.example" } }),
    ]),
  )
  expect(receipt).toMatchObject({ created: 3, errors: [], unmatched: [] })
  expect(sql().prepare("SELECT count(*) AS n FROM identities").get()?.n).toBe(0)
})

it("keeps an organization's e-mail apart from a person's: it neither takes nor is taken for one", async () => {
  const { store, sql } = await recordsFixture(handles)
  const anna = knownPerson(sql, "Anna", "anna@example.com")
  await take(
    store,
    envelopeOf([
      upsert("organization", "o1", { name: "Acme", identifiers: [{ scheme: "email", value: "Anna@Example.com" }] }),
    ]),
  )
  const rows = sql()
    .prepare("SELECT i.id, i.provider FROM organization_identities o JOIN identities i ON i.id = o.identity_id")
    .all()
  expect(rows).toEqual([{ id: expect.any(Number), provider: "org-email" }])
  expect(rows[0]?.id).not.toBe(anna.identity)
  await take(store, envelopeOf([upsert("person", "p9", { name: "Anna", email: "anna@example.com" })]))
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "p9" }))?.entity).toBe(anna.ref)
})

it("matches e-mails folded in any script, through indexes", async () => {
  const { store, sql } = await recordsFixture(handles)
  const ivan = knownPerson(sql, "Иван", "иван@пример.рф")
  await take(store, envelopeOf([upsert("person", "p1", { email: "ИВАН@Пример.РФ" })]))
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "p1" }))?.entity).toBe(ivan.ref)
  const plan = sql()
    .prepare(
      "EXPLAIN QUERY PLAN SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider = 'email' AND i.external_id = ? UNION " +
        "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id WHERE i.email = ?",
    )
    .all("a", "a")
    .map((row) => String(row.detail))
  expect(plan.filter((step) => step.includes(" i ")).every((step) => step.startsWith("SEARCH"))).toBe(true)
})

it("moves every record linked to an import-made person with it, so the made one is answered unused", async () => {
  const { store, sql } = await recordsFixture(handles)
  const real = knownPerson(sql, "Real Anna", "real@example.com")
  await take(
    store,
    envelopeOf([
      upsert("person", "p1", { name: "Anna", email: "anna@example.com" }),
      upsert("person", "p2", { name: "Anna B", email: "anna@example.com" }),
    ]),
  )
  const made = (await store.records.get({ ...SOURCE, type: "person", externalId: "p1" }))?.entity
  const mapped = await store.records.map({ ...SOURCE, type: "person", externalId: "p1" }, real.ref, "owner")
  expect(mapped).toMatchObject({ entity: real.ref, unused: made })
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "p2" }))?.entity).toBe(real.ref)
})

it("flags a changed person record that names another person's e-mail, and says whose", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, envelopeOf([upsert("person", "p1", { name: "Anna", email: "a@example.com" }, { revision: 1 })]))
  const bob = knownPerson(sql, "Bob", "bob@example.com")
  const changed = await take(
    store,
    envelopeOf([
      upsert("person", "p1", { name: "Anna", email: ["a@example.com", "bob@example.com"] }, { revision: 2 }),
    ]),
  )
  expect(changed.flagged).toEqual([
    expect.objectContaining({ key: "person-p1", reason: "record.ambiguous", candidates: [bob.ref] }),
  ])
  const links = sql().prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").all(bob.identity)
  expect(links).toEqual([{ person_id: Number(bob.ref.split(":")[1]) }])
})

it("reads a phone without + only in the envelope's phone_region, and reports one it could not read", async () => {
  const { store, sql } = await recordsFixture(handles)
  const db = sql()
  const russian = Number(
    db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES ('Ru', 1, 1) RETURNING id").get()?.id,
  )
  const identity = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, phone, created_at, updated_at) " +
          "VALUES ('phone', '+74155550100', '+74155550100', 1, 1) RETURNING id",
      )
      .get()?.id,
  )
  db.prepare(
    "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
      "VALUES (?, ?, 'initial', 1, 1, 'ingest', 1)",
  ).run(identity, russian)
  const phones = (externalId: string) =>
    sql()
      .prepare(
        "SELECT i.external_id FROM identities i JOIN identity_links l ON l.identity_id = i.id JOIN records r " +
          "ON r.entity_id = l.person_id AND r.entity_type = 'person' WHERE i.provider = 'phone' AND r.external_id = ?",
      )
      .all(externalId)
      .map((row) => row.external_id)
  const bare = await take(
    store,
    envelopeOf([
      upsert("person", "us", { name: "US", phone: "4155550100" }),
      upsert("person", "intl", { phone: ["+1 415 555 0100", "8 900 000-00-01"] }),
    ]),
  )
  expect(bare.ignored).toEqual([
    { key: "person-us", pointer: "/records/0/fields/phone", reason: "record.phone-region" },
    { key: "person-intl", pointer: "/records/1/fields/phone/1", reason: "record.phone-region" },
  ])
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "us" }))?.entity).not.toBe(
    `person:${russian}`,
  )
  expect(phones("us")).toEqual([])
  expect(phones("intl")).toEqual(["+14155550100"])
  const regional = await take(
    store,
    envelopeOf([upsert("person", "es", { phone: "600 000 001" })], { options: { phone_region: "ES" } }),
  )
  expect(regional).toMatchObject({ errors: [], ignored: [] })
  expect(phones("es")).toEqual(["+34600000001"])
  const odd = await take(store, envelopeOf([], { options: { phone_region: "xx" } }))
  expect(odd.errors).toEqual([expect.objectContaining({ pointer: "/options/phone_region", code: "envelope.invalid" })])
  const plan = sql()
    .prepare(
      "EXPLAIN QUERY PLAN SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider = 'phone' AND i.external_id = ? UNION " +
        "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id WHERE i.phone IN (?, ?)",
    )
    .all("a", "a", "a")
    .map((row) => String(row.detail))
  expect(plan).toContainEqual(expect.stringContaining("identities_by_phone"))
  expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false)
})

it("reads a file that starts with a byte-order mark, as JSONL and as JSON", async () => {
  const { store } = await recordsFixture(handles)
  const header = JSON.stringify({ schema_version: 1, source: SOURCE })
  const record = JSON.stringify(upsert("organization", "o1", { name: "X" }))
  const streamed = await ingestLines(store, jsonlLines(Readable.from([`﻿${header}\n${record}\n`])), {
    account: SOURCE.account,
  })
  expect(streamed).toMatchObject({ created: 1, errors: [] })
  const whole = `﻿${JSON.stringify(envelopeOf([upsert("organization", "o2", { name: "Y" })]))}`
  expect(await take(store, envelopeOfText(whole))).toMatchObject({ created: 1, errors: [] })
  expect(await take(store, envelopeOfText(`﻿${header}\n${record}`))).toMatchObject({ unchanged: 1 })
})

it("never reports a source record's relation as an orphan entity pointer", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(
    store,
    envelopeOf([upsert("custom:note", "n", { text: "x" }, { relations: [{ role: "about", ref: "organization:99" }] })]),
  )
  expect(orphanPointers(sql() as never).filter((one) => one.table === "record_relations")).toEqual([])
})

it("tells every refusal to onIssue for a JSON envelope too", async () => {
  const { store } = await recordsFixture(handles)
  const told: string[] = []
  await ingest(store, envelopeOf([{ key: "x" }, upsert("product", "p", { name: "P", unit_price: "ten" })]), {
    account: SOURCE.account,
    onIssue: (issue) => told.push(issue.pointer),
  })
  expect(told.sort()).toEqual(["/records/0/type", "/records/1/fields/unit_price"])
})

it("never links a person the owner separated from an identity the record brings", async () => {
  const { store, sql } = await recordsFixture(handles)
  const anna = knownPerson(sql, "Anna", "anna@example.com")
  const other = knownPerson(sql, "Other", "other@example.com")
  const db = sql()
  const phone = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES ('phone', '+79000000001', 1, 1) " +
          "RETURNING id",
      )
      .get()?.id,
  )
  db.prepare(
    "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
      "VALUES (?, ?, ?, 'manual', 1, 'owner')",
  ).run(phone, Number(anna.ref.split(":")[1]), Number(other.ref.split(":")[1]))
  const receipt = await take(
    store,
    envelopeOf([upsert("person", "p1", { email: "anna@example.com", phone: "+7 900 000-00-01" })]),
  )
  expect(receipt.unmatched).toEqual([expect.objectContaining({ reason: "record.separated", candidates: [anna.ref] })])
  expect((await store.records.get({ ...SOURCE, type: "person", externalId: "p1" }))?.entity).toBeNull()
})

it("refuses a Drizzle read during a dry run, and a write from onIssue fails instead of vanishing", async () => {
  const { store } = await recordsFixture(handles)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  async function* lines() {
    yield JSON.stringify({ schema_version: 1, source: SOURCE })
    yield JSON.stringify(upsert("organization", "o1", { name: "Dry" }))
    await gate
  }
  const dry = ingestLines(store, lines(), { account: SOURCE.account, dryRun: true, chunk: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await expect(store.vectors.vectorStatus({ provider: "telegram", account: "x" }, "1", "m")).rejects.toMatchObject({
    name: "CliError",
    code: "conflict",
    details: { reason: "store.dry-run" },
  })
  release()
  await dry

  let attempt: Promise<unknown> | undefined
  await ingest(store, envelopeOf([{ key: "x" }]), {
    account: SOURCE.account,
    dryRun: true,
    onIssue: () => {
      attempt = store.knowledge.addOrganization({ kind: "company", name: "From onIssue" })
    },
  })
  await expect(attempt).rejects.toMatchObject({ details: { reason: "store.dry-run" } })
  expect(await store.knowledge.addOrganization({ kind: "company", name: "After" })).toMatchObject({ name: "After" })
})

it("matches an imported company to the one mail already knows by its address, and the other way", async () => {
  const { store, sql } = await recordsFixture(handles)
  const db = sql()
  const known = await store.knowledge.addOrganization({ kind: "company", name: "Acme (from mail)" })
  const mail = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, email, created_at, updated_at) " +
          "VALUES ('email', 'billing@acme.example', 'billing@acme.example', 1, 1) RETURNING id",
      )
      .get()?.id,
  )
  db.prepare(
    "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
      "VALUES (?, ?, 'mail-finding', 'owner', 1, 1)",
  ).run(mail, Number(known.id))
  const email = (value: string) => ({ identifiers: [{ scheme: "email", value }] })
  await take(store, envelopeOf([upsert("organization", "o1", { name: "Acme", ...email("Billing@Acme.example") })]))
  expect(await store.records.get({ ...SOURCE, type: "organization", externalId: "o1" })).toMatchObject({
    entity: known.ref,
    createdEntity: false,
  })

  await take(store, envelopeOf([upsert("organization", "o2", { name: "Beta", ...email("hi@beta.example") })]))
  const made = (await store.records.get({ ...SOURCE, type: "organization", externalId: "o2" }))?.entity
  await take(store, envelopeOf([upsert("organization", "x9", email("hi@beta.example"))], { account: "erp" }), {
    account: "erp",
  })
  expect((await store.records.get({ ...SOURCE, account: "erp", type: "organization", externalId: "x9" }))?.entity).toBe(
    made,
  )
})

it("never gives an import-made person an identity the owner separated from it", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, envelopeOf([upsert("person", "p1", { name: "Anna", email: "anna@example.com" }, { revision: 1 })]))
  const made = Number((await store.records.get({ ...SOURCE, type: "person", externalId: "p1" }))?.entity?.split(":")[1])
  const other = knownPerson(sql, "Other", "other@example.com")
  const db = sql()
  const phone = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES ('phone', '+79000000005', 1, 1) " +
          "RETURNING id",
      )
      .get()?.id,
  )
  db.prepare(
    "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
      "VALUES (?, ?, ?, 'manual', 1, 'owner')",
  ).run(phone, made, Number(other.ref.split(":")[1]))
  await take(
    store,
    envelopeOf([
      upsert("person", "p1", { name: "Anna", email: "anna@example.com", phone: "+79000000005" }, { revision: 2 }),
    ]),
  )
  expect(sql().prepare("SELECT count(*) AS n FROM identity_links WHERE identity_id = ?").get(phone)?.n).toBe(0)
})
