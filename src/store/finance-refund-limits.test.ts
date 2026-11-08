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
  const path = join(mkdtempSync(join(tmpdir(), "refund-limits-")), "store.db")
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  const invoice = (amount = "100.00") =>
    store.finance.addInvoice({
      by: "owner",
      direction: "receivable",
      counterparty: client.ref,
      currency: "RUB",
      lines: [{ description: "Аренда", amount }],
    })
  const payment = (amount: string, extra: Record<string, unknown> = {}) =>
    store.finance.addPayment({ by: "owner", direction: "in", amount, currency: "RUB", date: "2026-11-05", ...extra })
  const refund = (of: string, amount: string, extra: Record<string, unknown> = {}) =>
    store.finance.addPayment({
      by: "owner",
      direction: "out",
      amount,
      currency: "RUB",
      date: "2026-11-10",
      refundOf: of,
      ...extra,
    })
  const raw = async () => {
    const database = await openCache(path)
    handles.push(database)
    return (sql: string, ...params: (string | number)[]) =>
      () =>
        database.prepare(sql).run(...params)
  }
  return { store, client, invoice, payment, refund, raw }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

/** Paid in full, refunded in full, then paid again: a refund's share is all that keeps it from being paid twice. */
const paidAgain = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const invoice = await f.invoice()
  const paid = await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  const back = await f.refund(paid.ref, "100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  return { invoice, paid, back }
}

it("never takes back a refund's share when that would pay the invoice twice, in code or in SQL", async () => {
  const f = await fixture()
  const { invoice, back } = await paidAgain(f)
  expect(await reasonOf(f.store.finance.unallocate({ payment: back.ref, invoice: invoice.ref, by: "owner" }))).toBe(
    "finance.over-invoice",
  )
  const sql = await f.raw()
  expect(sql("DELETE FROM payment_allocations WHERE payment_id = ?", Number(back.id))).toThrow(/beyond its total/)
  expect(sql("UPDATE payments SET deleted_at = 1 WHERE id = ?", Number(back.id))).toThrow(/beyond its total/)
  expect(sql("UPDATE payments SET review = 'rejected' WHERE id = ?", Number(back.id))).toThrow(/beyond its total/)
  expect(await reasonOf(f.store.finance.reject(back.ref, "owner"))).toBe("proposal.wrong-state")
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "100.00", status: "paid" })
})

it("takes nothing back from a void invoice", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  const back = await f.refund(paid.ref, "100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  await f.store.finance.voidInvoice(invoice.ref, "owner")
  expect(await reasonOf(f.store.finance.unallocate({ payment: back.ref, invoice: invoice.ref, by: "owner" }))).toBe(
    "finance.unallocate",
  )
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "0.00", status: "void" })
})

it("confirms two refunds of one share only while together they stay within it, in code or in SQL", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("200.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  const proposed = () =>
    f.refund(paid.ref, "100.00", { by: claude, allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  const [first, second] = [await proposed(), await proposed()]
  const sql = await f.raw()
  expect(
    sql("UPDATE payments SET review = 'confirmed' WHERE id IN (?, ?)", Number(first.id), Number(second.id)),
  ).toThrow(/more than its payment gave/)
  await f.store.finance.confirm(first.ref, "owner")
  expect(await reasonOf(f.store.finance.confirm(second.ref, "owner"))).toBe("finance.over-refund")
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "0.00", status: "issued" })
})

it("keeps a payment and its share at or above what its refunds take back", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  await f.refund(paid.ref, "60.00", { allocations: [{ invoice: invoice.ref, amount: "60.00" }] })
  const loose = await f.payment("100.00")
  await f.refund(loose.ref, "60.00")
  expect(await reasonOf(f.store.finance.unallocate({ payment: paid.ref, invoice: invoice.ref, by: "owner" }))).toBe(
    "finance.refunded",
  )
  const sql = await f.raw()
  expect(sql("UPDATE payment_allocations SET amount = 1000 WHERE payment_id = ?", Number(paid.id))).toThrow(
    /at or above its refunds/,
  )
  expect(sql("UPDATE payments SET amount = 1000 WHERE id = ?", Number(loose.id))).toThrow(/stays within it/)
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "40.00", status: "partly_paid" })
})

