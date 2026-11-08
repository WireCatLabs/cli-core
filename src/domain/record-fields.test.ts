import { Ajv2020 } from "ajv/dist/2020.js"
import { expect, it } from "vitest"
import { fieldError } from "./record-fields.js"
import { RECORD_ENTITY_TYPES, RECORD_TYPES } from "./record-types.js"

const ajv = new Ajv2020({ strict: false, allErrors: false })

/** Values a source sends, valid and broken, for every type: both checks must give the same verdict on each. */
const FIXTURES: Record<string, unknown[]> = {
  person: [{ name: "Анна", email: ["a@example.com", 5], phone: "n/a" }, { name: null }, { name: 42 }],
  organization: [{ name: "Пример", identifiers: ["INN 7701", null, { scheme: "telegram", value: 42 }] }],
  project: [{ name: "", key: 7 }],
  product: [
    { name: "Bike" },
    { name: "Bike", unit_price: "10.00", currency: "EUR", kind: "service" },
    { name: "Bike", unit_price: "ten" },
    { name: null },
    { kind: "product" },
    { name: "", sku: null },
    { name: "x", unit: "😀".repeat(40) },
    { name: "x", unit: "😀".repeat(41) },
    { name: " " },
    { name: "x", kind: null },
    { name: "x", kind: "thing" },
  ],
  invoice: [
    { direction: "receivable", currency: "EUR", lines: [{ description: "x", amount: "5.00", product: { any: 1 } }] },
    { direction: "receivable", lines: [{ product_ref: "product:x" }] },
    { number: null, total: null, lines: null },
    { lines: [null] },
  ],
  payment: [{ amount: "1.00", reference: null }, { amount: 1 }, { direction: "sideways" }],
  contract: [
    { name: "K", kind: "nda", auto_renew: true, notice_days: 30 },
    { name: "K", kind: "nda", notice_days: 1.5 },
    { name: "K", kind: "nda", notice_days: -1 },
    { name: "K", kind: "nda", renewal: "1-year", auto_renew: "yes" },
  ],
  subscription: [
    {
      direction: "payable",
      interval: "1-month",
      start_date: "2026-11-01",
      prices: [{ amount: "1.00", currency: "EUR" }],
    },
    { direction: "payable", interval: "monthly", start_date: "2026-11-01" },
    { direction: "payable", interval: "1-month", start_date: "2026-11-01", prices: [{ amount: "1.00" }] },
  ],
  wallet: [
    { name: "Bank", currency: "EUR", opening_balance: "-5.00" },
    { name: "Bank", currency: "EURO" },
  ],
  transaction: [
    { direction: "in", amount: "1.00", date: "2026-11-01", splits: [{ amount: "1.00", category: "rent" }] },
    { direction: "in", amount: "1.00", date: "1 Nov" },
  ],
  deal: [
    { title: "T", pipeline: "p", stage: "s", status: "won" },
    { title: "T", pipeline: "p" },
  ],
  lead: [{ title: "T", pipeline: "p", stage: "s", amount: null }],
  pipeline: [
    { name: "Sales", stages: [{ external_id: "s", name: "New", position: 1, outcome: "open" }] },
    { name: "Sales", stages: [{ name: "New" }] },
    { name: "Sales", stages: [], kind: "deal" },
  ],
  order: [{ direction: "sale", lines: [{ quantity: "2", product: "sku" }] }, { status: "lost" }],
}

it("checks every type's fields as a standard JSON Schema 2020-12 validator does", () => {
  expect(Object.keys(FIXTURES).sort()).toEqual([...RECORD_ENTITY_TYPES].sort())
  for (const type of RECORD_ENTITY_TYPES) {
    const validate = ajv.compile(RECORD_TYPES[type].fields)
    for (const value of FIXTURES[type] as unknown[]) {
      const ours = fieldError(RECORD_TYPES[type].fields, value) === undefined
      expect([type, value, ours]).toEqual([type, value, validate(value)])
    }
  }
})
