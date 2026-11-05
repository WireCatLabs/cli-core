import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { refLabel } from "../domain/ref-summaries.js"
import { proposalRegistry } from "../services/proposals/registry.js"
import type { InvoiceLineInput } from "./index.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the bank statement shows it" }

const fixture = async () => {
  let clock = Date.UTC(2026, 10, 2)
  const path = join(mkdtempSync(join(tmpdir(), "finance-")), "store.db")
  const store = await openStore({
    path,
    now: () => clock++,
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  handles.push(store)
  const project = await store.knowledge.addProject({ name: "Прокат", key: "PMED" })
  const romashka = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  const anna = await store.people.add({ name: "Анна Иванова" })
  const invoice = (
    lines: InvoiceLineInput[] = [{ description: "Аренда кровати, ноябрь", quantity: "2", unitPrice: "25000.00" }],
  ) =>
    store.finance.addInvoice({
      by: "owner",
      direction: "receivable",
      number: "42",
      counterparty: romashka.ref,
      project: project.ref,
      currency: "RUB",
      issueDate: "2026-11-01",
      dueDate: "2026-11-15",
      lines,
    })
  const payment = (amount: string, extra: Record<string, unknown> = {}) =>
    store.finance.addPayment({
      by: "owner",
      direction: "in",
      payer: romashka.ref,
      amount,
      currency: "RUB",
      date: "2026-11-14",
      project: project.ref,
      ...extra,
    })
  return { store, path, project, romashka, anna, invoice, payment, registry: proposalRegistry(store) }
}

it("confirms the owner's invoice at once, totals its lines and titles it with Cyrillic names", async () => {
  const f = await fixture()
  const invoice = await f.invoice([
    { description: "Аренда кровати, ноябрь", quantity: "2", unitPrice: "20000.00" },
    { description: "Доставка", amount: "10000" },
  ])
  expect(invoice).toMatchObject({
    total: "50000.00",
    paid: "0.00",
    open: "50000.00",
    status: "issued",
    review: "confirmed",
    source: "owner",
    counterparty: { ref: f.romashka.ref, name: "ООО Ромашка" },
    projectName: "Прокат",
    title: "Invoice 42 · 50 000.00 RUB to ООО Ромашка, due 15.11 (issued)",
    lines: [
      { position: 1, quantity: "2", unitPrice: "20000.00", amount: "40000.00" },
      { position: 2, quantity: "1", unitPrice: "10000.00", amount: "10000.00" },
    ],
  })
  const summary = (await f.store.refs.summaries([invoice.ref])).get(invoice.ref)
  expect(summary).toMatchObject({ kind: "invoice", in: "Прокат", state: "available" })
  expect(refLabel(summary as NonNullable<typeof summary>)).toBe(
    "Invoice «42 · 50 000.00 RUB to ООО Ромашка, due 15.11 (issued)» (Прокат)",
  )
})

it("refuses a total that is not the sum of the lines, and a line whose amount is not quantity × price", async () => {
  const f = await fixture()
  const base = {
    by: "owner" as const,
    direction: "payable" as const,
    counterparty: `person:${f.anna.uid}`,
    currency: "RUB",
  }
  await expect(
    f.store.finance.addInvoice({ ...base, total: "50000.00", lines: [{ description: "Услуги", amount: "49999.99" }] }),
  ).rejects.toMatchObject({ code: "validation_error", details: { reason: "finance.total" } })
  await expect(
    f.store.finance.addInvoice({
      ...base,
      lines: [{ description: "Часы", quantity: "1.5", unitPrice: "1000.00", amount: "1400.00" }],
    }),
  ).rejects.toMatchObject({ details: { reason: "finance.line-amount" } })
  expect(await f.store.finance.invoices()).toEqual([])
})

it("derives the status from confirmed allocations and keeps open totals per currency", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const first = await f.payment("20000.00")
  await f.store.finance.allocate({ payment: first.ref, invoice: invoice.ref, amount: "20000", by: "owner" })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({
    status: "partly_paid",
    paid: "20000.00",
    open: "30000.00",
  })
  expect(await f.store.finance.openTotals()).toEqual({
    receivable: [{ amount: "30000.00", currency: "RUB", invoices: 1 }],
    payable: [],
  })

  await f.payment("30000.00", { allocations: [{ invoice: invoice.ref, amount: "30000.00" }] })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "paid", open: "0.00" })
  expect(await f.store.finance.invoices({ open: true })).toEqual([])
  expect((await f.store.finance.invoices({ number: "42" })).map((one) => one.ref)).toEqual([invoice.ref])
  expect(await f.store.finance.invoices({ number: "4" })).toEqual([])
  expect((await f.store.finance.openTotals({ project: f.project.ref })).receivable).toEqual([])
  await expect(f.store.finance.voidInvoice(invoice.ref, "owner")).rejects.toMatchObject({
    details: { reason: "finance.status" },
  })
})

