import { OPERATORS_BY_TYPE, type QueryRegistry } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { listQuery, nativeField, nativeTerms, queryArgument, queryTerms, termField, timeBounds } from "./list-query.js"

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

describe("timeBounds", () => {
  const TIMED = {
    entity: "event",
    backend: "native",
    fields: [nativeField({ name: "time", type: "time", operators: OPERATORS_BY_TYPE.time, example: "time>=7d" })],
  } as const satisfies QueryRegistry
  const bounds = (query: string) =>
    timeBounds(nativeTerms(listQuery(query, TIMED, "events list"), "events list").get("time"), "UTC")

  it("ends a range of bare dates on the last millisecond of its last day", () => {
    expect(bounds("time:[2026-10-01 TO 2026-10-31]")).toMatchObject({
      since: Date.parse("2026-10-01T00:00:00Z"),
      until: Date.parse("2026-10-31T23:59:59.999Z"),
      meta: { window: { until: "2026-10-31T23:59:59.999Z" } },
    })
  })

  it("keeps an inclusive end timestamp and moves an exclusive one 1 ms inside", () => {
    const at = "2026-10-31T12:00:00Z"
    expect(bounds(`time:["2026-10-01T00:00:00Z" TO "${at}"]`)).toMatchObject({ until: Date.parse(at) })
    expect(bounds(`time:["2026-10-01T00:00:00Z" TO "${at}"}`)).toMatchObject({ until: Date.parse(at) - 1 })
  })
})
