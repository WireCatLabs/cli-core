import { describe, expect, it } from "vitest"
import { DECIDED_TABLES, RECORD_ENTITY_TYPES, RECORD_TYPES, TYPE_PATTERN } from "../../domain/record-types.js"
import { SIMPLE_REFERENCES } from "../../domain/references.js"
import { ENTITY_TABLES } from "./entity-types.js"
import { RECORD_PROJECTORS } from "./record-projectors.js"
import { prefixesText } from "./reviewed.js"

describe("the record type registry", () => {
  it("has one projector entry per type, and none for a type only the owner's map gives an entity", () => {
    expect(Object.keys(RECORD_PROJECTORS).sort()).toEqual([...RECORD_ENTITY_TYPES].sort())
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

  it("keeps the types after v1's five out of the envelope until they get projectors", () => {
    const pattern = new RegExp(TYPE_PATTERN)
    for (const [type, spec] of Object.entries(RECORD_TYPES)) {
      expect(pattern.test(type)).toBe(spec.envelope)
      expect(Object.hasOwn(RECORD_PROJECTORS, type)).toBe(spec.envelope)
    }
  })

  it("is the source of the tables, refs and tombstones the store resolves", () => {
    for (const [type, spec] of Object.entries(RECORD_TYPES)) {
      expect(ENTITY_TABLES[type as keyof typeof ENTITY_TABLES]).toBe(spec.table)
      expect(SIMPLE_REFERENCES).toContain(type)
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
