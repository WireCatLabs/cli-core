import { describe, expect, it } from "vitest"
import {
  BUSINESS_TYPES,
  DECIDED_TABLES,
  RECORD_ENTITY_TYPES,
  RECORD_TYPES,
  TYPE_PATTERN,
} from "../../domain/record-types.js"
import { ENTITY_TABLES } from "./entity-types.js"
import { prefixesText } from "./finance.js"
import { RECORD_PROJECTORS } from "./record-projectors.js"

describe("the record type registry", () => {
  it("has one projector entry per type, and none for a type only the owner's map gives an entity", () => {
    expect(Object.keys(RECORD_PROJECTORS).sort()).toEqual(Object.keys(RECORD_TYPES).sort())
    for (const type of RECORD_ENTITY_TYPES)
      expect(RECORD_PROJECTORS[type] === null).toBe(RECORD_TYPES[type].review === "identity")
  })

  it("names the table each entity type already has", () => {
    for (const type of RECORD_ENTITY_TYPES) expect(RECORD_TYPES[type].table).toBe(ENTITY_TABLES[type])
  })

  it("takes every registered type and custom:<name>, and refuses the rest", () => {
    const pattern = new RegExp(TYPE_PATTERN)
    for (const type of [...RECORD_ENTITY_TYPES, "custom:crm_note"]) expect(pattern.test(type)).toBe(true)
    for (const type of ["task", "custom:", "Invoice", "invoice2"]) expect(pattern.test(type)).toBe(false)
  })

  it("keeps the business types out of the envelope until they get projectors, with the tables they have", () => {
    const pattern = new RegExp(TYPE_PATTERN)
    for (const [type, spec] of Object.entries(BUSINESS_TYPES)) {
      expect(pattern.test(type)).toBe(false)
      expect(Object.keys(RECORD_PROJECTORS)).not.toContain(type)
      expect(spec.table).toBe(ENTITY_TABLES[type as keyof typeof ENTITY_TABLES])
    }
  })

  it("keeps the owner's decision on every reviewed type in its own table", () => {
    expect(DECIDED_TABLES).toEqual({
      invoice: "invoices",
      payment: "payments",
      order: "orders",
      contract: "contracts",
      subscription: "subscriptions",
      transaction: "financial_transactions",
      subscription_price: "subscription_prices",
    })
  })

  it("puts one article before a list of ref prefixes, chosen by the first", () => {
    expect(prefixesText(["invoice", "payment"])).toBe("an invoice: or payment:")
    expect(prefixesText(["deal"])).toBe("a deal:")
  })
})
