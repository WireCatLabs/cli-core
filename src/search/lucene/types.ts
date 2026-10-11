import { CliError } from "@wirecat/cli-base"

export const QUERY_VERSION = 1
export const QUERY_LIMITS = {
  bytes: 8192,
  depth: 32,
  nodes: 256,
  pattern: 1024,
  states: 10_000,
  expansions: 10_000,
  candidates: 50_000,
  bodyBytes: 8_388_608,
  milliseconds: 2000,
  work: 10_000_000,
} as const
export type Span = { start: number; end: number }
export type Occur = "must" | "should" | "mustNot"
export type Operator = "term" | "phrase" | "wildcard" | "regex" | "range"
export interface Predicate {
  kind: "predicate"
  field: string
  operator: Operator
  value: string
  upper?: string
  lowerInclusive?: boolean
  upperInclusive?: boolean
  span: Span
}
export type QueryNode = Predicate | { kind: "boolean"; clauses: { occur: Occur; node: QueryNode }[]; span: Span }
export interface QueryAst {
  version: 1
  language: "lucene-v1"
  root: QueryNode
}
export function queryError(reason: string, span: Span, alternative?: string): never {
  throw new CliError(
    "validation_error",
    `search: ${reason} at position ${span.start + 1}${alternative ? ` — ${alternative}` : ""}`,
    {
      reason,
      span,
      ...(alternative ? { alternative } : {}),
      guide: "https://github.com/WireCatLabs/cli-messaging/blob/main/docs/search/query-language.md",
    },
  )
}
export function exhausted(budget: string): never {
  throw new CliError("validation_error", `search exceeded its ${budget} budget — narrow the chat or date range`, {
    reason: "query_limit",
    budget,
    complete: false,
  })
}
export const walkQuery = (node: QueryNode): Predicate[] =>
  node.kind === "predicate" ? [node] : node.clauses.flatMap(({ node }) => walkQuery(node))
