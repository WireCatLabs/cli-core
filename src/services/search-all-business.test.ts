import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import type { AccountKey } from "../store/store.js"
import { envelopeOf, recordsFixture, type TestStore, take, upsert } from "../testing/records.js"
import { RESOURCES_SEARCHED, searchAll } from "./search-all.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const ME = { provider: "notes", account: "internal" }
const ALPHA = { provider: "sheet", account: "alpha" }
const BETA = { provider: "sheet", account: "beta" }
const org = (role: string, id = "c-1") => ({ role, type: "organization", external_id: id })

/** One record of each lane type, each found by "nimbus", and a transaction and a custom record that must not be. */
const ALPHA_RECORDS = [
  upsert("organization", "c-1", { name: "Nimbus Labs" }),
  upsert(
    "invoice",
    "i-1",
    { number: "INV-77", direction: "receivable", currency: "EUR", lines: [{ description: "Rent", amount: "10.00" }] },
    { relations: [org("counterparty")] },
  ),
  upsert(
    "payment",
    "pay-1",
    { direction: "in", amount: "10.00", currency: "EUR", date: "2026-11-01", reference: "wire 4410" },
    { relations: [org("payer")] },
  ),
  upsert("order", "o-1", {
    number: "PO-12",
    supplier_name: "Acme Supply",
    currency: "EUR",
    lines: [{ description: "Nimbus cables", quantity: "1", amount: "5.00" }],
  }),
  upsert(
    "contract",
    "k-1",
    { name: "Frame agreement", number: "NIMBUS-K1", kind: "service" },
    {
      relations: [org("party")],
    },
  ),
  upsert(
    "subscription",
    "sub-1",
    {
      name: "Nimbus hosting",
      direction: "payable",
      interval: "1-month",
      start_date: "2026-11-01",
      prices: [{ amount: "3.00", currency: "EUR" }],
    },
    { relations: [org("supplier")] },
  ),
  upsert("product", "sku-1", { name: "Router", sku: "NIMBUS-R1", kind: "product" }),
  upsert("wallet", "w-1", { name: "Main card", currency: "EUR", institution: "Nimbus Bank" }),
  upsert(
    "transaction",
    "t-1",
    { direction: "out", amount: "1.00", date: "2026-11-01", description: "Nimbus fee" },
    { relations: [{ role: "wallet", type: "wallet", external_id: "w-1" }] },
  ),
  upsert("custom:quote", "q-1", { title: "Nimbus quote" }),
]

const BETA_RECORDS = [
  upsert("organization", "c-1", { name: "Nimbus East" }),
  upsert(
    "invoice",
    "i-1",
    { number: "B-1", direction: "payable", currency: "EUR", lines: [{ description: "Cloud", amount: "2.00" }] },
    { relations: [org("counterparty")] },
  ),
]

const fixture = async (): Promise<TestStore> => (await withSql()).store

const withSql = async () => {
  const { store, sql } = await recordsFixture(handles)
  for (const [account, records] of [
    [ALPHA.account, ALPHA_RECORDS],
    [BETA.account, BETA_RECORDS],
  ] as const) {
    const receipt = await take(store, envelopeOf([...records], { provider: "sheet", account }), { account })
    expect(receipt).toMatchObject({ refused: 0, errors: [] })
  }
  await store.products.add({ by: "owner", name: "Nimbus switch" })
  return { store, sql: sql() }
}

/** A record of `account` that points at a row already there, as the owner's later mapping leaves it. */
const mapOnto = (database: DatabaseSync, account: string, ref: string) => {
  const [type, id] = ref.split(":")
  database
    .prepare(
      "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, entity_type, entity_id, " +
        "created_at, updated_at) SELECT id, ?, 'mapped', '{}', 'f', 'b', ?, ?, 9e12, 9e12 FROM accounts " +
        "WHERE provider = 'sheet' AND external_id = ?",
    )
    .run(type as string, type as string, Number(id), account)
}

const refOf = async (store: TestStore, type: string, externalId: string, account = ALPHA.account) =>
  (await store.records.get({ provider: "sheet", account, type, externalId }))?.entity as string

