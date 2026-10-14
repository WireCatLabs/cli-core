import { projectFields as coreProjectFields } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { fieldsOf, projectFields } from "./result-fields.js"

describe("machine result projection", () => {
  it("preserves list metadata while projecting requested item data", () => {
    const value = {
      items: [{ id: "7", text: "synthetic", sender: { id: "8", name: "Synthetic" } }],
      page: 2,
      limit: 10,
      hasMore: true,
      coverage: { state: "partial" },
      total: 40,
      by: "sender",
      nextBeforeId: "synthetic-next",
    }
    expect(projectFields(value, fieldsOf("id,sender.id"))).toEqual({
      items: [{ id: "7", sender: { id: "8" } }],
      page: 2,
      limit: 10,
      hasMore: true,
      coverage: { state: "partial" },
      total: 40,
      by: "sender",
      nextBeforeId: "synthetic-next",
    })
    expect(value.items[0]?.sender.name).toBe("Synthetic")
  })
  it("never removes correlation or invents missing values", () => {
    expect(
      projectFields({ id: "7", operation_id: "synthetic-operation", missing: null }, ["id", "missing", "unknown"]),
    ).toEqual({ id: "7", operation_id: "synthetic-operation", missing: null })
    expect(projectFields([{ id: "7", text: "synthetic" }], ["id"])).toEqual([{ id: "7" }])
    expect(projectFields(null, ["id"])).toBeNull()
  })
  it("rejects unsafe paths, empty names and excessive field lists", () => {
    for (const path of [
      "",
      "id,",
      "__proto__.x",
      "sender.constructor",
      "a[0]",
      Array.from({ length: 129 }, () => "id").join(","),
    ])
      expect(() => fieldsOf(path)).toThrow("--json")
    expect(fieldsOf("id, id")).toEqual(["id"])
  })
  it("does not mutate an immutable parent when paths overlap", () => {
    const sender = Object.freeze({ id: "8", name: "Synthetic" })
    expect(projectFields({ sender }, ["sender", "sender.id"])).toEqual({ sender })
    expect(projectFields({ sender: null }, ["sender.id"])).toEqual({})
  })
})

it("accepts items.id consistently for paged rows, arrays and JSONL items", () => {
  expect(projectFields({ items: [{ id: "synthetic", text: "synthetic" }], hasMore: true }, ["items.id"])).toEqual({
    items: [{ id: "synthetic" }],
    hasMore: true,
  })
  expect(projectFields([{ id: "synthetic" }], ["items.id"])).toEqual([{ id: "synthetic" }])
  expect(projectFields({ id: "synthetic", text: "synthetic" }, ["items.id"])).toEqual({ id: "synthetic" })
})

it("is the core projection", () => {
  const value = {
    items: [{ id: "example", operation_id: "example-operation", send_id: "example-send" }, { id: "second-example" }],
    page: { limit: 3, has_more: false },
  }
  expect(projectFields(value, fieldsOf("items.id"))).toEqual(coreProjectFields(value, fieldsOf("items.id")))
})

it("rejects unsafe direct paths and excessive selections before projection", () => {
  for (const paths of [
    ["__proto__.example"],
    ["sender.constructor"],
    ["a.prototype.example"],
    ["a".repeat(257)],
    Array.from({ length: 129 }, () => "id"),
  ])
    expect(() => projectFields({}, paths)).toThrow("--json")
})

it("cuts an item answer down to the fields asked, keeping its next steps and meta", () => {
  const answer = {
    item: { id: "1", title: "Synthetic", kind: "group" },
    next: [],
    meta: { run_id: "r", duration_ms: 1 },
  }
  expect(projectFields(answer, ["title"])).toEqual({ ...answer, item: { title: "Synthetic" } })
})
