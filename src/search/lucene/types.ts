import { CliError } from "@wirecat/cli-base"
import { QUERY_LIMITS as PARSER_LIMITS, type QueryContext, queryError, type Span } from "@wirecat/cli-base/query"

export const QUERY_VERSION = 1
export const QUERY_LIMITS = {
  ...PARSER_LIMITS,
  pattern: 1024,
  states: 10_000,
  expansions: 10_000,
  candidates: 50_000,
  bodyBytes: 8_388_608,
  milliseconds: 2000,
  work: 10_000_000,
} as const
export const SEARCH_QUERY: QueryContext = {
  command: "search",
  guide: "https://github.com/WireCatLabs/cli-messaging/blob/main/docs/search/query-language.md",
}
export function searchError(reason: string, span: Span, alternative?: string): never {
  queryError(reason, span, alternative, SEARCH_QUERY)
}
export function exhausted(budget: string): never {
  throw new CliError("validation_error", `search exceeded its ${budget} budget — narrow the chat or date range`, {
    reason: "query.too-large",
    budget,
    complete: false,
  })
}
