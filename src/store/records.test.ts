import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type EnvelopeRecord, envelopeOfJsonl, RECORDS_ENVELOPE_SCHEMA, recordErrors } from "../domain/records.js"
import { ingest } from "../services/ingest.js"
import { proposalRegistry } from "../services/proposals/registry.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const fixture = async () => {
  let clock = Date.UTC(2026, 10, 2)
  const path = join(mkdtempSync(join(tmpdir(), "records-")), "store.db")
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const romashka = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  return { store, romashka }
}

const SOURCE = { provider: "sheet", account: "demo-rent", batch_id: "2026-11-02" }
const envelope = (records: EnvelopeRecord[], batch = SOURCE.batch_id) => ({
  schema_version: 1,
  source: { ...SOURCE, batch_id: batch },
  records,
})
const take = (store: Parameters<typeof ingest>[0], value: unknown, dryRun = false) =>
  ingest(store, value, { account: "demo-rent", dryRun })

const payment = (externalId: string, fields: Record<string, unknown>, extra: Partial<EnvelopeRecord> = {}) => ({
  key: `payment-${externalId}`,
  type: "payment",
  external_id: externalId,
  operation: "upsert" as const,
  fields: { direction: "in", currency: "RUB", date: "2026-11-01", ...fields },
  ...extra,
})

it("imports a payment once as a proposal, and the same import again writes nothing", async () => {
  const { store, romashka } = await fixture()
  const records = [payment("п-1", { amount: "50000.00", payer: romashka.ref, reference: "Аренда кровати" })]

  const first = await take(store, envelope(records))
  expect(first).toMatchObject({ created: 1, refused: 0, errors: [] })
  expect(first.proposed).toEqual([expect.stringMatching(/^payment:\d+$/)])

  const again = await take(store, envelope(records, "second"))
  expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1, proposed: [] })

  const row = await store.finance.payment(first.proposed[0] as string)
  expect(row).toMatchObject({ review: "proposed", amount: "50000.00", payer: { name: "ООО Ромашка" } })
  expect(row.author).toMatchObject({ type: "bot", name: "import" })
  expect((await store.finance.payments({ review: "confirmed" })).items).toEqual([])
  const inbox = await proposalRegistry(store).list({ kinds: ["payment"], limit: 10, offset: 0 })
  expect(inbox.items.map((item) => item.id)).toEqual(first.proposed)
  expect(await store.records.get({ ...SOURCE, type: "payment", externalId: "п-1" })).toMatchObject({
    entity: first.proposed[0],
    flagged: false,
    batchId: "2026-11-02",
  })
})

it("refuses a stale revision and keeps the newer one", async () => {
  const { store } = await fixture()
  await take(store, envelope([payment("1", { amount: "10.00" }, { revision: 5 })]))

  const stale = await take(store, envelope([payment("1", { amount: "99.00" }, { revision: 4 })]))
  expect(stale).toMatchObject({ refused: 1, updated: 0 })
  expect(stale.errors).toEqual([
    expect.objectContaining({ pointer: "/records/0/revision", code: "record.stale-revision", key: "payment-1" }),
  ])
  expect((await store.records.get({ ...SOURCE, type: "payment", externalId: "1" }))?.fields.amount).toBe("10.00")
})

