import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "invoice-lines-")), "store.db")
  let clock = Date.UTC(2026, 10, 2)
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Пример" })
  const rental = await store.products.add({
    by: "owner",
    kind: "service",
    name: "Bike rental, month",
    unitPrice: "10000.00",
    currency: "RUB",
  })
  const invoice = (by: "owner" | typeof claude, amount = "5000.00") =>
    store.finance.addInvoice({
      by,
      direction: "receivable",
      counterparty: client.ref,
      currency: "RUB",
      lines: [{ description: "Доставка", amount }],
    })
  return { store, client, rental, invoice }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("lets the owner change any invoice's lines and an agent only its own proposed one's, retotalling it", async () => {
  const f = await fixture()
  const mine = await f.invoice("owner")
  const grown = await f.store.finance.addInvoiceLine(mine.ref, { by: "owner", product: f.rental.ref, quantity: "2" })
  expect(grown).toMatchObject({
    total: "25000.00",
    open: "25000.00",
    lines: [
      { position: 1, amount: "5000.00" },
      {
        position: 2,
        description: "Bike rental, month",
        unitPrice: "10000.00",
        amount: "20000.00",
        product: f.rental.ref,
      },
    ],
  })
  expect(
    await reasonOf(f.store.finance.addInvoiceLine(mine.ref, { by: claude, amount: "1.00", description: "x" })),
  ).toBe("finance.owner-only")

  const proposed = await f.invoice(claude)
  await f.store.finance.addInvoiceLine(proposed.ref, { by: claude, description: "Шлем", amount: "700.00" })
  expect(await f.store.finance.removeInvoiceLine(proposed.ref, { by: claude, position: 1 })).toMatchObject({
    review: "proposed",
    total: "700.00",
    lines: [{ position: 2, amount: "700.00" }],
  })
  expect(await reasonOf(f.store.finance.removeInvoiceLine(proposed.ref, { by: "owner", position: 2 }))).toBe(
    "finance.line",
  )
  expect(await reasonOf(f.store.finance.removeInvoiceLine(proposed.ref, { by: "owner", position: 9 }))).toBe(
    "finance.no-line",
  )
  await f.store.finance.confirm(proposed.ref, "owner")
  expect(
    await reasonOf(f.store.finance.addInvoiceLine(proposed.ref, { by: claude, amount: "1.00", description: "x" })),
  ).toBe("finance.owner-only")
  expect((await f.store.finance.invoice(proposed.ref)).lines).toHaveLength(1)
})

it("refuses lines that would total less than confirmed payments settled", async () => {
  const f = await fixture()
  const invoice = await f.invoice("owner")
  await f.store.finance.addInvoiceLine(invoice.ref, { by: "owner", description: "Шлем", amount: "1000.00" })
  await f.store.finance.addPayment({
    by: "owner",
    direction: "in",
    payer: f.client.ref,
    amount: "5500.00",
    currency: "RUB",
    date: "2026-11-03",
    allocations: [{ invoice: invoice.ref, amount: "5500.00" }],
  })
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ status: "partly_paid", open: "500.00" })

  expect(await reasonOf(f.store.finance.removeInvoiceLine(invoice.ref, { by: "owner", position: 1 }))).toBe(
    "finance.below-paid",
  )
  expect(await f.store.finance.invoice(invoice.ref)).toMatchObject({ total: "6000.00", lines: [{}, {}] })
})

it("settles an invoice whose lines shrink to what is paid, and refuses a void one's lines", async () => {
  const f = await fixture()
  const invoice = await f.invoice("owner", "4000.00")
  await f.store.finance.addInvoiceLine(invoice.ref, { by: "owner", description: "Шлем", amount: "1000.00" })
  await f.store.finance.addPayment({
    by: "owner",
    direction: "in",
    payer: f.client.ref,
    amount: "4000.00",
    currency: "RUB",
    date: "2026-11-03",
    allocations: [{ invoice: invoice.ref, amount: "4000.00" }],
  })
  const paid = await f.store.finance.removeInvoiceLine(invoice.ref, { by: "owner", position: 2 })
  expect(paid).toMatchObject({ total: "4000.00", open: "0.00", status: "paid" })
  const reopened = await f.store.finance.addInvoiceLine(invoice.ref, {
    by: "owner",
    description: "Шлем",
    amount: "1.00",
  })
  expect(reopened).toMatchObject({ total: "4001.00", status: "partly_paid" })

  const other = await f.invoice("owner")
  await f.store.finance.voidInvoice(other.ref, "owner")
  expect(
    await reasonOf(f.store.finance.addInvoiceLine(other.ref, { by: "owner", description: "x", amount: "1.00" })),
  ).toBe("finance.status")
})