it("never allocates more than a payment, more than an invoice, or across currencies — in code and in the file", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const other = await f.invoice([{ description: "Залог", amount: "5000.00" }])
  const payment = await f.payment("10000.00")
  await f.store.finance.allocate({ payment: payment.ref, invoice: invoice.ref, amount: "6000.00", by: "owner" })
  await expect(
    f.store.finance.allocate({ payment: payment.ref, invoice: other.ref, amount: "4000.01", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "finance.over-payment" } })
  const big = await f.payment("90000.00")
  await expect(
    f.store.finance.allocate({ payment: big.ref, invoice: other.ref, amount: "5000.01", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "finance.over-invoice" } })
  const euros = await f.payment("100.00", { currency: "EUR" })
  await expect(
    f.store.finance.allocate({ payment: euros.ref, invoice: other.ref, amount: "1.00", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "finance.currency" } })
  expect(await f.store.finance.payment(payment.ref)).toMatchObject({ allocated: "6000.00", unallocated: "4000.00" })

  const database = await openCache(f.path)
  const insert = (paymentId: string, invoiceId: string, amount: number) =>
    database
      .prepare(
        "INSERT INTO payment_allocations (payment_id, invoice_id, amount, author_type, author_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'person', 1, 0, 0)",
      )
      .run(Number(paymentId), Number(invoiceId), amount)
  expect(() => insert(payment.id, other.id, 400_001)).toThrow(/payment_allocations/)
  expect(() => insert(euros.id, other.id, 100)).toThrow(/payment_allocations/)
  expect(() => database.prepare("UPDATE payments SET amount = 1 WHERE id = ?").run(Number(payment.id))).toThrow(
    /payments/,
  )
  database.close()
})

it("keeps exact minor units for RUB and JPY and refuses a currency it does not know", async () => {
  const f = await fixture()
  const yen = await f.store.finance.addInvoice({
    by: "owner",
    direction: "payable",
    counterparty: f.romashka.ref,
    currency: "jpy",
    lines: [{ description: "Licence", quantity: "3", unitPrice: "40000" }],
  })
  expect(yen).toMatchObject({ currency: "JPY", total: "120000", lines: [{ unitPrice: "40000", amount: "120000" }] })
  const kopecks = await f.payment("0.01")
  expect(kopecks).toMatchObject({ amount: "0.01", title: "Payment · 0.01 RUB from ООО Ромашка, 14.11" })
  const database = await openCache(f.path)
  expect(
    database.prepare("SELECT total, typeof(total) AS kind FROM invoices WHERE id = ?").get(Number(yen.id)),
  ).toEqual({ total: 120000, kind: "integer" })
  expect(database.prepare("SELECT amount FROM payments WHERE id = ?").get(Number(kopecks.id))).toEqual({ amount: 1 })
  database.close()

  await expect(f.payment("1.5", { currency: "JPY" })).rejects.toMatchObject({ details: { reason: "money.amount" } })
  await expect(f.payment("1.001")).rejects.toMatchObject({ details: { reason: "money.amount" } })
  await expect(f.payment("10", { currency: "XYZ" })).rejects.toMatchObject({ details: { reason: "money.currency" } })
  expect(await f.store.finance.openTotals()).toEqual({
    receivable: [],
    payable: [{ amount: "120000", currency: "JPY", invoices: 1 }],
  })
})

