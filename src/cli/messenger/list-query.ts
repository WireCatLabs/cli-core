import {
  type FieldSpec,
  fieldsHelp,
  type Predicate,
  parseLucene,
  type QueryContext,
  type QueryRegistry,
  queryError,
  validateQuery,
} from "@wirecat/cli-base/query"

/** A list's `[query...]` as typed: words after its arguments, or one string from MCP. */
export type QueryWords = readonly string[] | string | undefined

export const queryText = (words: QueryWords): string =>
  (typeof words === "string" ? words : (words ?? []).join(" ")).trim()

/**
 * The terms of a query the provider answers. The provider takes them all together and nothing else, so a term
 * under OR or NOT is refused before any request rather than filtered here.
 */
export const requiredTerms = (words: QueryWords, registry: QueryRegistry, context: QueryContext): Predicate[] => {
  const text = queryText(words)
  if (text === "") return []
  const { root } = validateQuery(parseLucene(text, { defaultField: "none", ...context }), registry, context)
  if (root.kind === "predicate") return [root]
  return root.clauses.map(({ occur, node }) => {
    if (occur !== "must" || node.kind !== "predicate")
      queryError(
        "query.unsupported-placement",
        node.span,
        "this list takes terms that must all hold — no OR, NOT or groups",
        context,
      )
    return node
  })
}

/** Field names follow the search language, so a list and `search messages` read the same. */
export const nativeField = (field: Omit<FieldSpec, "native">): FieldSpec => ({ ...field, native: true })

export const queryHelp = (registry: QueryRegistry): string => `\n${fieldsHelp(registry)}`
