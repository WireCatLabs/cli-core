import { defineQuery, parseLucene, type QueryNode, queryError, validateQuery } from "@wirecat/cli-base/query"
import { LIST_QUERY_GUIDE, type QueryWords, termField, typedQuery } from "../list-query.js"
import type { RunSearch } from "./search.js"

export const RUN_SEARCH_QUERY = defineQuery({
  entity: "run",
  backend: "native",
  fields: [
    termField("text", "kw", "text:timeout"),
    termField("status", "enum", "status:failed", { values: ["success", "failed", "partial", "running"] }),
    termField("error_code", "kw", "error_code:rate_limited"),
    termField("operation", "kw", "operation:messages.download"),
    termField("profile", "kw", "profile:work"),
  ],
})

export const runSearchFilter = (
  words: QueryWords,
): Pick<RunSearch, "terms" | "status" | "errorCode" | "operation" | "profile"> => {
  const text = typedQuery(words).trim()
  if (!text) return {}
  const context = { command: "search runs", guide: LIST_QUERY_GUIDE }
  const ast = parseLucene(text, { defaultField: "text", ...context })
  validateQuery(ast, RUN_SEARCH_QUERY, context)
  const terms: string[] = []
  const fields = new Map<string, string>()
  const add = (node: QueryNode): void => {
    if (node.kind === "boolean") {
      for (const clause of node.clauses) {
        if (clause.occur !== "must")
          queryError("query.unsupported-placement", clause.node.span, "run search takes terms joined by AND", context)
        add(clause.node)
      }
      return
    }
    if (node.operator !== "term" && node.operator !== "phrase")
      queryError(
        "query.unsupported-placement",
        node.span,
        "run search takes literal words and field:value terms",
        context,
      )
    if (node.field === "text") terms.push(node.value)
    else {
      if (fields.has(node.field))
        queryError("query.unsupported-placement", node.span, `${node.field} only once here`, context)
      fields.set(node.field, node.value)
    }
  }
  add(ast.root)
  return {
    ...(terms.length ? { terms } : {}),
    ...(fields.has("status") ? { status: fields.get("status")?.toLowerCase() as RunSearch["status"] } : {}),
    ...(fields.has("error_code") ? { errorCode: fields.get("error_code") } : {}),
    ...(fields.has("operation") ? { operation: fields.get("operation") } : {}),
    ...(fields.has("profile") ? { profile: fields.get("profile") } : {}),
  }
}
