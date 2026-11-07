import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ingest } from "../services/ingest.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async () => {
  let clock = Date.UTC(2026, 10, 2)
  const path = join(mkdtempSync(join(tmpdir(), "refunds-")), "store.db")
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const romashka = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  const invoice = (amount = "10000.00", by: "owner" | typeof claude = "owner") =>
    store.finance.addInvoice({
      by,
      direction: "receivable",
      counterparty: romashka.ref,
      currency: "RUB",
      lines: [{ description: "Аренда, ноябрь", amount }],
    })
  const payment = (amount: string, extra: Record<string, unknown> = {}) =>
    store.finance.addPayment({
      by: "owner",
      direction: "in",
      payer: romashka.ref,
      amount,
      currency: "RUB",
      date: "2026-11-05",
      ...extra,
    })
  const refund = (of: string, amount: string, extra: Record<string, unknown> = {}) =>
    store.finance.addPayment({
      by: "owner",
      direction: "out",
      payee: romashka.ref,
      amount,
      currency: "RUB",
      date: "2026-11-10",
      refundOf: of,
      ...extra,
    })
  const raw = async () => {
    const database = await openCache(path)
    handles.push(database)
    return database
  }
  return { store, romashka, invoice, payment, refund, raw }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("counts paid net of refunds, so a fully refunded invoice is owed again and can be paid again", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("10000.00", { allocations: [{ invoice: invoice.ref, amount: "10000.00" }] })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "10000.00", status: "paid" })

  const back = await f.refund(paid.ref, "4000.00", { allocations: [{ invoice: invoice.ref, amount: "4000.00" }] })
  expect(back).toMatchObject({ refundOf: paid.ref, direction: "out", review: "confirmed" })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({
    paid: "6000.00",
    open: "4000.00",
    status: "partly_paid",
  })

  await f.refund(paid.ref, "6000.00", { allocations: [{ invoice: invoice.ref, amount: "6000.00" }] })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "0.00", status: "issued" })
  expect(await f.store.finance.openTotals()).toEqual({
    receivable: [{ amount: "10000.00", currency: "RUB", invoices: 1 }],
    payable: [],
  })

  await f.payment("10000.00", { allocations: [{ invoice: invoice.ref, amount: "10000.00" }] })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "10000.00", status: "paid" })
})

it("refuses a refund that goes the same way, is in another currency, refunds a refund or takes back too much", async () => {
  const f = await fixture()
  const paid = await f.payment("10000.00")
  expect(await reasonOf(f.refund(paid.ref, "100.00", { direction: "in" }))).toBe("finance.refund")
  expect(await reasonOf(f.refund(paid.ref, "100.00", { currency: "EUR" }))).toBe("finance.refund")
  const back = await f.refund(paid.ref, "7000.00")
  expect(await reasonOf(f.refund(back.ref, "100.00", { direction: "in" }))).toBe("finance.refund")
  expect(await reasonOf(f.refund(paid.ref, "3000.01"))).toBe("finance.over-refund")
  expect(await f.refund(paid.ref, "3000.00")).toMatchObject({ amount: "3000.00" })
})

it("gives a refund back only to an invoice its payment paid, and never more than that payment gave it", async () => {
  const f = await fixture()
  const [first, second] = [await f.invoice("6000.00"), await f.invoice("4000.00")]
  const paid = await f.payment("10000.00", {
    allocations: [
      { invoice: first.ref, amount: "6000.00" },
      { invoice: second.ref, amount: "4000.00" },
    ],
  })
  const other = await f.invoice("500.00")
  const back = await f.refund(paid.ref, "5000.00")
  expect(
    await reasonOf(f.store.finance.allocate({ payment: back.ref, invoice: other.ref, amount: "1.00", by: "owner" })),
  ).toBe("finance.refund")
  expect(
    await reasonOf(
      f.store.finance.allocate({ payment: back.ref, invoice: second.ref, amount: "4000.01", by: "owner" }),
    ),
  ).toBe("finance.over-refund")
  await f.store.finance.allocate({ payment: back.ref, invoice: second.ref, amount: "4000.00", by: "owner" })
  expect(await f.store.finance.invoice(second.ref)).toMatchObject({ paid: "0.00", status: "issued" })
  expect(await f.store.finance.invoice(first.ref)).toMatchObject({ paid: "6000.00", status: "paid" })
})

it("confirms a refund only after its payment, and keeps a refunded payment from being rejected", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const proposed = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    payer: f.romashka.ref,
    amount: "10000.00",
    currency: "RUB",
    date: "2026-11-05",
    allocations: [{ invoice: invoice.ref, amount: "10000.00" }],
  })
  const back = await f.store.finance.addPayment({
    by: claude,
    direction: "out",
    payee: f.romashka.ref,
    amount: "10000.00",
    currency: "RUB",
    date: "2026-11-10",
    refundOf: proposed.ref,
    allocations: [{ invoice: invoice.ref, amount: "10000.00" }],
  })
  expect(back.review).toBe("proposed")
  expect(await reasonOf(f.store.finance.confirm(back.ref, "owner"))).toBe("finance.refund")
  expect(await reasonOf(f.store.finance.reject(proposed.ref, "owner"))).toBe("finance.refunded")

  await f.store.finance.confirm(proposed.ref, "owner")
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "paid" })
  await f.store.finance.confirm(back.ref, "owner")
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "0.00", status: "issued" })
  expect(await reasonOf(f.store.finance.unallocate({ payment: proposed.ref, invoice: invoice.ref, by: "owner" }))).toBe(
    "finance.refunded",
  )
})

