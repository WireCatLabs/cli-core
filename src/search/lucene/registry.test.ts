import { CliError } from "@wirecat/cli-base"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { astJson, QUERY_FIELDS, validateAst, validateFields } from "./registry.js"

const reason = (run: () => unknown) => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof CliError ? error.details?.reason : "unexpected"
  }
}

describe("versioned structured AST and field registry", () => {
  it("round-trips a typed range, a negation and a field group through the snake_case JSON form", () => {
    const ast = parseLucene("from:(alice OR bob) date:[2026-01-01 TO 2026-02-01} -kind:bot")
    const json = JSON.parse(JSON.stringify(astJson(ast)))
    expect(JSON.stringify(json)).toContain('"lower_inclusive":true')
    expect(JSON.stringify(json)).toContain('"upper_inclusive":false')
    expect(JSON.stringify(json)).toContain('"occur":"must_not"')
    expect(JSON.stringify(json)).not.toMatch(/Inclusive|mustNot/)
    expect(validateAst(json)).toEqual(ast)
    expect(validateFields(ast)).toBe(ast)
    expect(QUERY_FIELDS.map(({ name }) => name)).toContain("body")
  })
  it("refuses the parser's camelCase tree as input", () => {
    expect(reason(() => validateAst(parseLucene("date:[2026-01-01 TO 2026-02-01]")))).toBe("query.invalid-ast")
    expect(reason(() => validateAst(parseLucene("alpha -beta")))).toBe("query.invalid-ast")
  })
  it.each([
    ["unknown:foo", "query.unknown-field"],
    ['tag:"two words"', "query.invalid-tag"],
    [`tag:${"a".repeat(33)}`, "query.invalid-tag"],
    ["kind:dialog", "query.unknown-value"],
    ["has:imaginary", "query.unknown-value"],
    ["preset:money", "query.unknown-value"],
    ["from:ali*", "query.unsupported-operator"],
    ["kind:*", "query.unsupported-operator"],
    ["topic:abc", "query.invalid-topic"],
    ["size>lots", "query.invalid-size"],
    ["text:[a TO b]", "query.unsupported-operator"],
    ['from:""', "query.missing-value"],
    ['subject:""', "query.missing-value"],
  ])("validates %s", (query, expected) => expect(reason(() => validateFields(parseLucene(query)))).toBe(expected))
  it("lets text, exact and body be empty", () => {
    for (const query of ['text:""', 'exact:""', 'body:""'])
      expect(reason(() => validateFields(parseLucene(query)))).toBe(undefined)
  })
  it.each([
    ["after:2026-09-01", "use date>=2026-09-01"],
    ["before:2026-09-01", "use date<2026-09-01"],
    ["after:[a TO b]", "use date>=YYYY-MM-DD or date:[a TO b]"],
  ])("refuses %s and names the replacement", (query, alternative) => {
    try {
      validateFields(parseLucene(query))
      expect.unreachable()
    } catch (error) {
      expect((error as CliError).details).toMatchObject({ reason: "legacy_date_field", alternative })
    }
  })
  it("rejects malicious structured inputs rather than trusting casts", () => {
    const ast = astJson(parseLucene("alpha")) as { root: Record<string, unknown> }
    for (const input of [
      null,
      {},
      { ...ast, version: 2 },
      { ...ast, root: { kind: "garbage" } },
      { ...ast, root: { ...ast.root, span: { start: -1, end: 0 } } },
      { ...ast, root: { kind: "boolean", span: { start: 0, end: 1 }, clauses: [{ occur: "sql", node: ast.root }] } },
      { ...ast, root: { kind: "boolean", span: { start: 0, end: 1 }, clauses: [] } },
      { ...ast, root: { ...ast.root, operator: "range", upper: 10 } },
      { ...ast, root: { ...ast.root, value: "a".repeat(8193) } },
    ])
      expect(reason(() => validateAst(input))).toBeDefined()
    const recursive: { kind: "boolean"; span: { start: number; end: number }; clauses: unknown[] } = {
      kind: "boolean",
      span: { start: 0, end: 1 },
      clauses: [],
    }
    recursive.clauses.push({ occur: "must", node: recursive })
    expect(reason(() => validateAst({ ...ast, root: recursive }))).toBe("query.too-large")
  })
})
