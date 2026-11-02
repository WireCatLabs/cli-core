import { describe, expect, it } from "vitest"
import { canonicalReference, formatReference, looksLikeReference, parseReference } from "./references.js"

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
      "event:12",
      "meeting:1/2",
      "meeting:1/2/3/0",
    ])
      expect(formatReference(parseReference(text))).toBe(text)
    expect(parseReference("chat:notes/v/a%2Fb")).toEqual({ type: "chat", provider: "notes", account: "v", chat: "a/b" })
    expect(canonicalReference(" person:P1 ")).toBe("person:P1")
    expect(canonicalReference("meeting:01/2")).toBe("meeting:1/2")
    expect(parseReference("meeting:1/2/3")).toEqual({ type: "meeting", accountId: 1, meetingId: 2, transcriptId: 3 })
  })

  it("refuses a reference whose kind or shape it does not know", () => {
    for (const text of ["P1", "people:P1", "chat:telegram/500", "contact:telegram", "note:", "msg:telegram/1/2"])
      expect(() => parseReference(text)).toThrow(expect.objectContaining({ code: "validation_error" }))
  })

  it("names the reason, and the kind meant when a prefix is near one", () => {
    expect(() => parseReference("chat:max/34871122")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "ref.malformed" }),
        message: '"chat:max/34871122" is not a reference — expected chat:<provider>/<account>/<chat>',
      }),
    )
    expect(() => parseReference("doc:413")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "ref.unknown-kind" }),
        message: expect.stringMatching(
          /^"doc:413" is no kind of reference; did you mean document:413\? Kinds: msg:, chat:/,
        ),
      }),
    )
    expect(() => parseReference("meeting:0/2")).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "ref.malformed" }) }),
    )
  })

  it("tells a reference from a title that has a colon in it", () => {
    for (const text of ["chat:max/1/2", "msg:max/1/2/3", "event:5", "meeting:1/2", " note:7 "])
      expect(looksLikeReference(text)).toBe(true)
    for (const text of ["Note: plan", "note:", "Plan:7", "doc:413", "chat:max/1 /2", "-1001", "user:5"])
      expect(looksLikeReference(text)).toBe(false)
  })
})
