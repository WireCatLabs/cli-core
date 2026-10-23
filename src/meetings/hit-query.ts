import { CliError } from "@wirecat/cli-base"
import {
  dateRange,
  defineQuery,
  type Operator,
  type Predicate,
  parseLucene,
  type QueryAst,
  type QueryNode,
  queryError,
  timezoneOf,
  validateQuery,
} from "@wirecat/cli-base/query"
import type { MeetingHitSearchRequest } from "./search-store.js"

const context = {
  command: "search meetings",
  guide: "https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md#встречи",
}
const words: Operator[] = ["term", "phrase"]
/** A transcript line holds a sentence or two; further than this is a different part of the meeting. */
export const MOST_LINES_APART = 20
const near = (node: Predicate): void => {
  if (node.slop !== undefined && node.slop > MOST_LINES_APART)
    queryError(
      "query.invalid-number",
      node.span,
      `words at most ${MOST_LINES_APART} lines apart: "a b"~${MOST_LINES_APART}`,
      context,
    )
}

/** The messages query language over meeting text: the same fields, a narrower set of operators. */
export const MEETING_HIT_QUERY = defineQuery({
  entity: "meeting_hit",
  backend: "sql",
  fields: [
    {
      name: "text",
      type: "txt",
      operators: words,
      example: "text:budget",
      relation: "a passage with the word in any form, or a spelling speech recognition garbled",
      validate: near,
    },
    {
      name: "exact",
      type: "txt",
      operators: words,
      example: "exact:budget",
      relation: "a passage with the word as typed: no other forms, no garbled spellings",
      validate: near,
    },
    {
      name: "from",
      type: "kw",
      operators: words,
      example: 'from:"Alice Synthetic"',
      relation: "a line said or a chat message written by this person; attendance is --identity-id",
    },
  ],
})

/** Fields that choose meetings rather than lines: lifted out of the query into the search's own filters. */
const MEETING_FIELDS = defineQuery({
  entity: "meeting_hit",
  backend: "sql",
  fields: [
    ...MEETING_HIT_QUERY.fields,
    {
      name: "date",
      type: "time",
      operators: ["term", "range"],
      example: "date>=30d",
      relation: "meetings that started then; the same as --since-time and --until-time",
    },
    ...(["project", "tag", "topic"] as const).map((name) => ({
      name,
      type: "kw" as const,
      operators: words,
      example: `${name}:"Example name"`,
      relation: `meetings in this ${name}, by name or alias; the same as --${name}`,
    })),
  ],
})
const LIFTED = new Set(["date", "project", "tag", "topic"])

/**
 * `budget project:RES date>=30d` → the words, and the meetings to look in as filters. A meeting field must be
 * joined to the words with AND and given once, in the query or as an option. Text the language refuses is left as
 * typed, for the caller's own error or for a search by meaning.
 */
export const liftMeetingFields = (
  query: string,
  request: MeetingHitSearchRequest,
  now?: number,
): { query: string; request: MeetingHitSearchRequest } => {
  let ast: QueryAst
  try {
    ast = validateQuery(
      parseLucene(query, { defaultField: "text", proximity: true, ...context }),
      MEETING_FIELDS,
      context,
    )
  } catch (error) {
    if (error instanceof CliError) return { query, request }
    throw error
  }
  const top = ast.root.kind === "boolean" ? ast.root.clauses : [{ occur: "must" as const, node: ast.root }]
  const lifted = top.filter(
    (clause): clause is { occur: "must"; node: Predicate } =>
      clause.node.kind === "predicate" && LIFTED.has(clause.node.field),
  )
  const misplaced = (node: QueryNode, nested: boolean): Predicate | undefined =>
    node.kind === "predicate"
      ? nested && LIFTED.has(node.field)
        ? node
        : undefined
      : node.clauses.map((clause) => misplaced(clause.node, true)).find(Boolean)
  const wrong =
    lifted.find((clause) => clause.occur !== "must")?.node ??
    top.map((clause) => (clause.node.kind === "boolean" ? misplaced(clause.node, true) : undefined)).find(Boolean)
  if (wrong)
    queryError(
      "query.unsupported-field",
      wrong.span,
      `${wrong.field}: chooses meetings; join it to the words with AND, outside OR, NOT and groups`,
      context,
    )
  if (!lifted.length) return { query, request }
  const next: MeetingHitSearchRequest = { ...request }
  const once = (name: keyof MeetingHitSearchRequest, flag: string) => {
    if (next[name] !== undefined)
      throw new CliError("validation_error", `give ${flag.replace(/^--/, "")} once: as ${flag} or in the query`)
  }
  for (const { node } of lifted) {
    if (node.field === "date") {
      once("since", "--since-time")
      once("until", "--until-time")
      const range = dateRange(
        node.value,
        node.operator === "range" ? (node.upper ?? "*") : node.value,
        node.lower_inclusive !== false,
        node.upper_inclusive !== false,
        timezoneOf(),
        node.span,
        now,
      )
      if (range.lower !== undefined) next.since = range.lower + (range.lower_inclusive ? 0 : 1)
      if (range.upper !== undefined) next.until = range.upper - (range.upper_inclusive ? 0 : 1)
    } else {
      const field = node.field as "project" | "tag" | "topic"
      once(field, `--${field}`)
      next[field] = node.value
    }
  }
  let rest = query
  for (const { node } of [...lifted].sort((a, b) => b.node.span.start - a.node.span.start))
    rest = `${rest.slice(0, node.span.start)}${rest.slice(node.span.end)}`
  rest = rest
    .replace(/^(?:\s*AND\b)+|(?:\bAND\s*)+$/g, "")
    .replace(/\bAND(\s+AND\b)+/g, "AND")
    .trim()
  if (!rest) throw new CliError("validation_error", "give words to find besides date:, project:, tag: and topic:")
  return { query: rest, request: next }
}

/** What a person typed: the CLI, MCP and batch queries. */
export const parseMeetingQuery = (query: string): QueryAst =>
  validateQuery(parseLucene(query, { defaultField: "text", proximity: true, ...context }), MEETING_HIT_QUERY, context)

/**
 * Words from a name or a note, never parsed: a project called «C++ (beta)» must not become syntax. Each word is
 * required, in any form.
 */
export const meetingWordsQuery = (text: string): QueryAst => {
  const found = text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
  const span = { start: 0, end: text.length }
  const clauses = found.map((value) => ({
    occur: "must" as const,
    node: { kind: "predicate" as const, field: "text", operator: "term" as const, value, span },
  }))
  const root: QueryNode = clauses.length === 1 && clauses[0] ? clauses[0].node : { kind: "boolean", clauses, span }
  return { version: 1, language: "lucene-v1", root }
}
