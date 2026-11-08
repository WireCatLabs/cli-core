import type { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { envelopeOf, recordsFixture, take, upsert } from "../testing/records.js"
import { searchAll } from "./search-all.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const ROWS = 10_000
// Measured 70–125 ms on a laptop for 70,000 rows, a 1,000-row page included; the budget is for slow CI runners.
const BUDGET_MS = 3_000

/** Copies row `id` of `table` until it holds `ROWS` rows, `vary` giving each copy its own numbers and names. */
const clone = (database: DatabaseSync, table: string, vary: Record<string, string>) => {
  const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map(({ name }) => name)
    .filter((name) => name !== "id")
  const values = columns.map((name) => vary[name] ?? `t.${name}`)
  database
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) ` +
        `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${table} t, n ` +
        `WHERE t.id = (SELECT min(id) FROM ${table})`,
    )
    .run()
}

it(`folds ${ROWS} rows of each lane type within ${BUDGET_MS} ms`, async () => {
  const { store, sql } = await recordsFixture(handles)
  const org = { role: "counterparty", type: "organization", external_id: "c-1" }
  await take(
    store,
    envelopeOf([
      upsert("organization", "c-1", { name: "Synthetic Org" }),
      upsert(
        "invoice",
        "i-1",
        { number: "INV-1", direction: "receivable", currency: "EUR", lines: [{ description: "x", amount: "1.00" }] },
        { relations: [org] },
      ),
      upsert(
        "payment",
        "p-1",
        { direction: "in", amount: "1.00", currency: "EUR", date: "2026-11-01", reference: "ref 1" },
        { relations: [{ ...org, role: "payer" }] },
      ),
      upsert("order", "o-1", {
        number: "PO-1",
        supplier_name: "Shop",
        currency: "EUR",
        lines: [{ description: "cable", quantity: "1", amount: "1.00" }],
      }),
      upsert("contract", "k-1", { name: "Contract 1", number: "K-1", kind: "service" }),
      upsert(
        "subscription",
        "s-1",
        { name: "Plan 1", direction: "payable", interval: "1-month", start_date: "2026-11-01" },
        { relations: [{ ...org, role: "supplier" }] },
      ),
      upsert("product", "sku-1", { name: "Product 1", sku: "SKU-1", kind: "product" }),
      upsert("wallet", "w-1", { name: "Wallet 1", currency: "EUR", institution: "Bank" }),
    ]),
  )
  const database = sql()
  database.exec("BEGIN")
  clone(database, "invoices", { number: "'INV-' || n.i" })
  clone(database, "payments", { reference: "'ref ' || n.i" })
  clone(database, "orders", { number: "'PO-' || n.i" })
  database.exec(
    "INSERT INTO order_lines (order_id, position, description, quantity, amount, created_at, updated_at) " +
      "SELECT id, 0, 'cable ' || id, '1', 100, created_at, updated_at FROM orders WHERE id > 1",
  )
  clone(database, "contracts", { name: "'Contract ' || n.i", number: "'K-' || n.i" })
  clone(database, "subscriptions", { name: "'Plan ' || n.i" })
  clone(database, "catalog_items", {
    name: "'Product ' || n.i",
    name_folded: "'product ' || n.i",
    sku: "'SKU-' || n.i",
  })
  clone(database, "financial_accounts", { name: "'Wallet ' || n.i", name_folded: "'wallet ' || n.i" })
  // Half the copies came from the import, so provenance is read for them too.
  for (const [type, table] of [
    ["invoice", "invoices"],
    ["payment", "payments"],
    ["product", "catalog_items"],
  ] as const)
    database.exec(
      "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, entity_type, entity_id, " +
        `created_at, updated_at) SELECT r.account_id, r.type, r.external_id || '-' || x.id, r.fields, r.fingerprint, ` +
        `r.batch_id, r.entity_type, x.id, r.created_at, r.updated_at FROM ${table} x JOIN records r ` +
        `ON r.entity_type = '${type}' AND r.entity_id = 1 WHERE x.id > 1 AND x.id % 2 = 0`,
    )
  database.exec("COMMIT")
  for (const table of [
    "invoices",
    "payments",
    "orders",
    "contracts",
    "subscriptions",
    "catalog_items",
    "financial_accounts",
  ])
    expect([table, database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n]).toEqual([table, ROWS])

  const timed = async (text: string, page: { limit: number; offset?: number } = { limit: 20 }) => {
    const started = performance.now()
    const found = await searchAll(
      store,
      { provider: "notes", account: "internal" },
      {
        text,
        ...page,
        only: ["business"],
      },
    )
    return { found, ms: performance.now() - started }
  }
  const one = await timed("INV-4242")
  expect(one.found.items.map(({ kind }) => kind)).toEqual(["invoice"])
  const many = await timed("1")
  expect(many.found.items).toHaveLength(20)
  expect(many.found.hasMore).toBe(true)
  // Past the 500 rows the lane once read at most, a deep page still knows more follow.
  const deep = await timed("1", { limit: 1000, offset: 500 })
  expect(deep.found.items).toHaveLength(1000)
  expect(deep.found.hasMore).toBe(true)
  const none = await timed("nothing-holds-this")
  expect(none.found.items).toEqual([])
  for (const { ms } of [one, many, deep, none]) expect(ms).toBeLessThan(BUDGET_MS)
})
