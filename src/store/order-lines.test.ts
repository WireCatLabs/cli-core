import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { openCache } from "./open.js"
import { refSummariesOf } from "./sqlite/ref-summaries.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "order-lines-")), "store.db")
  let clock = Date.UTC(2026, 10, 2)
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Пример" })
  const rental = await store.products.add({
    by: "owner",
    kind: "service",
    name: "Bike rental, month",
    sku: "SKU-RENT",
    unit: "month",
    unitPrice: "10000.00",
    currency: "RUB",
  })
  return { store, path, client, rental }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("totals a sale's lines, copies the product's name and price, and makes the owner its supplier", async () => {
  const f = await fixture()
  const order = await f.store.orders.add({
    by: "owner",
    direction: "sale",
    purpose: "business",
    customer: f.client.ref,
    number: "O-55",
    currency: "RUB",
    lines: [
      { product: f.rental.ref, quantity: "12" },
      { description: "Доставка", amount: "1500.00" },
    ],
  })
  expect(order).toMatchObject({
    direction: "sale",
    supplier: { owner: true },
    total: "121500.00",
    lines: [
      {
        position: 1,
        description: "Bike rental, month",
        quantity: "12",
        unitPrice: "10000.00",
        amount: "120000.00",
        product: f.rental.ref,
      },
      { position: 2, description: "Доставка", amount: "1500.00", product: null },
    ],
  })
  expect(order.supplierName).toBe("owner")
  expect(
    await reasonOf(
      f.store.orders.add({
        by: "owner",
        direction: "sale",
        purpose: "business",
        customer: f.client.ref,
        currency: "RUB",
        total: "1.00",
        lines: [{ description: "x", amount: "2.00" }],
      }),
    ),
  ).toBe("order.total")
  expect(
    await reasonOf(
      f.store.orders.add({ by: "owner", direction: "sale", purpose: "business", currency: "RUB", total: "1.00" }),
    ),
  ).toBe("order.field")
})

it("titles a sale by its customer, not by the owner who supplies it, in the store, a ref summary and the review", async () => {
  const f = await fixture()
  const order = await f.store.orders.add({
    by: claude,
    direction: "sale",
    purpose: "business",
    customer: f.client.ref,
    number: "O-55",
    currency: "RUB",
    total: "120000.00",
  })
  expect(order.title).toBe("Order O-55 · to ООО Пример, 120 000.00 RUB (placed, proposed)")
  const cache = await openCache(f.path)
  handles.push(cache)
  expect(refSummariesOf(cache, [order.ref]).get(order.ref)?.title).toBe(
    "O-55 · to ООО Пример, 120 000.00 RUB (placed, proposed)",
  )
  const [row] = (await proposalRegistry(f.store).list({ limit: 10, offset: 0, kinds: ["order"] })).items
  expect(row).toMatchObject({ summary: order.title, object: f.client.ref })
})

it("keeps a line's copied price when the product's price changes, on orders and invoices alike", async () => {
  const f = await fixture()
  const order = await f.store.orders.add({
    by: "owner",
    purpose: "business",
    supplierName: "Велопрокат",
    currency: "RUB",
    lines: [{ product: f.rental.ref }],
  })
  const invoice = await f.store.finance.addInvoice({
    by: "owner",
    direction: "receivable",
    counterparty: f.client.ref,
    currency: "RUB",
    lines: [{ product: f.rental.ref, description: "Rental, November" }],
  })
  await f.store.products.update(f.rental.ref, { by: "owner", unitPrice: "12000.00", currency: "RUB" })
  expect((await f.store.products.get(f.rental.ref)).unitPrice).toBe("12000.00")
  expect((await f.store.orders.get(order.ref)).lines[0]).toMatchObject({ unitPrice: "10000.00", amount: "10000.00" })
  expect((await f.store.finance.invoice(invoice.ref)).lines[0]).toMatchObject({
    description: "Rental, November",
    unitPrice: "10000.00",
    product: f.rental.ref,
  })
  expect(
    await reasonOf(
      f.store.finance.addInvoice({
        by: "owner",
        direction: "receivable",
        counterparty: f.client.ref,
        currency: "EUR",
        lines: [{ product: f.rental.ref }],
      }),
    ),
  ).toBe("finance.currency")
})

it("lets the owner change any order's lines and an agent only its own proposed order's, keeping the total", async () => {
  const f = await fixture()
  const mine = await f.store.orders.add({
    by: "owner",
    purpose: "personal",
    supplierName: "Ozon",
    currency: "RUB",
    total: "500.00",
  })
  const grown = await f.store.orders.addLine(mine.ref, { by: "owner", description: "Чехол", amount: "700.00" })
  expect(grown).toMatchObject({ total: "700.00", lines: [{ position: 1 }] })
  expect(await reasonOf(f.store.orders.addLine(mine.ref, { by: claude, description: "x", amount: "1.00" }))).toBe(
    "order.owner-only",
  )
  const proposed = await f.store.orders.add({
    by: claude,
    purpose: "business",
    supplierName: "Велопрокат",
    currency: "RUB",
    lines: [{ product: f.rental.ref, quantity: "2" }],
  })
  const more = await f.store.orders.addLine(proposed.ref, { by: claude, product: f.rental.ref, quantity: "0.5" })
  expect(more).toMatchObject({ review: "proposed", total: "25000.00" })
  expect(await f.store.orders.removeLine(proposed.ref, { by: claude, position: 1 })).toMatchObject({
    total: "5000.00",
    lines: [{ position: 2, amount: "5000.00" }],
  })
  await f.store.orders.confirm(proposed.ref, "owner")
  expect(await reasonOf(f.store.orders.removeLine(proposed.ref, { by: claude, position: 2 }))).toBe("order.owner-only")
  expect(await reasonOf(f.store.orders.removeLine(proposed.ref, { by: "owner", position: 2 }))).toBe("order.line")
  expect(await reasonOf(f.store.orders.removeLine(proposed.ref, { by: "owner", position: 9 }))).toBe("order.no-line")
  expect((await f.store.orders.get(proposed.ref)).lines).toHaveLength(1)

  const database = await openCache(f.path)
  handles.push(database)
  expect(() => database.prepare("UPDATE orders SET total = 1 WHERE id = ?").run(Number(proposed.id))).toThrow(
    /their sum as the total/,
  )
  expect(() => database.prepare("UPDATE orders SET direction = 'barter' WHERE id = ?").run(Number(mine.id))).toThrow(
    /orders:/,
  )
})
