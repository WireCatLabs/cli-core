import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import { parseLucene } from "./parser.js"
import { QUERY_FIELDS, validateAst, validateFields } from "./registry.js"
import { QUERY_LIMITS } from "./types.js"

interface Reference {
  query: string
  parsed: boolean
  ids?: number[]
  luceneQuery?: string
}
const corpus: Reference[] = JSON.parse(readFileSync(new URL("./reference.json", import.meta.url), "utf8"))
const reason = (run: () => unknown) => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof CliError ? error.details?.reason : "unexpected"
  }
}
describe("Lucene 9.12.3 grammar port", () => {
  for (const row of corpus)
    it(`matches upstream syntax acceptance: ${JSON.stringify(row.query)}`, () => {
      if (!row.parsed) expect(reason(() => parseLucene(row.query))).toBeDefined()
      else if (/[~^@]/u.test(row.query) || row.query.startsWith("fn:"))
        expect(reason(() => parseLucene(row.query))).toBe("unsupported_operator")
      else expect(parseLucene(row.query)).toMatchObject({ version: 1, language: "lucene-v1" })
    })
  it("preserves clause occurrences and adjacency", () => {
    expect(parseLucene("alpha OR beta gamma").root).toMatchObject({
      kind: "boolean",
      clauses: [
        { occur: "must", node: { kind: "boolean", clauses: [{ occur: "should" }, { occur: "should" }] } },
        { occur: "must" },
      ],
    })
    expect(parseLucene("+alpha OR beta").root).toMatchObject({
      kind: "boolean",
      clauses: [{ occur: "must" }, { occur: "should" }],
    })
    expect(parseLucene("NOT alpha").root).toMatchObject({ kind: "boolean", clauses: [{ occur: "mustNot" }] })
  })
  it("decodes standard escaped punctuation and Unicode without turning escaped stars into wildcards", () => {
    expect(parseLucene("text:hello\\:world").root).toMatchObject({ value: "hello:world", operator: "term" })
    expect(parseLucene("text:\\u03b1").root).toMatchObject({ value: "α" })
    expect(parseLucene("text:a\\*").root).toMatchObject({ value: "a*", operator: "term" })
    expect(reason(() => parseLucene("foo\\u0xyz"))).toBe("invalid_escape")
  })
  it("rejects excessive text, nodes, groups and malformed syntax with spans", () => {
    expect(reason(() => parseLucene("x".repeat(QUERY_LIMITS.bytes + 1)))).toBe("query_limit")
    expect(reason(() => parseLucene("a ".repeat(300)))).toBe("query_limit")
    expect(reason(() => parseLucene(`${"(".repeat(33)}alpha${")".repeat(33)}`))).toBe("query_limit")
    expect(reason(() => parseLucene('"unterminated'))).toBe("unclosed_literal")
    expect(reason(() => parseLucene("alpha [TO wrong TO]"))).toBe("invalid_syntax")
  })
  it.each([">", ">=", "<", "<="])("reads the Elasticsearch spelling date:%s as the colon-less comparison", (op) => {
    const { span, ...colon } = parseLucene(`date:${op}2026-10-10`).root
    const { span: plainSpan, ...plain } = parseLucene(`date${op}2026-10-10`).root
    expect(colon).toEqual(plain)
    expect(span).toEqual({ start: 0, end: plainSpan.end + 1 })
  })
})
describe("versioned structured AST and field registry", () => {
  it("round-trips the same AST, typed range and field group", () => {
    const ast = parseLucene("from:(alice OR bob) date:[2026-01-01 TO 2026-02-01}")
    expect(validateAst(JSON.parse(JSON.stringify(ast)))).toEqual(ast)
    expect(validateFields(ast)).toBe(ast)
    expect(QUERY_FIELDS.map(({ name }) => name)).toContain("body")
  })
  it.each([
    ["unknown:foo", "unknown_field"],
    ['tag:"two words"', "invalid_tag"],
    [`tag:${"a".repeat(33)}`, "invalid_tag"],
    ["kind:dialog", "unknown_value"],
    ["has:imaginary", "unknown_value"],
    ["preset:money", "unknown_value"],
    ["from:ali*", "unsupported_operator"],
    ["topic:abc", "invalid_topic"],
    ["text:[a TO b]", "unsupported_operator"],
    ['from:""', "missing_value"],
  ])("validates %s", (query, expected) => expect(reason(() => validateFields(parseLucene(query)))).toBe(expected))
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
    const ast = parseLucene("alpha")
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
    expect(reason(() => validateAst({ ...ast, root: recursive }))).toBe("query_limit")
  })
})