it("never links an organization by its name: it makes one, which the owner may remap to his own", async () => {
  const { store, romashka } = await fixture()
  const records: EnvelopeRecord[] = [
    {
      key: "client",
      type: "organization",
      external_id: "клиент-7",
      operation: "upsert",
      fields: { name: "ООО Ромашка" },
    },
    {
      key: "invoice",
      type: "invoice",
      external_id: "счёт-42",
      operation: "upsert",
      fields: {
        direction: "receivable",
        number: "42",
        currency: "RUB",
        lines: [{ description: "Аренда кровати, ноябрь", quantity: "2", unit_price: "25000.00" }],
      },
      relations: [{ role: "counterparty", type: "organization", external_id: "клиент-7" }],
    },
    payment(
      "п-2",
      { amount: "30000.00" },
      { relations: [{ role: "settles", type: "invoice", external_id: "счёт-42" }] },
    ),
  ]

  const receipt = await take(store, envelope(records))
  expect(receipt).toMatchObject({ created: 3, waiting: [], unmatched: [] })
  const made = await store.records.get({ ...SOURCE, type: "organization", externalId: "клиент-7" })
  expect(made).toMatchObject({ createdEntity: true, entity: expect.stringMatching(/^organization:\d+$/) })
  expect(made?.entity).not.toBe(romashka.ref)
  const {
    items: [invoice],
  } = await store.finance.invoices()
  expect(invoice).toMatchObject({ review: "proposed", total: "50000.00", counterparty: { ref: made?.entity } })

  const remapped = await store.records.map(
    { ...SOURCE, type: "organization", externalId: "клиент-7" },
    romashka.ref,
    "owner",
  )
  expect(remapped).toMatchObject({ entity: romashka.ref, createdEntity: false, unused: made?.entity })
  expect(await store.finance.invoice(invoice?.ref as string)).toMatchObject({ counterparty: { ref: romashka.ref } })
  const {
    items: [paid],
  } = await store.finance.payments()
  expect(await store.finance.payment(paid?.ref as string)).toMatchObject({
    review: "proposed",
    allocations: [expect.objectContaining({ invoice: invoice?.ref, amount: "30000.00" })],
  })
  await expect(
    store.records.map({ ...SOURCE, type: "organization", externalId: "клиент-7" }, romashka.ref, { bot: "codex" }),
  ).rejects.toMatchObject({ code: "permission_error" })
})

const invoice = (externalId: string, total: string): EnvelopeRecord => ({
  key: `invoice-${externalId}`,
  type: "invoice",
  external_id: externalId,
  operation: "upsert",
  fields: {
    direction: "receivable",
    number: externalId,
    currency: "RUB",
    lines: [{ description: "SEO", amount: total }],
  },
  relations: [{ role: "counterparty", type: "organization", external_id: "client" }],
})
const settles = (externalId: string, amount?: string) => ({
  role: "settles",
  type: "invoice",
  external_id: externalId,
  ...(amount === undefined ? {} : { amount }),
})
const client: EnvelopeRecord = {
  key: "client",
  type: "organization",
  external_id: "client",
  operation: "upsert",
  fields: { name: "ООО Ромашка" },
}
const mapped = async () => {
  const f = await fixture()
  await take(f.store, envelope([client]))
  await f.store.records.map({ ...SOURCE, type: "organization", externalId: "client" }, f.romashka.ref, "owner")
  return f
}
const allocationsOf = async (store: Awaited<ReturnType<typeof openStore>>, externalId: string) => {
  const record = await store.records.get({ ...SOURCE, type: "payment", externalId })
  const { allocations } = await store.finance.payment(record?.entity as string)
  const numbers = new Map((await store.finance.invoices()).items.map((one) => [one.ref, one.number]))
  return allocations.map((one) => `${numbers.get(one.invoice)} ${one.amount}`).sort()
}

it("splits a payment across invoices by the amounts its relations give", async () => {
  const { store } = await mapped()
  const receipt = await take(
    store,
    envelope([
      invoice("SEO-03", "75000.00"),
      invoice("SEO-04A", "20000.00"),
      payment(
        "PA-14",
        { amount: "15000.00" },
        { relations: [settles("SEO-03", "13000.00"), settles("SEO-04A", "2000")] },
      ),
    ]),
  )
  expect(receipt).toMatchObject({ created: 3, refused: 0 })
  expect(await allocationsOf(store, "PA-14")).toEqual(["SEO-03 13000.00", "SEO-04A 2000.00"])
})

it("never lets one batch of proposed payments cover an invoice more than once", async () => {
  const { store } = await mapped()
  const amounts = ["35000.00", "2000.00", "25000.00", "15000.00"]
  const receipt = await take(
    store,
    envelope([
      invoice("SEO-03", "75000.00"),
      ...amounts.map((amount, at) => payment(`PA-${at}`, { amount }, { relations: [settles("SEO-03")] })),
    ]),
  )
  expect(receipt).toMatchObject({ created: 5, refused: 0 })
  expect(await allocationsOf(store, "PA-3")).toEqual(["SEO-03 13000.00"])
  const {
    items: [seo],
  } = await store.finance.invoices()
  const allocated = (await store.finance.invoice(seo?.ref as string)).allocations.map((one) => Number(one.amount))
  expect(allocated.reduce((sum, one) => sum + one, 0)).toBe(75000)
  for (const ref of receipt.proposed.filter((one) => one.startsWith("payment:")))
    await store.finance.confirm(ref, "owner")
  expect(await store.finance.invoice(seo?.ref as string)).toMatchObject({ status: "paid", open: "0.00" })
})

