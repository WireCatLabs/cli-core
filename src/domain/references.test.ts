import { describe, expect, it } from "vitest"
import { canonicalReference, formatReference, parseReference } from "./references.js"

describe("references", () => {
  it("round-trips every kind, percent-encoding the parts that are someone else's ids", () => {
    for (const text of [
      "msg:notes/%2Fvault/Projects/Projects%2Fplan.md",
      "chat:telegram/500/-1001",
      "chat:email/owner%40example.test/12345",
      "contact:telegram/101",
      "note:01J",
      "person:P1",
      "entity:E1",
      "organization:3",
      "project:4",
      "document:5",
      "memory:6",
      "fact:7",
      "task:T1",
    ])
      expect(formatReference(parseReference(text))).toBe(text)
    expect(parseReference("chat:notes/v/a%2Fb")).toEqual({ type: "chat", provider: "notes", account: "v", chat: "a/b" })
    expect(canonicalReference(" person:P1 ")).toBe("person:P1")
  })

  it("refuses a reference whose kind or shape it does not know", () => {
    for (const text of ["P1", "people:P1", "chat:telegram/500", "contact:telegram", "note:", "msg:telegram/1/2"])
      expect(() => parseReference(text)).toThrow(expect.objectContaining({ code: "validation_error" }))
  })
})
