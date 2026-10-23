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
  guide: "https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md",
}
/** How message search parses typed text: `"a b"~N` is words at most N apart; notes still refuse `~`. */
export const MESSAGE_PARSING = { ...SEARCH_QUERY, proximity: true }
/** Further apart than this, two words are rarely about one thing, even in a long message. */
export const MOST_WORDS_APART = 50
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
