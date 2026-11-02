import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type EnvelopeRecord, envelopeOfJsonl, RECORDS_ENVELOPE_SCHEMA } from "../domain/records.js"
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

const SOURCE = { provider: "sheet", account: "prokat-med", batch_id: "2026-11-02" }
const envelope = (records: EnvelopeRecord[], batch = SOURCE.batch_id) => ({
  schema_version: 1,
  source: { ...SOURCE, batch_id: batch },
  records,
})
const take = (store: Parameters<typeof ingest>[0], value: unknown, dryRun = false) =>
  ingest(store, value, { account: "prokat-med", dryRun })

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
  expect(await store.finance.payments({ review: "confirmed" })).toEqual([])
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

it("never links an organization by its name: the invoice waits until the owner maps the record", async () => {
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
  expect(receipt).toMatchObject({ created: 3, proposed: [] })
  expect(receipt.waiting).toEqual([
    { key: "invoice", pointer: "/records/1/relations", missing: ["counterparty"] },
    { key: "payment-п-2", pointer: "/records/2/relations", missing: ["settles"] },
  ])
  expect(await store.finance.invoices()).toEqual([])

  await store.records.map({ ...SOURCE, type: "organization", externalId: "клиент-7" }, romashka.ref, "owner")
  const [invoice] = await store.finance.invoices()
  expect(invoice).toMatchObject({ review: "proposed", total: "50000.00", counterparty: { ref: romashka.ref } })
  const [paid] = await store.finance.payments()
  expect(await store.finance.payment(paid?.ref as string)).toMatchObject({
    review: "proposed",
    allocations: [expect.objectContaining({ invoice: invoice?.ref, amount: "30000.00" })],
  })
  await expect(
    store.records.map({ ...SOURCE, type: "organization", externalId: "клиент-7" }, romashka.ref, { bot: "codex" }),
  ).rejects.toMatchObject({ code: "permission_error" })
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
  const amounts = (await store.finance.payments()).map(({ amount, currency }) => `${amount} ${currency}`).sort()
  expect(amounts).toEqual(["1234567.89 RUB", "150000 JPY"])
})

it("deletes softly and flags the entity, refuses secrets and another account, and a dry run writes nothing", async () => {
  const { store } = await fixture()
  const dry = await take(store, envelope([payment("1", { amount: "10.00" })]), true)
  expect(dry).toMatchObject({ dryRun: true, created: 1, proposed: [expect.stringMatching(/^payment:/)] })
  expect(await store.finance.payments()).toEqual([])
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