it("refuses settles amounts that add up to more than the payment, at the amount that goes past it", async () => {
  const { store } = await mapped()
  const receipt = await take(
    store,
    envelope([
      invoice("SEO-03", "75000.00"),
      payment(
        "PA-14",
        { amount: "15000.00" },
        { relations: [settles("SEO-03", "13000.00"), settles("SEO-03A", "2000.01")] },
      ),
    ]),
  )
  expect(receipt).toMatchObject({ created: 1, refused: 1 })
  expect(receipt.errors).toEqual([
    expect.objectContaining({
      pointer: "/records/1/relations/1/amount",
      code: "record.over-payment",
      key: "payment-PA-14",
    }),
  ])
  const other = await take(
    store,
    envelope([
      payment(
        "PA-15",
        { amount: "10.00" },
        { relations: [{ role: "payer", type: "organization", external_id: "client", amount: "1" }] },
      ),
    ]),
  )
  expect(other.errors).toEqual([
    expect.objectContaining({ pointer: "/records/0/relations/0/amount", code: "record.invalid" }),
  ])
})

it("takes a changed split again while the payment is proposed, and only flags it once the owner confirmed it", async () => {
  const { store } = await mapped()
  const invoices = [invoice("SEO-03", "75000.00"), invoice("SEO-04A", "20000.00")]
  await take(
    store,
    envelope([
      ...invoices,
      payment("PA-14", { amount: "15000.00" }, { relations: [settles("SEO-03"), settles("SEO-04A")] }),
    ]),
  )
  expect(await allocationsOf(store, "PA-14")).toEqual(["SEO-03 15000.00"])

  const split = (first: string, second: string) =>
    payment("PA-14", { amount: "15000.00" }, { relations: [settles("SEO-03", first), settles("SEO-04A", second)] })
  const again = await take(store, envelope([split("13000.00", "2000.00")], "second"))
  expect(again).toMatchObject({ updated: 1, refused: 0, flagged: [] })
  expect(await allocationsOf(store, "PA-14")).toEqual(["SEO-03 13000.00", "SEO-04A 2000.00"])
  const key = { ...SOURCE, type: "payment", externalId: "PA-14" }
  expect(await store.records.get(key)).toMatchObject({ flagged: false })

  await store.finance.confirm((await store.records.get(key))?.entity as string, "owner")
  const late = await take(store, envelope([split("10000.00", "5000.00")], "third"))
  expect(late.flagged).toEqual([expect.objectContaining({ key: "payment-PA-14" })])
  expect(await allocationsOf(store, "PA-14")).toEqual(["SEO-03 13000.00", "SEO-04A 2000.00"])
})

it("keeps minor units exact for RUB and JPY and refuses more decimals than the currency has", async () => {
  const { store } = await fixture()
  const receipt = await take(
    store,
    envelope([
      payment("rub", { amount: "1234567.89" }),
      payment("jpy", { amount: "150000", currency: "JPY" }),
      payment("jpy-cents", { amount: "1500.50", currency: "JPY" }),
    ]),
  )
  expect(receipt).toMatchObject({ created: 2, refused: 1 })
  expect(receipt.errors).toEqual([
    expect.objectContaining({ pointer: "/records/2/fields", code: "money.amount", key: "payment-jpy-cents" }),
  ])
  const amounts = (await store.finance.payments()).items.map(({ amount, currency }) => `${amount} ${currency}`).sort()
  expect(amounts).toEqual(["1234567.89 RUB", "150000 JPY"])
})

