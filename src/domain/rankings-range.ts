import { CliError } from "@wirecat/cli-base"
import type { DateRange } from "../search/lucene/dates.js"
import type { ResolvedNode, ResolvedPredicate } from "../search/lucene/resolved.js"

/** A common positive date range bounds reply events independently of author/body filters. */
export const rankingContextRange = (root: ResolvedNode): DateRange | undefined => {
  const dates: { node: ResolvedPredicate; required: boolean }[] = []
  const visit = (node: ResolvedNode, required: boolean) => {
    if (node.kind === "predicate") {
      if (node.field === "date") dates.push({ node, required })
      return
    }
    const must = node.clauses.some(({ occur }) => occur === "must")
    const positive = node.clauses.filter(({ occur }) => occur === "should")
    for (const clause of node.clauses)
      visit(
        clause.node,
        required && (clause.occur === "must" || (!must && positive.length === 1 && clause.occur === "should")),
      )
  }
  visit(root, true)
  if (dates.length === 0) return undefined
  if (dates.length !== 1 || !dates[0]?.required || !dates[0].node.resolution?.date)
    throw new CliError(
      "validation_error",
      "reply rankings need one common positive date range; move date: outside Boolean alternatives",
      { reason: "period.ambiguous" },
    )
  return dates[0].node.resolution.date
}
