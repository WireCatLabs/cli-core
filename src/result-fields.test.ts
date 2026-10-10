import { describe, expect, it } from "vitest"
import { fieldsOf, projectFields } from "./result-fields.js"

describe("portable result projection", () => {
  it("keeps page and operation metadata while selecting nested item data", () => {
    const input = {
      items: [{ id: 1, speaker: { id: 2, name: "Alice Example" }, text: "Example" }],
      page: 2,
      limit: 1,
      hasMore: true,
      nextCursor: "example",
      operationId: "example-operation",
    }
    expect(projectFields(input, fieldsOf("items.id,speaker.id"))).toEqual({
      ...input,
      items: [{ id: 1, speaker: { id: 2 } }],
    })
    expect(input.items[0]?.speaker.name).toBe("Alice Example")
    expect(projectFields(input.items, ["id"])).toEqual([{ id: 1 }])
    expect(projectFields(input.items[0], ["items.id"])).toEqual({ id: 1 })
  })
  it("keeps operation identifiers, null values and parent selections", () => {
    expect(
      projectFields({ id: 1, operationId: "example", sendId: "example-send", missing: null }, ["missing", "unknown"]),
    ).toEqual({ missing: null, operationId: "example", sendId: "example-send" })
    const speaker = { id: 1, name: "Alice Example" }
    expect(projectFields({ speaker }, ["speaker.id", "speaker"])).toEqual({ speaker })
    expect(projectFields({ speaker: null }, ["speaker.id"])).toEqual({})
    expect(projectFields(null, ["id"])).toBeNull()
    expect(projectFields(3, ["id"])).toBe(3)
    expect(projectFields(Object.create({ id: 3 }), ["id"])).toEqual({})
    expect(projectFields({ items: null, id: 1 }, ["id"])).toEqual({ id: 1 })
  })
  it("rejects unsafe, empty or excessive paths even when supplied directly", () => {
    for (const path of ["", "a..b", "items.__proto__.x", "constructor", "a.prototype.x", "id,", "a".repeat(257)]) {
      expect(() => fieldsOf(path)).toThrow(/--fields/)
      expect(() => projectFields({}, [path])).toThrow(/--fields/)
    }
    expect(() => fieldsOf(Array(129).fill("id").join(","))).toThrow(/--fields/)
    expect(() => projectFields({}, [])).toThrow(/--fields/)
    expect(fieldsOf("id, id,speaker.id")).toEqual(["id", "speaker.id"])
    expect({}).not.toHaveProperty("polluted")
  })
})
