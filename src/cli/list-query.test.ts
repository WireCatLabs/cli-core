import type { QueryRegistry } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { listQuery, nativeTerms, queryArgument, queryTerms, termField } from "./list-query.js"

const REGISTRY = {
  entity: "fact",
  backend: "native",
  fields: [
    termField("kind", "enum", "kind:decision", { values: ["decision", "event"] }),
    termField("project", "kw", "project:SYH"),
    termField("subject", "ref", 'subject:"person:42"'),
  ],
  defaults: ["kind:event"],
} as const satisfies QueryRegistry

describe("queryTerms", () => {
  it("reads typed terms beside a default whose field they do not name", () => {
    expect(queryTerms(["project:SYH", 'subject:"person:42"'], REGISTRY, "facts list")).toEqual(
      new Map([
        ["project", "SYH"],
        ["subject", "person:42"],
        ["kind", "event"],
      ]),
    )
  })

  it("lets a typed term replace the default and lowercases an enum value", () => {
    expect(queryTerms("kind:DECISION", REGISTRY, "facts list")).toEqual(new Map([["kind", "decision"]]))
  })

  it("refuses OR, a repeated field and a wildcard", () => {
    expect(() => queryTerms("project:a OR project:b", REGISTRY, "facts list")).toThrow(/joined by AND/)
    expect(() => queryTerms("project:a project:b", REGISTRY, "facts list")).toThrow(/only once/)
    expect(() => queryTerms("project:SY*", REGISTRY, "facts list")).toThrow()
  })
})

describe("nativeTerms", () => {
  it("reads typed AND terms nested beside the defaults", () => {
    const terms = nativeTerms(listQuery("project:a subject:b", REGISTRY, "facts list"), "facts list")
    expect([...terms.keys()]).toEqual(["project", "subject", "kind"])
  })
})

it("tells an MCP caller a native list takes AND only", () => {
  expect(queryArgument(REGISTRY).wrapped.pipe.at(-1)).toMatchObject({
    description: expect.stringMatching(/^field:value terms joined by AND that narrow the list; fields: kind/),
  })
})
