import type { SearchCoverage } from "../../services/messages-search.js"

const count = new Intl.NumberFormat("en")

/**
 * One line on what the archive held for a search, when it could hold more or nothing was found:
 * "searched 12,430 messages in 37 chats — 5 never fetched, 2 behind". The command that fetches more is a next step.
 */
export const archiveSummary = (coverage: SearchCoverage, hits: number): string | undefined => {
  const { neverFetched, behind, withGaps } = coverage.chats
  if (!neverFetched && !behind && !withGaps && hits > 0) return undefined
  const problems = [
    neverFetched ? `${neverFetched} never fetched` : "",
    behind ? `${behind} behind` : "",
    withGaps ? `${withGaps} with gaps` : "",
  ].filter(Boolean)
  const searched = `searched ${count.format(coverage.messages)} messages in ${count.format(coverage.coveredChats)} chats`
  return `${searched}${problems.length ? ` — ${problems.join(", ")}` : ""}`
}
