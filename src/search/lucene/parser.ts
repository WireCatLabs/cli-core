// Port of Lucene 9.12.3 StandardSyntaxParser.jj and BooleanModifiersQueryNodeProcessor (Apache-2.0).
// Upstream sources and notices: scripts/search-reference; adjacency is Query(DisjQuery*), not ConjQuery.
import { type Predicate, QUERY_LIMITS, type QueryAst, type QueryNode, queryError, type Span } from "./types.js"

interface Token {
  kind: string
  raw: string
  span: Span
}
const whitespace = (c: string) => /[ \t\n\r\u3000]/u.test(c)
const reserved = new Set([
  "+",
  "-",
  "!",
  "(",
  ")",
  ":",
  "=",
  "^",
  "@",
  "<",
  ">",
  "[",
  "]",
  '"',
  "{",
  "}",
  "~",
  "\\",
  "/",
])
const decodeEscapes = (raw: string, span: Span): string => {
  let out = ""
  for (let at = 0; at < raw.length; at++) {
    if (raw[at] !== "\\") {
      out += raw[at]
      continue
    }
    if (++at >= raw.length) queryError("query.invalid-escape", span)
    if (raw[at] === "u") {
      const hex = raw.slice(at + 1, at + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) queryError("query.invalid-escape", span)
      out += String.fromCharCode(Number.parseInt(hex, 16))
      at += 4
    } else out += raw[at]
  }
  return out
}
const tokensOf = (text: string): Token[] => {
  const tokens: Token[] = []
  let at = 0
  let range = false
  while (at < text.length) {
    const start = at
    const c = text[at] ?? ""
    if (whitespace(c)) {
      at++
      continue
    }
    let kind = c
    if (c === '"' || (!range && c === "/")) {
      at++
      while (at < text.length && text[at] !== c) {
        if (text[at] === "\\" && (c === '"' || text[at + 1] === "/")) at++
        at++
      }
      if (at >= text.length) queryError("query.unclosed-literal", { start, end: at })
      at++
      if (c === "/" && /^[dgimsuvy]+(?:$|[ \t\n\r)])/.test(text.slice(at)))
        queryError(
          "query.unsupported-regex-flags",
          { start: at, end: at + 1 },
          "Lucene regex does not take JavaScript flags",
        )
      kind = c === '"' ? "quoted" : "regex"
    } else if (range && c !== "]" && c !== "}") {
      while (at < text.length && !whitespace(text[at] ?? "") && !["]", "}"].includes(text[at] ?? "")) at++
      kind = "rangeValue"
    } else if (reserved.has(c)) {
      if (c === "\\") {
        at += 2
        while (
          at < text.length &&
          !whitespace(text[at] ?? "") &&
          (!reserved.has(text[at] ?? "") || ["+", "-"].includes(text[at] ?? ""))
        )
          at++
        kind = "term"
      } else {
        at++
        if ((c === "<" || c === ">") && text[at] === "=") {
          at++
          kind += "="
        }
        if (c === "[" || c === "{") range = true
        if (c === "]" || c === "}") range = false
      }
    } else {
      at++
      while (at < text.length) {
        const next = text[at] ?? ""
        if (next === "\\") {
          if (at + 1 >= text.length) queryError("query.invalid-escape", { start: at, end: at + 1 })
          at += 2
          continue
        }
        if (whitespace(next) || (reserved.has(next) && next !== "+" && next !== "-")) break
        at++
      }
      const raw = text.slice(start, at)
      kind =
        ({ AND: "AND", OR: "OR", NOT: "NOT", "&&": "AND", "||": "OR" } as Record<string, string>)[raw] ??
        (/^\d+(?:\.\d+)?$/u.test(raw) ? "number" : "term")
    }
    tokens.push({ kind, raw: text.slice(start, at), span: { start, end: at } })
  }
  tokens.push({ kind: "EOF", raw: "", span: { start: at, end: at } })
  return tokens
}
interface Clause {
  node: QueryNode
  modifier?: "must" | "mustNot"
}
export const parseLucene = (
  text: string,
  { defaultField = "text" }: { defaultField?: "text" | "exact" } = {},
): QueryAst => {
  if (text.length > QUERY_LIMITS.bytes || new TextEncoder().encode(text).length > QUERY_LIMITS.bytes)
    queryError("query.too-large", { start: 0, end: text.length })
  const tokens = tokensOf(text)
  let at = 0
  let count = 0
  let depth = 0
  const peek = () => tokens[at] as Token
  const take = () => tokens[at++] as Token
  const expect = (kind: string) => {
    if (peek().kind !== kind) queryError("query.invalid-syntax", peek().span)
    return take()
  }
  const built = <T extends QueryNode>(node: T): T => {
    if (++count > QUERY_LIMITS.nodes) queryError("query.too-large", node.span)
    return node
  }
  const combine = (clauses: Clause[], occur: "must" | "should"): Clause => {
    const first = clauses[0]
    const last = clauses.at(-1)
    if (!first || !last) queryError("query.invalid-syntax", peek().span)
    if (clauses.length === 1) return first
    return {
      node: built({
        kind: "boolean",
        clauses: clauses.map(({ node, modifier }) => ({ node, occur: modifier ?? occur })),
        span: { start: first.node.span.start, end: last.node.span.end },
      }),
    }
  }
  const query = (field: string, implicit = false): QueryNode => {
    if (++depth > QUERY_LIMITS.depth) queryError("query.too-large", peek().span)
    const clauses: Clause[] = []
    do {
      clauses.push(disjunction(field, implicit))
    } while (!["EOF", ")"].includes(peek().kind))
    const result = combine(clauses, "must")
    depth--
    if (result.modifier === "mustNot")
      return built({ kind: "boolean", clauses: [{ node: result.node, occur: "mustNot" }], span: result.node.span })
    return result.node
  }
  const disjunction = (field: string, implicit: boolean): Clause => {
    const clauses = [conjunction(field, implicit)]
    while (peek().kind === "OR") {
      take()
      clauses.push(conjunction(field, implicit))
    }
    return combine(clauses, "should")
  }
  const conjunction = (field: string, implicit: boolean): Clause => {
    const clauses = [clause(field, implicit)]
    while (peek().kind === "AND") {
      take()
      clauses.push(clause(field, implicit))
    }
    return combine(clauses, "must")
  }
  const clause = (inherited: string, inheritedImplicit: boolean): Clause => {
    let modifier: Clause["modifier"]
    if (["+", "-", "NOT", "!"].includes(peek().kind)) modifier = take().kind === "+" ? "must" : "mustNot"
    let field = inherited
    let implicit = inheritedImplicit
    if (peek().kind === "term" && [":", "=", "<", ">", "<=", ">="].includes(tokens[at + 1]?.kind ?? "")) {
      const token = take()
      field = decodeEscapes(token.raw, token.span)
      implicit = false
      let operator = take()
      if (operator.kind === ":" && ["<", ">", "<=", ">="].includes(peek().kind)) operator = take()
      if (["<", ">", "<=", ">="].includes(operator.kind)) {
        const value = take()
        if (!["term", "number", "quoted"].includes(value.kind)) queryError("query.invalid-syntax", value.span)
        const decoded = decodeEscapes(value.kind === "quoted" ? value.raw.slice(1, -1) : value.raw, value.span)
        const lower = operator.kind.startsWith(">")
        const node = built<Predicate>({
          kind: "predicate",
          field,
          operator: "range",
          value: lower ? decoded : "*",
          upper: lower ? "*" : decoded,
          lowerInclusive: !lower || operator.kind.endsWith("="),
          upperInclusive: lower || operator.kind.endsWith("="),
          span: { start: token.span.start, end: value.span.end },
        })
        return { node, ...(modifier ? { modifier } : {}) }
      }
    }
    let node: QueryNode
    if (peek().kind === "(") {
      const start = take().span.start
      node = query(field, implicit)
      const end = expect(")").span.end
      node = { ...node, span: { start, end } }
    } else if (["[", "{"].includes(peek().kind)) {
      const opening = take()
      const lower = take()
      if (!["rangeValue", "quoted"].includes(lower.kind)) queryError("query.invalid-syntax", lower.span)
      const separator = take()
      if (separator.raw !== "TO") queryError("query.invalid-syntax", separator.span)
      const upper = take()
      if (!["rangeValue", "quoted"].includes(upper.kind)) queryError("query.invalid-syntax", upper.span)
      const closing = take()
      if (!["]", "}"].includes(closing.kind)) queryError("query.invalid-syntax", closing.span)
      const decode = (t: Token) => decodeEscapes(t.kind === "quoted" ? t.raw.slice(1, -1) : t.raw, t.span)
      node = built({
        kind: "predicate",
        field,
        operator: "range",
        value: decode(lower),
        upper: decode(upper),
        lowerInclusive: opening.kind === "[",
        upperInclusive: closing.kind === "]",
        span: { start: opening.span.start, end: closing.span.end },
      })
    } else {
      const token = take()
      if (!["term", "number", "quoted", "regex"].includes(token.kind)) queryError("query.invalid-syntax", token.span)
      const raw = ["term", "number"].includes(token.kind) ? token.raw : token.raw.slice(1, -1)
      if (field === "fn") queryError("query.unsupported-operator", token.span, "interval functions are not supported")
      const wildcard = ["term", "number"].includes(token.kind) && /(?<!\\)[*?]/u.test(raw)
      node = built({
        kind: "predicate",
        field,
        operator:
          token.kind === "regex" ? "regex" : token.kind === "quoted" ? "phrase" : wildcard ? "wildcard" : "term",
        value: token.kind === "regex" || wildcard ? raw : decodeEscapes(raw, token.span),
        span: token.span,
        ...(implicit ? { implicit: true as const } : {}),
      })
    }
    if (peek().kind === "~")
      queryError(
        "query.unsupported-operator",
        peek().span,
        node.kind === "predicate" && node.operator === "phrase"
          ? "proximity (~) is not in strict search — drop the ~ for the exact phrase, or search the words with AND"
          : "fuzzy matching (~) is not in strict search — drop the ~ and add --language legacy, which corrects typos, or use a prefix such as word* to catch word forms",
      )
    if (["^", "@"].includes(peek().kind))
      queryError("query.unsupported-operator", peek().span, "boost and minimum-should-match are not supported")
    return { node, ...(modifier ? { modifier } : {}) }
  }
  const root = query(defaultField, true)
  expect("EOF")
  return { version: 1, language: "lucene-v1", root }
}

/** Bare terms eligible for forgiving retrieval; explicit syntax keeps strict semantics. */
export const implicitTextTerms = (text: string): Set<number> => {
  const tokens = tokensOf(text)
  if (tokens.some(({ kind }) => ["AND", "OR", "NOT", "+", "-", "!", "(", ")"].includes(kind))) return new Set()
  return new Set(
    tokens.flatMap((token, index) =>
      token.kind === "term" &&
      ![":", "=", "<", ">", "<=", ">="].includes(tokens[index - 1]?.kind ?? "") &&
      ![":", "=", "<", ">", "<=", ">="].includes(tokens[index + 1]?.kind ?? "")
        ? [token.span.start]
        : [],
    ),
  )
}