it("makes an agent's payment a proposal that counts only once the owner confirms it", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const proposed = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    payer: f.romashka.ref,
    amount: "50000.00",
    currency: "RUB",
    date: "2026-11-14",
    project: f.project.ref,
    reason: "Анна написала: оплатили счёт 42",
    allocations: [{ invoice: invoice.ref, amount: "50000.00" }],
  })
  expect(proposed).toMatchObject({ review: "proposed", source: "agent", confirmedBy: null, allocated: "50000.00" })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "issued", paid: "0.00" })

  const listed = await f.registry.list({ limit: 10, offset: 0, project: f.project.ref })
  expect(listed.items).toMatchObject([
    {
      id: proposed.ref,
      kind: "payment",
      status: "proposed",
      object: f.romashka.ref,
      summary: "Payment · 50 000.00 RUB from ООО Ромашка, 14.11 (proposed)",
      reason: "Анна написала: оплатили счёт 42",
      proposedBy: { type: "bot", name: "claude-code", kind: "agent" },
    },
  ])
  const own = await f.registry.decide([proposed.ref], { confirm: true, by: { ...claude, reason: "paid" } })
  expect(own.refused).toMatchObject([{ reason: "proposal.own" }])
  const other = await f.registry.decide([proposed.ref], { confirm: true, by: codex })
  expect(other.refused).toMatchObject([{ code: "permission_error", reason: "proposal.owner-only" }])
  await expect(f.store.finance.confirm(proposed.ref, codex)).rejects.toMatchObject({ code: "permission_error" })
  expect(await f.store.finance.payment(proposed.ref)).toMatchObject({ review: "proposed" })

  const decided = await f.registry.decide([proposed.ref], { confirm: true, by: "owner" })
  expect(decided.decided).toEqual([{ id: proposed.ref, kind: "payment", status: "confirmed", made: [proposed.ref] }])
  expect(await f.store.finance.payment(proposed.ref)).toMatchObject({
    review: "confirmed",
    confirmedBy: { type: "person" },
  })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "paid", paid: "50000.00" })
})

it("lets an agent allocate only from its own proposed payment, and drops a rejected payment's allocations", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const confirmed = await f.payment("50000.00")
  await expect(
    f.store.finance.allocate({ payment: confirmed.ref, invoice: invoice.ref, amount: "1.00", by: claude }),
  ).rejects.toMatchObject({ code: "permission_error", details: { reason: "finance.owner-only" } })
  await expect(f.store.finance.voidInvoice(invoice.ref, claude)).rejects.toMatchObject({ code: "permission_error" })

  const proposed = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    amount: "50000.00",
    currency: "RUB",
    date: "2026-11-14",
  })
  await f.store.finance.allocate({ payment: proposed.ref, invoice: invoice.ref, amount: "50000.00", by: claude })
  const rejected = await f.store.finance.reject(proposed.ref, "owner", "это залог, не оплата")
  expect(rejected).toMatchObject({ review: "rejected", allocations: [] })
  await f.store.finance.allocate({ payment: confirmed.ref, invoice: invoice.ref, amount: "50000.00", by: "owner" })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "paid" })
})

it("takes an allocation back from a proposed payment, the owner's or the bot's own", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const proposed = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    amount: "15000.00",
    currency: "RUB",
    date: "2026-11-14",
    allocations: [{ invoice: invoice.ref, amount: "15000.00" }],
  })
  await expect(
    f.store.finance.unallocate({ payment: proposed.ref, invoice: invoice.ref, by: codex }),
  ).rejects.toMatchObject({ code: "permission_error", details: { reason: "finance.owner-only" } })

  const back = await f.store.finance.unallocate({ payment: proposed.ref, invoice: invoice.ref, by: "owner" })
  expect(back).toMatchObject({ allocated: "0.00", allocations: [] })
  await expect(
    f.store.finance.unallocate({ payment: proposed.ref, invoice: invoice.ref, by: "owner" }),
  ).rejects.toMatchObject({ code: "not_found", details: { reason: "finance.not-allocated" } })
  await f.store.finance.allocate({ payment: proposed.ref, invoice: invoice.ref, amount: "13000.00", by: "owner" })
  expect(await f.store.finance.payment(proposed.ref)).toMatchObject({ allocated: "13000.00" })
})

it("lets only the owner move money between invoices of a confirmed payment, within both totals", async () => {
  const f = await fixture()
  const seo = await f.invoice([{ description: "SEO, октябрь", unitPrice: "23000.00" }])
  const support = await f.invoice([{ description: "Поддержка, октябрь", unitPrice: "12000.00" }])
  const paid = await f.payment("35000.00", {
    allocations: [
      { invoice: seo.ref, amount: "23000.00" },
      { invoice: support.ref, amount: "10000.00" },
    ],
  })
  await expect(
    f.store.finance.allocate({ payment: paid.ref, invoice: seo.ref, amount: "2000.00", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "finance.over-invoice" } })

  for (const by of [claude, codex])
    await expect(f.store.finance.unallocate({ payment: paid.ref, invoice: seo.ref, by })).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "finance.owner-only" },
    })

  const back = await f.store.finance.unallocate({ payment: paid.ref, invoice: seo.ref, by: "owner" })
  expect(back).toMatchObject({ review: "confirmed", allocated: "10000.00", unallocated: "25000.00" })
  expect(await f.store.finance.invoice(seo.ref)).toMatchObject({ status: "issued", paid: "0.00" })

  await f.store.finance.allocate({ payment: paid.ref, invoice: seo.ref, amount: "21000.00", by: "owner" })
  await f.store.finance.allocate({ payment: paid.ref, invoice: support.ref, amount: "2000.00", by: "owner" })
  expect(await f.store.finance.invoice(seo.ref)).toMatchObject({ status: "partly_paid", paid: "21000.00" })
  expect(await f.store.finance.invoice(support.ref)).toMatchObject({ status: "paid", paid: "12000.00" })
  await expect(
    f.store.finance.allocate({ payment: paid.ref, invoice: support.ref, amount: "0.01", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "finance.over-invoice" } })
})