const business = (store: TestStore, text: string, within?: AccountKey[]) =>
  searchAll(store, ME, { text, limit: 50, only: ["business"], ...(within ? { scope: { business: within } } : {}) })

describe("search all, business lane", () => {
  it("is one of the lanes search all reads by default", () => {
    expect(RESOURCES_SEARCHED).toContain("business")
  })

  it("finds every lane type by its number or name, and neither transactions nor custom records", async () => {
    const store = await fixture()
    const found = await business(store, "nimbus")
    expect(found.searched).toEqual(["business"])
    expect(found.items.map(({ kind }) => kind).sort()).toEqual(
      ["contract", "invoice", "invoice", "order", "payment", "product", "product", "subscription", "wallet"].sort(),
    )
    expect(found.items.every(({ foundBy }) => foundBy.join() === "title")).toBe(true)
    expect(found.accounts).toEqual([
      { resource: "business", provider: "sheet", account: "alpha" },
      { resource: "business", provider: "sheet", account: "beta" },
      { resource: "business", provider: "business", account: "internal" },
    ])
  })

  it.each([
    ["INV-77", "invoice"],
    ["wire 4410", "payment"],
    ["PO-12", "order"],
    ["acme supply", "order"],
    ["cables", "order"],
    ["frame agreement", "contract"],
    ["nimbus-k1", "contract"],
    ["hosting", "subscription"],
    ["router", "product"],
    ["nimbus-r1", "product"],
    ["main card", "wallet"],
    ["nimbus bank", "wallet"],
  ])("finds %s in the %s it names", async (text, kind) => {
    const store = await fixture()
    const found = await business(store, `"${text}"`, [ALPHA])
    expect(found.items.map((hit) => hit.kind)).toEqual([kind])
  })

  it("finds an invoice and a payment by the name of the other side", async () => {
    const store = await fixture()
    const found = await business(store, '"nimbus labs"')
    expect(found.items.map(({ kind }) => kind).sort()).toEqual(["invoice", "payment"])
  })

  it("titles each hit as its ref reads elsewhere, with its review and the record it came from", async () => {
    const store = await fixture()
    const invoice = await refOf(store, "invoice", "i-1")
    const [hit] = (await business(store, "INV-77")).items
    expect(hit).toMatchObject({
      kind: "invoice",
      ref: invoice,
      provider: "sheet",
      account: "alpha",
      review: "proposed",
      sourceRecord: { provider: "sheet", account: "alpha", externalId: "i-1" },
      text: "INV-77 · Nimbus Labs",
    })
    expect(hit?.title).toBe((await store.refs.summaries([invoice])).get(invoice)?.title)
    expect(hit?.title).toContain("INV-77")
  })

  it("marks a proposal confirmed once the owner confirms it, and a product as confirmed", async () => {
    const store = await fixture()
    const invoice = await refOf(store, "invoice", "i-1")
    await store.finance.confirm(invoice, "owner")
    expect((await business(store, "INV-77")).items[0]).toMatchObject({ ref: invoice, review: "confirmed" })
    expect((await business(store, "router")).items[0]).toMatchObject({ kind: "product", review: "confirmed" })
  })

  it("leaves out what the owner rejected", async () => {
    const store = await fixture()
    const invoice = await refOf(store, "invoice", "i-1")
    await store.finance.reject(invoice, "owner")
    expect((await business(store, "INV-77")).items).toEqual([])
  })

  it("names the owner's own row as business:internal, with no source record", async () => {
    const store = await fixture()
    const [hit] = (await business(store, "switch")).items
    expect(hit).toMatchObject({ kind: "product", provider: "business", account: "internal", review: "confirmed" })
    expect(hit).not.toHaveProperty("sourceRecord")
  })

  it("reads only the accounts a scope names: two imports with the same external ids never cross", async () => {
    const store = await fixture()
    const alpha = await business(store, "nimbus", [ALPHA])
    expect(alpha.items.every(({ account }) => account === "alpha")).toBe(true)
    expect(alpha.items.map(({ ref }) => ref)).not.toContain(await refOf(store, "invoice", "i-1", BETA.account))
    expect(alpha.accounts).toEqual([{ resource: "business", provider: "sheet", account: "alpha" }])
    const beta = await business(store, "nimbus", [BETA])
    expect(
      beta.items.map((item) => [item.ref, item.kind === "meeting" ? undefined : item.sourceRecord?.account]),
    ).toEqual([[await refOf(store, "invoice", "i-1", BETA.account), "beta"]])
  })

  it("skips the lane with its reason when the query names a field a number or a name does not have", async () => {
    const store = await fixture()
    const found = await business(store, "from:anna nimbus")
    expect(found.searched).toEqual([])
    expect(found.skipped).toEqual([
      expect.objectContaining({
        resource: "business",
        code: "validation_error",
        reason: expect.stringMatching(/names/),
      }),
    ])
  })

  it("keeps a row in the account of its oldest live record: a record mapped onto it later never moves it", async () => {
    const { store, sql } = await withSql()
    const invoice = await refOf(store, "invoice", "i-1")
    mapOnto(sql, BETA.account, invoice)
    const refs = async (within?: AccountKey[]) => (await business(store, "INV-77", within)).items.map(({ ref }) => ref)
    expect(await refs([BETA])).toEqual([])
    expect(await refs([ALPHA])).toEqual([invoice])
    expect((await business(store, "INV-77")).items[0]).toMatchObject({ account: "alpha" })
  })

  it("falls back to a deleted record only when no live one is left; an all-deleted account is not listed", async () => {
    const { store } = await withSql()
    const remove = (account: string, type: string, externalId: string) =>
      take(
        store,
        envelopeOf([{ key: "d", type, external_id: externalId, operation: "delete" }], {
          provider: "sheet",
          account,
          batch: "b2",
        }),
        { account },
      )
    await remove(ALPHA.account, "invoice", "i-1")
    expect((await business(store, "INV-77", [ALPHA])).items[0]).toMatchObject({
      sourceRecord: { account: "alpha", externalId: "i-1" },
    })
    await remove(BETA.account, "invoice", "i-1")
    expect(await store.business.accounts()).toEqual([ALPHA])
  })

  it("tells an imported row from the owner's by the row's own source, not by the records pointing at it", async () => {
    const { store, sql } = await withSql()
    const invoice = await refOf(store, "invoice", "i-1")
    sql
      .prepare("UPDATE records SET entity_id = NULL, entity_type = NULL WHERE type = 'invoice' AND external_id = 'i-1'")
      .run()
    const [moved] = (await business(store, "INV-77")).items
    expect(moved).toMatchObject({ ref: invoice, provider: "sheet", account: "" })
    expect(moved).not.toHaveProperty("sourceRecord")
    expect((await business(store, "INV-77", [ALPHA])).items).toEqual([])
    const own = (await business(store, "switch")).items[0]?.ref as string
    mapOnto(sql, ALPHA.account, own)
    expect((await business(store, "switch")).items[0]).toMatchObject({ provider: "business", account: "internal" })
    expect((await business(store, "switch", [ALPHA])).items).toEqual([])
  })

  it("matches a word where a word starts, never inside one", async () => {
    const store = await fixture()
    expect((await business(store, "outer")).items).toEqual([])
    expect((await business(store, "rout")).items.map(({ kind }) => kind)).toEqual(["product"])
    expect((await business(store, "77")).items.map(({ kind }) => kind)).toEqual(["invoice"])
  })

  it("follows --source and account groups to the import accounts they name, whatever their provider", async () => {
    const store = await fixture()
    const search = (source: string) => searchAll(store, ME, { text: "nimbus", limit: 50, only: ["business"], source })
    const direct = await search("sheet:beta")
    expect(direct.items.map(({ account }) => account)).toEqual(["beta"])
    expect(direct.skipped).toEqual([])
    await store.accounts.saveAccountGroup("books", ["sheet:alpha"])
    const grouped = await search("group:books")
    expect(grouped.items.length).toBe(7)
    expect(grouped.items.every(({ account }) => account === "alpha")).toBe(true)
    expect(grouped.accounts).toEqual([{ resource: "business", provider: "sheet", account: "alpha" }])
  })
})
