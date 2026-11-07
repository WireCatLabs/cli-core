import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("gives an older file the business tables, keeps its money as it was and refunds it net", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-57-")), "wirecat.db")
  const store = await openStore({ path })
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Пример" })
  const invoice = await store.finance.addInvoice({
    by: "owner",
    direction: "receivable",
    counterparty: client.ref,
    currency: "RUB",
    lines: [{ description: "Аренда", amount: "10000.00" }],
  })
  const payment = await store.finance.addPayment({
    by: "owner",
    direction: "in",
    payer: client.ref,
    amount: "10000.00",
    currency: "RUB",
    date: "2026-11-05",
    allocations: [{ invoice: invoice.ref, amount: "10000.00" }],
  })
  const order = await store.orders.add({
    by: "owner",
    purpose: "personal",
    supplierName: "Ozon",
    currency: "RUB",
    total: "1.00",
  })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 57)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('contracts', 'catalog_items')").get()).toBeUndefined()
  expect(old.prepare("SELECT 1 FROM pragma_table_info('payments') WHERE name = 'refund_of'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.orders.get(order.ref)).toMatchObject({ direction: "purchase", lines: [], total: "1.00" })
    expect(await upgraded.finance.invoice(invoice.ref)).toMatchObject({
      status: "paid",
      paid: "10000.00",
      contract: null,
    })
    await upgraded.finance.addPayment({
      by: "owner",
      direction: "out",
      payee: client.ref,
      amount: "10000.00",
      currency: "RUB",
      date: "2026-11-10",
      refundOf: payment.ref,
      allocations: [{ invoice: invoice.ref, amount: "10000.00" }],
    })
    expect(await upgraded.finance.invoice(invoice.ref)).toMatchObject({ status: "issued", paid: "0.00" })
    const wallet = await upgraded.wallets.add({ by: "owner", name: "Касса", currency: "RUB", kind: "cash" })
    expect(wallet.balance).toEqual({ amount: "0.00", currency: "RUB" })
  } finally {
    await upgraded.close()
  }
})
