import type { QueryNode } from "@wirecat/cli-base/query"

const WORD_FIELDS = new Set(["text", "exact"])

type Predicate = Extract<QueryNode, { kind: "predicate" }>

/**
 * What a hit found by meaning must still match: the query with each word it asks for taken as matched, since the
 * meaning half stands in for those. Words it excludes, and every other field, stay. `everything` is a predicate every
 * record of the corpus matches, as a wanted word's stand-in: an empty clause list would match nothing. `undefined`
 * when nothing but wanted words is left, so any hit found by meaning fits.
 */
export const fieldsOfQuery = (root: QueryNode, everything: Omit<Predicate, "span">): QueryNode | undefined => {
  let narrows = false
  const kept = (node: QueryNode): QueryNode => {
    if (node.kind === "boolean")
      return {
        ...node,
        clauses: node.clauses.map(({ occur, node }) => {
          if (occur !== "must_not") return { occur, node: kept(node) }
          narrows = true
          return { occur, node }
        }),
      }
    if (!WORD_FIELDS.has(node.field)) {
      narrows = true
      return node
    }
    return { ...everything, span: node.span } as QueryNode
  }
  const fields = kept(root)
  return narrows ? fields : undefined
}

/** The words and phrases the query asks for, for the meaning half to embed; none it excludes, no field. */
export const meaningWords = (root: QueryNode): string => {
  const wanted = (node: QueryNode): string[] =>
    node.kind === "boolean"
      ? node.clauses.flatMap(({ occur, node }) => (occur === "must_not" ? [] : wanted(node)))
      : WORD_FIELDS.has(node.field) && (node.operator === "term" || node.operator === "phrase")
        ? [node.value]
        : []
  return wanted(root).join(" ").trim()
}