it("deletes softly and flags the entity, refuses secrets and another account, and a dry run writes nothing", async () => {
  const { store } = await fixture()
  const dry = await take(store, envelope([payment("1", { amount: "10.00" })]), true)
  expect(dry).toMatchObject({ dryRun: true, created: 1, proposed: [expect.stringMatching(/^payment:/)] })
  expect((await store.finance.payments()).items).toEqual([])
  expect(await store.records.get({ ...SOURCE, type: "payment", externalId: "1" })).toBeUndefined()

  const made = await take(store, envelope([payment("1", { amount: "10.00" })]))
  const gone = await take(store, envelope([{ key: "d", type: "payment", external_id: "1", operation: "delete" }]))
  expect(gone).toMatchObject({ deleted: 1, flagged: [{ key: "d", entity: made.proposed[0] }] })
  expect(await store.records.get({ ...SOURCE, type: "payment", externalId: "1" })).toMatchObject({
    flagged: true,
    deletedAt: expect.any(String),
  })
  expect(await store.finance.payment(made.proposed[0] as string)).toMatchObject({ review: "proposed" })

  const secret = await take(
    store,
    envelope([{ key: "s", type: "custom:login", external_id: "1", operation: "upsert", fields: { api_key: "x" } }]),
  )
  expect(secret.errors).toEqual([
    expect.objectContaining({ pointer: "/records/0/fields/api_key", code: "record.secret-field" }),
  ])
  const other = await ingest(store, envelope([]), { account: "someone-else" })
  expect(other.errors).toEqual([
    expect.objectContaining({ pointer: "/source/account", code: "envelope.account-mismatch" }),
  ])
})

it("takes a 100 000-line JSONL file in one go", async () => {
  const { store } = await fixture()
  const lines = [JSON.stringify({ schema_version: 1, source: SOURCE })]
  for (let n = 0; n < 100_000; n++)
    lines.push(
      JSON.stringify({
        key: `r${n}`,
        type: "custom:shipment",
        external_id: `отправка-${n}`,
        operation: "upsert",
        fields: { status: "в пути", weight: n % 50 },
      }),
    )
  const started = performance.now()
  const receipt = await take(store, envelopeOfJsonl(lines.join("\n")))
  expect(receipt).toMatchObject({ created: 100_000, refused: 0 })
  expect(performance.now() - started).toBeLessThan(60_000)
}, 120_000)

it("publishes the envelope's JSON Schema as written in the code", () => {
  const file = new URL("../../schemas/records-envelope.v1.schema.json", import.meta.url)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(RECORDS_ENVELOPE_SCHEMA)
})

it("refuses an invoice whose fields.payer is not text, though payer is a payment's role", async () => {
  const { store } = await mapped()
  const record = invoice("SEO-09", "1000.00")
  const result = await take(store, envelope([{ ...record, fields: { ...record.fields, payer: 5 } }]))
  expect(result.errors).toEqual([
    expect.objectContaining({ pointer: "/records/0/fields", code: "record.invalid", message: "fields.payer is text" }),
  ])
})

it("refuses unknown options, a relation with both a ref and a type, and `as` on a role that is no relationship", async () => {
  const { store } = await fixture()
  const odd = await take(store, { ...envelope([]), options: { lines: "pictures" } })
  expect(odd.errors).toEqual([expect.objectContaining({ pointer: "/options/lines", code: "envelope.invalid" })])
  const result = await take(
    store,
    envelope([
      payment("r-1", { amount: "1.00" }, { relations: [{ role: "payer", ref: "organization:1", type: "x" } as never] }),
      payment(
        "r-2",
        { amount: "1.00" },
        { relations: [{ role: "payer", ref: "organization:1", as: "boss" } as never] },
      ),
    ]),
  )
  expect(result.errors.map(({ pointer, code }) => `${pointer} ${code}`)).toEqual([
    "/records/0/relations/0/ref record.invalid",
    "/records/1/relations/0/as record.invalid",
  ])
})

it("still takes every record shape v1 kept, junk included, before the store sees it", () => {
  const kept = [
    payment("j-1", { amount: "1.00", payer: "organization:1", reference: "x".repeat(400), note: { any: [1] } }),
    invoice("j-2", "5.00"),
    { ...client, fields: { name: "x".repeat(500), email: "n/a", phone: "-", inn: 7700000000 } },
    {
      key: "p",
      type: "person",
      external_id: "p",
      operation: "upsert",
      fields: { name: 42, phone: "12", email: ["", 5] },
    },
    { key: "pr", type: "project", external_id: "pr", operation: "upsert", fields: { name: "", key: 7 } },
    { key: "c", type: "custom:row", external_id: "c", operation: "upsert", fields: { deep: { a: [{ b: null }] } } },
    { key: "d", type: "invoice", external_id: "d", operation: "delete" },
  ]
  expect(kept.flatMap((record, index) => recordErrors(record, index))).toEqual([])
})
