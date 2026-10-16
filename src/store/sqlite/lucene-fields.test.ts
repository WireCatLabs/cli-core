import { describe, expect, it } from "vitest"
import { QUERY_FIELDS } from "../../search/lucene/registry.js"
import { FIELD_COMPILERS } from "./lucene-fields.js"

describe("field compilers", () => {
  it("compile every field the registry declares, and no other", () => {
    expect(Object.keys(FIELD_COMPILERS).sort()).toEqual(QUERY_FIELDS.map(({ name }) => name).sort())
  })
})
