import { CliError, isCliError } from "@wirecat/cli-base"
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
/** Time to print a search's own time-limit answer before the run's deadline cuts it. */
const ANSWER_MS = 1000
/**
 * A search's time limit: the default keeps agents and MCP to 2 s; a run whose caller set a time limit itself
 * (Desktop's `--timeout 30s`) may use it, less the time to answer.
 */
export const searchTimeLimit = (deadline: { endsAt: number; explicit?: true } | undefined, now = Date.now()) =>
  deadline?.explicit ? Math.max(QUERY_LIMITS.milliseconds, deadline.endsAt - now - ANSWER_MS) : undefined
/**
 * The search ran out of time, not the query out of bounds: a valid query over a large store. `timeout`, so a caller
 * does not tell the person to fix what they typed.
 */
export function outOfTime(limitMs: number = QUERY_LIMITS.milliseconds): never {
  throw new CliError(
    "timeout",
    `search stopped at its time limit of ${limitMs / 1000}s — the query is valid; ` +
      "add chat: or date: to search less of the store",
    { reason: "query.time-limit", budget: "time", limit_ms: limitMs, complete: false },
  )
}
/** A search limit that leaves the answer without a part, such as its total, rather than failing it. */
export const isQueryLimit = (error: unknown): boolean =>
  isCliError(error) && (error.details.reason === "query.too-large" || error.details.reason === "query.time-limit")
export function exhausted(budget: string): never {
  throw new CliError("validation_error", `search exceeded its ${budget} budget — narrow the chat or date range`, {
    reason: "query.too-large",
    budget,
    complete: false,
  })
}

/** A pattern checked word by word over more messages than a search may read: what to write instead. */
export function tooWideTerm([term]: string[], budget: string): never {
  if (term === undefined) exhausted(budget)
  const part =
    term
      .replace(/[*?]+/gu, " ")
      .trim()
      .split(/\s+/u)
      .sort((a, b) => b.length - a.length)[0] ?? term
  throw new CliError(
    "validation_error",
    `search exceeded its ${budget} budget: ${term} is checked word by word, and too many messages hold it — ` +
      `write *${part}* (any word holding it, read from the index), more of the word, or add chat: or date:`,
    { reason: "query.too-large", budget, term, complete: false },
  )
}
