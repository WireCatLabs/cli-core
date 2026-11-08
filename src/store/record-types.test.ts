import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { fieldError } from "../domain/record-fields.js"
import { DECIDED_TABLES, RECORD_ENTITY_TYPES, RECORD_TYPES, rolesOf, TYPE_PATTERN } from "../domain/record-types.js"
import { RECORDS_ENVELOPE_SCHEMA } from "../domain/records.js"
import { SIMPLE_REFERENCES } from "../domain/references.js"
import { ENTITY_TABLES } from "./sqlite/entity-types.js"
import { RECORD_PROJECTORS } from "./sqlite/record-projectors.js"
import { prefixesText } from "./sqlite/reviewed.js"

const SCHEMA_FILE = new URL("../../schemas/records-envelope.v1.schema.json", import.meta.url)

describe("the record type registry", () => {
  it("has one projector per type, and none for a type matched or made from its identifiers", () => {
    expect(Object.keys(RECORD_PROJECTORS).sort()).toEqual([...RECORD_ENTITY_TYPES].sort())
    for (const type of RECORD_ENTITY_TYPES)
      expect(RECORD_PROJECTORS[type] === null).toBe(RECORD_TYPES[type].review === "identity")
  })

  it("gives an update to every projector whose type changes its entity again", () => {
    for (const type of RECORD_ENTITY_TYPES) {
      const projector = RECORD_PROJECTORS[type]
      if (projector === null) continue
      const changes = ["in-place", "re-propose", "re-settle"].includes(RECORD_TYPES[type].update)
      expect([type, projector.update !== undefined]).toEqual([type, changes])
    }
  })

  it("takes every registered type and custom:<name>, and refuses the rest", () => {
    const pattern = new RegExp(TYPE_PATTERN)
    for (const type of [...RECORD_ENTITY_TYPES, "custom:crm_note"]) expect(pattern.test(type)).toBe(true)
    for (const type of ["task", "custom:", "Invoice", "invoice2"]) expect(pattern.test(type)).toBe(false)
  })

  it("is the source of the tables, refs and tombstones the store resolves", () => {
    for (const [type, spec] of Object.entries(RECORD_TYPES)) {
      expect(ENTITY_TABLES[type as keyof typeof ENTITY_TABLES]).toBe(spec.table)
      // A message's ref is its locator, msg:<provider>/<account>/<chat>/<message>.
      if (type !== "message") expect(SIMPLE_REFERENCES).toContain(type)
    }
  })

  it("names only registered types as role targets, and a column for every role the entity is made from", () => {
    for (const type of RECORD_ENTITY_TYPES)
      for (const [name, role] of rolesOf(type)) {
        for (const target of role.targets)
          expect([type, name, SIMPLE_REFERENCES.includes(target as never)]).toEqual([type, name, true])
        const needsColumn = !role.kept && !role.many && !role.linked
        expect([type, name, needsColumn ? role.column !== undefined : true]).toEqual([type, name, true])
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

describe("the envelope's JSON Schema", () => {
  it("is the file the package ships, generated from the registry by pnpm schema:envelope", () => {
    expect(JSON.parse(readFileSync(SCHEMA_FILE, "utf8"))).toEqual(RECORDS_ENVELOPE_SCHEMA)
  })

  it("holds each type's fields as the registry types them, any other key kept", () => {
    const defs = RECORDS_ENVELOPE_SCHEMA.$defs as Record<string, unknown>
    for (const type of RECORD_ENTITY_TYPES) expect(defs[`fields-${type}`]).toEqual(RECORD_TYPES[type].fields)
    expect(fieldError(RECORD_TYPES.product.fields, { name: "Rent", colour: { deep: [1] } })).toBeUndefined()
    expect(fieldError(RECORD_TYPES.product.fields, { name: "Rent", unit_price: "ten" })).toMatchObject({
      at: ["unit_price"],
    })
    expect(fieldError(RECORD_TYPES.pipeline.fields, { name: "Sales", stages: [{ name: "New" }] })).toMatchObject({
      at: ["stages", 0, "external_id"],
      message: "fields.stages.0.external_id is required",
    })
  })
})
