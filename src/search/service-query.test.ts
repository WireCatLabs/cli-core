import { type Predicate, parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { type ServiceCapability, serviceCallsOf } from "./service-query.js"

type Terms = string[]

const service = (
  overrides: Partial<ServiceCapability<Predicate, Terms>> = {},
): ServiceCapability<Predicate, Terms> => ({
  fields: { code: ["term"], started_at: ["range"], title: ["phrase"] },
  maxCalls: 3,
  all: [],
  leaf: (node, negated) => [`${negated ? "-" : ""}${node.field}:${node.value}`],
  both: (one, other) =>
    one.some((term) => other.includes(term.startsWith("-") ? term.slice(1) : `-${term}`))
      ? undefined
      : [...one, ...other],
  ...overrides,
})
const callsOf = (text: string, overrides?: Partial<ServiceCapability<Predicate, Terms>>, scope?: Terms) =>
  serviceCallsOf(parseLucene(text, { defaultField: "title" }).root, service(overrides), scope)

describe("the query a service is asked", () => {
  it("keeps the fields and operators the service reads and leaves the rest to the store", () => {
    expect(callsOf("code:abc AND title:*standup* AND participants_count:>3 AND started_at:[2026-11-01 TO *]")).toEqual({
      calls: [["code:abc", "started_at:2026-11-01"]],
      complete: true,
      unsent: 0,
    })
  })

  it("asks one call per OR branch, and only the required clauses beside an optional one", () => {
    expect(callsOf("code:a OR code:b").calls).toEqual([["code:a"], ["code:b"]])
    const [a, b] = ["code:a", "code:b"].map((text) => parseLucene(text, { defaultField: "title" }).root)
    const span = { start: 0, end: 0 }
    const mixed = {
      kind: "boolean" as const,
      span,
      clauses: [
        { occur: "must" as const, node: a as Predicate },
        { occur: "should" as const, node: b as Predicate },
      ],
    }
    expect(serviceCallsOf(mixed, service()).calls).toEqual([["code:a"]])
  })

  it("multiplies an AND of ORs and drops a branch whose parts cannot both hold", () => {
    expect(
      callsOf("(code:a OR code:b) AND (started_at:[1 TO 2] OR NOT code:a)", { negatable: ["code"] }).calls,
    ).toEqual([["code:b", "started_at:1", "-code:a"]])
  })

  it("stops at the cap and says the answer is not complete", () => {
    expect(callsOf("code:a OR code:b OR code:c OR code:d")).toEqual({
      calls: [["code:a"], ["code:b"], ["code:c"]],
      complete: false,
      unsent: 0,
    })
  })

  it("leaves a NOT to the store unless the service can negate that field", () => {
    expect(callsOf("code:a AND NOT code:b").calls).toEqual([["code:a"]])
    expect(callsOf("code:a AND NOT code:b", { negatable: ["code"] }).calls).toEqual([["code:a", "-code:b"]])
    expect(callsOf("code:a AND NOT (code:b OR code:c)", { negatable: ["code"] }).calls).toEqual([["code:a"]])
  })

  it("joins the branches into one call for a service that can OR", () => {
    expect(
      callsOf("code:a OR code:b OR code:c OR code:d", { either: (branches) => [branches.flat().join("|")] }),
    ).toEqual({ calls: [["code:a|code:b|code:c|code:d"]], complete: true, unsent: 0 })
  })

  it("keeps a scope in every call and leaves out the branches not worth a call", () => {
    expect(
      callsOf("code:a OR title:x", { sends: (terms) => terms.some((one) => one.startsWith("code")) }, ["s"]),
    ).toEqual({ calls: [["s", "code:a"]], complete: true, unsent: 1 })
  })

  it("leaves a clause to the store rather than multiplying an AND of ORs past 64 branches", () => {
    const ors = Array.from({ length: 7 }, (_, i) => `(code:a${i} OR code:b${i})`).join(" AND ")
    const { calls } = callsOf(ors, { maxCalls: 1000 })
    expect(calls).toHaveLength(64)
    expect(calls.every((call) => call.length === 6)).toBe(true)
  })

  it("asks for everything when nothing in the query is the service's", () => {
    expect(callsOf("title:*x*").calls).toEqual([[]])
  })
})