it("frees room for an import only by a confirmed refund, not a proposed one", async () => {
  const f = await fixture()
  const source = { provider: "sheet", account: "demo-rent", batch_id: "2026-11-12" }
  const take = (records: unknown[]) => ingest(f.store, { schema_version: 1, source, records }, { account: "demo-rent" })
  await take([
    {
      key: "client",
      type: "organization",
      external_id: "client",
      operation: "upsert",
      fields: { name: "ООО Ромашка" },
    },
  ])
  await f.store.records.map({ ...source, type: "organization", externalId: "client" }, f.client.ref, "owner")
  const imported = await take([
    {
      key: "inv",
      type: "invoice",
      external_id: "INV-1",
      operation: "upsert",
      fields: { direction: "receivable", currency: "RUB", lines: [{ description: "Аренда", amount: "100.00" }] },
      relations: [{ role: "counterparty", type: "organization", external_id: "client" }],
    },
  ])
  const invoice = imported.proposed[0] as string
  const paid = await f.payment("100.00", { allocations: [{ invoice, amount: "100.00" }] })
  await f.refund(paid.ref, "100.00", { by: claude, allocations: [{ invoice, amount: "100.00" }] })
  const again = await take([
    {
      key: "pay",
      type: "payment",
      external_id: "PA-1",
      operation: "upsert",
      fields: { direction: "in", amount: "100.00", currency: "RUB", date: "2026-11-12" },
      relations: [{ role: "settles", type: "invoice", external_id: "INV-1" }],
    },
  ])
  expect((await f.store.finance.payment(again.proposed[0] as string)).allocations).toEqual([])
})

it("keeps a payment a transaction records from changing or going, in code or in SQL", async () => {
  const f = await fixture()
  const wallet = await f.store.wallets.add({ by: "owner", name: "Счёт", currency: "RUB" })
  const proposed = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    amount: "100.00",
    currency: "RUB",
    date: "2026-11-05",
  })
  const line = await f.store.transactions.add({
    by: "owner",
    wallet: wallet.ref,
    direction: "in",
    amount: "100.00",
    statementDate: "2026-11-05",
    payment: proposed.ref,
  })
  expect(await reasonOf(f.store.finance.reject(proposed.ref, "owner"))).toBe("transaction.payment")
  const sql = await f.raw()
  expect(sql("UPDATE payments SET amount = 9999 WHERE id = ?", Number(proposed.id))).toThrow(/take the link back/)
  expect(sql("UPDATE payments SET deleted_at = 1 WHERE id = ?", Number(proposed.id))).toThrow(/take the link back/)
  await f.store.transactions.update(line.ref, { by: "owner", payment: null })
  expect(await f.store.finance.reject(proposed.ref, "owner")).toMatchObject({ review: "rejected" })
})

it("rejects a bot's invoice that was paid, refunded and paid again, letting its allocations go", async () => {
  const f = await fixture()
  const invoice = await f.store.finance.addInvoice({
    by: claude,
    direction: "receivable",
    counterparty: f.client.ref,
    currency: "RUB",
    lines: [{ description: "Аренда", amount: "100.00" }],
  })
  const paid = await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  await f.refund(paid.ref, "100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  expect(await f.store.finance.reject(invoice.ref, "owner")).toMatchObject({ review: "rejected", allocations: [] })
})

it("keeps a void invoice's allocations and a confirmed refund's share from being lowered, in SQL", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const paid = await f.payment("100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  const back = await f.refund(paid.ref, "100.00", { allocations: [{ invoice: invoice.ref, amount: "100.00" }] })
  await f.store.finance.voidInvoice(invoice.ref, "owner")
  const sql = await f.raw()
  expect(sql("DELETE FROM payment_allocations WHERE payment_id = ?", Number(back.id))).toThrow(/void invoice keeps/)
  expect(sql("DELETE FROM payment_allocations WHERE payment_id = ?", Number(paid.id))).toThrow(/payment_allocations/)
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ paid: "0.00", status: "void" })

  const g = await fixture()
  const { invoice: again, back: share } = await paidAgain(g)
  const raw = await g.raw()
  expect(raw("UPDATE payment_allocations SET amount = 100 WHERE payment_id = ?", Number(share.id))).toThrow(
    /payment_allocations/,
  )
  expect(await g.store.finance.invoice(again.ref)).toMatchObject({ paid: "100.00", status: "paid" })
})