it("keeps a draft unpaid until the owner issues it, and proposes an agent's invoice", async () => {
  const f = await fixture()
  const draft = await f.store.finance.addInvoice({
    by: "owner",
    direction: "receivable",
    counterparty: `person:${f.anna.uid}`,
    currency: "EUR",
    draft: true,
    lines: [{ description: "Consulting", quantity: "1.5", unitPrice: "100.01" }],
  })
  expect(draft).toMatchObject({ status: "draft", total: "150.02", lines: [{ quantity: "1.5" }] })
  const payment = await f.payment("150.02", { currency: "EUR" })
  await expect(
    f.store.finance.allocate({ payment: payment.ref, invoice: draft.ref, amount: "150.02", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "finance.allocate" } })
  await expect(f.store.finance.issueInvoice(draft.ref, claude)).rejects.toMatchObject({ code: "permission_error" })
  expect(await f.store.finance.issueInvoice(draft.ref, "owner")).toMatchObject({ status: "issued" })
  expect(await f.store.finance.openTotals()).toMatchObject({ receivable: [{ amount: "150.02", currency: "EUR" }] })

  const agents = await f.store.finance.addInvoice({
    by: claude,
    direction: "payable",
    counterparty: f.romashka.ref,
    currency: "RUB",
    lines: [{ description: "Ремонт", amount: "7000.00" }],
  })
  expect(agents).toMatchObject({ review: "proposed", status: "issued" })
  expect((await f.store.finance.openTotals()).payable).toEqual([])
  expect((await f.registry.list({ limit: 10, offset: 0, kinds: ["invoice"] })).items).toMatchObject([
    { id: agents.ref, kind: "invoice", summary: "Invoice #2 · 7 000.00 RUB from ООО Ромашка (issued, proposed)" },
  ])
  await f.registry.decide([agents.ref], { confirm: true, by: "owner" })
  expect((await f.store.finance.openTotals()).payable).toEqual([{ amount: "7000.00", currency: "RUB", invoices: 1 }])
})

it("never lets an agent's pending payment block the owner, and refuses to confirm it once the invoice is covered", async () => {
  const f = await fixture()
  const invoice = await f.invoice()
  const pending = await f.store.finance.addPayment({
    by: claude,
    direction: "in",
    payer: f.romashka.ref,
    amount: "50000.00",
    currency: "RUB",
    date: "2026-11-14",
    allocations: [{ invoice: invoice.ref, amount: "50000.00" }],
  })
  await expect(
    f.store.finance.allocate({ payment: pending.ref, invoice: invoice.ref, amount: "0.01", by: claude }),
  ).rejects.toMatchObject({ details: { reason: "finance.over-payment" } })

  const owners = await f.payment("50000.00", { allocations: [{ invoice: invoice.ref, amount: "50000.00" }] })
  expect(owners).toMatchObject({ review: "confirmed", allocated: "50000.00" })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "paid", paid: "50000.00" })

  const decided = await f.registry.decide([pending.ref], { confirm: true, by: "owner" })
  expect(decided.refused).toMatchObject([{ id: pending.ref, reason: "finance.over-invoice" }])
  expect(decided.refused[0]?.message).toContain(`${invoice.ref} is already covered by other payments`)
  await expect(f.store.finance.confirm(pending.ref, "owner")).rejects.toMatchObject({
    details: { reason: "finance.over-invoice" },
  })
  expect(await f.store.finance.payment(pending.ref)).toMatchObject({ review: "proposed", allocated: "50000.00" })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "paid", paid: "50000.00" })

  const database = await openCache(f.path)
  expect(() =>
    database.prepare("UPDATE payments SET review = 'confirmed' WHERE id = ?").run(Number(pending.id)),
  ).toThrow(/payments/)
  database.close()
})
