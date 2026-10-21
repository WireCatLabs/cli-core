import {
  defineQuery,
  type Operator,
  parseLucene,
  type QueryAst,
  type QueryNode,
  validateQuery,
} from "@wirecat/cli-base/query"

const context = {
  command: "search meetings",
  guide: "https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md#встречи",
}
const words: Operator[] = ["term", "phrase"]

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
    },
    {
      name: "exact",
      type: "txt",
      operators: words,
      example: "exact:budget",
      relation: "a passage with the word as typed: no other forms, no garbled spellings",
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

/** What a person typed: the CLI, MCP and batch queries. */
export const parseMeetingQuery = (query: string): QueryAst =>
  validateQuery(parseLucene(query, { defaultField: "text", ...context }), MEETING_HIT_QUERY, context)

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
