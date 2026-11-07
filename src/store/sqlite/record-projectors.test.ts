import { describe, expect, it } from "vitest"
import { PROPOSAL_TYPES, RECORD_ENTITY_TYPES, RECORD_TYPES, TYPE_PATTERN } from "../../domain/record-types.js"
import { ENTITY_TABLES } from "./entity-types.js"
import { RECORD_PROJECTORS } from "./record-projectors.js"

describe("the record type registry", () => {
  it("has one projector per type, and a function exactly for the proposal types", () => {
    expect(Object.keys(RECORD_PROJECTORS).sort()).toEqual(Object.keys(RECORD_TYPES).sort())
    expect(RECORD_ENTITY_TYPES.filter((type) => RECORD_PROJECTORS[type] !== null)).toEqual(PROPOSAL_TYPES)
  })

  it("names the table each entity type already has", () => {
    for (const type of RECORD_ENTITY_TYPES) expect(RECORD_TYPES[type].table).toBe(ENTITY_TABLES[type])
  })

  it("takes every registered type and custom:<name>, and refuses the rest", () => {
    const pattern = new RegExp(TYPE_PATTERN)
    for (const type of [...RECORD_ENTITY_TYPES, "custom:crm_note"]) expect(pattern.test(type)).toBe(true)
    for (const type of ["task", "custom:", "Invoice", "invoice2"]) expect(pattern.test(type)).toBe(false)
  })
})