it("voids an invoice whose payment was refunded in full, and still refuses one that stays paid", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("10000.00", { allocations: [{ invoice: invoice.ref, amount: "10000.00" }] })
  await f.refund(paid.ref, "2500.00", { allocations: [{ invoice: invoice.ref, amount: "2500.00" }] })
  expect(await reasonOf(f.store.finance.voidInvoice(invoice.ref, "owner"))).toBe("finance.status")
  await f.refund(paid.ref, "7500.00", { allocations: [{ invoice: invoice.ref, amount: "7500.00" }] })
  expect(await f.store.finance.voidInvoice(invoice.ref, "owner")).toMatchObject({ status: "void", paid: "0.00" })
})

it("keeps a stray write from breaking the refund rules, as the code does", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("10000.00", { allocations: [{ invoice: invoice.ref, amount: "10000.00" }] })
  const back = await f.refund(paid.ref, "3000.00")
  const other = await f.invoice("100.00")
  const database = await f.raw()
  const [paidId, backId, invoiceId, otherId] = [Number(paid.id), Number(back.id), Number(invoice.id), Number(other.id)]
  const now = Date.UTC(2026, 10, 3)
  const insertPayment = (direction: string, currency: string, refundOf: number) =>
    database
      .prepare(
        "INSERT INTO payments (direction, amount, currency, payment_date, review, author_type, author_id, source, " +
          "created_at, updated_at, refund_of) VALUES (?, 100, ?, '2026-11-10', 'confirmed', 'person', 1, 'owner', ?, ?, ?)",
      )
      .run(direction, currency, now, now, refundOf)
  const allocate = (payment: number, invoiceId: number, amount: number) =>
    database
      .prepare(
        "INSERT INTO payment_allocations (payment_id, invoice_id, amount, author_type, author_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'person', 1, ?, ?)",
      )
      .run(payment, invoiceId, amount, now, now)

  expect(() => insertPayment("in", "RUB", paidId)).toThrow(/a refund goes the other way/)
  expect(() => insertPayment("out", "EUR", paidId)).toThrow(/a refund goes the other way/)
  expect(() => insertPayment("in", "RUB", backId)).toThrow(/a refund goes the other way/)
  expect(() => database.prepare("UPDATE payments SET amount = 1000001 WHERE id = ?").run(backId)).toThrow(
    /stays within it/,
  )
  expect(() => allocate(backId, otherId, 100)).toThrow(/the refunded share/)
  expect(() => allocate(backId, invoiceId, 300001)).toThrow(/payment_allocations/)
  expect(() => database.prepare("UPDATE payments SET review = 'rejected' WHERE id = ?").run(paidId)).toThrow(
    /a refunded payment is not rejected/,
  )
  allocate(backId, invoiceId, 300000)
  expect(() =>
    database.prepare("DELETE FROM payment_allocations WHERE payment_id = ? AND invoice_id = ?").run(paidId, invoiceId),
  ).toThrow(/take it back first/)
  expect(() => database.prepare("UPDATE invoices SET total = 699999 WHERE id = ?").run(invoiceId)).toThrow(
    /at or above what is paid/,
  )
  database.prepare("UPDATE invoices SET total = 700000 WHERE id = ?").run(invoiceId)
})

it("refuses at confirm a stray proposed refund whose payment is still proposed", async () => {
  const f = await fixture()
  const proposed = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    amount: "100.00",
    currency: "RUB",
    date: "2026-11-05",
  })
  const back = await f.store.finance.addPayment({
    by: claude,
    direction: "out",
    amount: "100.00",
    currency: "RUB",
    date: "2026-11-06",
    refundOf: proposed.ref,
  })
  const database = await f.raw()
  expect(() => database.prepare("UPDATE payments SET review = 'confirmed' WHERE id = ?").run(Number(back.id))).toThrow(
    /a refund before its payment/,
  )
})

it("gives an imported payment the room a confirmed refund freed on an invoice", async () => {
  const f = await fixture()
  const source = { provider: "sheet", account: "demo-rent", batch_id: "2026-11-12" }
  const take = (records: unknown[]) => ingest(f.store, { schema_version: 1, source, records }, { account: "demo-rent" })
  const client = {
    key: "client",
    type: "organization",
    external_id: "client",
    operation: "upsert",
    fields: { name: "ООО Ромашка" },
  }
  await take([client])
  await f.store.records.map({ ...source, type: "organization", externalId: "client" }, f.romashka.ref, "owner")
  const imported = await take([
    {
      key: "inv",
      type: "invoice",
      external_id: "INV-1",
      operation: "upsert",
      fields: { direction: "receivable", currency: "RUB", lines: [{ description: "Аренда", amount: "10000.00" }] },
      relations: [{ role: "counterparty", type: "organization", external_id: "client" }],
    },
  ])
  const invoice = imported.proposed[0] as string
  const paid = await f.payment("10000.00", { allocations: [{ invoice, amount: "10000.00" }] })
  await f.refund(paid.ref, "10000.00", { allocations: [{ invoice, amount: "10000.00" }] })
  const again = await take([
    {
      key: "pay",
      type: "payment",
      external_id: "PA-1",
      operation: "upsert",
      fields: { direction: "in", amount: "10000.00", currency: "RUB", date: "2026-11-12" },
      relations: [{ role: "settles", type: "invoice", external_id: "INV-1" }],
    },
  ])
  const payment = await f.store.finance.payment(again.proposed[0] as string)
  expect(payment.allocations).toEqual([expect.objectContaining({ invoice, amount: "10000.00" })])
})
