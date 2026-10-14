import { parseLucene } from "@wirecat/cli-base/query"
import { SEARCH_QUERY } from "../search/lucene/types.js"
import type { Note } from "../store/index.js"
import { normalize } from "../store/normalize.js"

/**
 * The words of a query that is only words and quoted phrases, or `undefined` when it uses any other syntax
 * (a field, OR, NOT, a wildcard, a regex, a group) or does not parse. Such a query names no title.
 */
export const plainQueryWords = (query: string): string | undefined => {
  let root: ReturnType<typeof parseLucene>["root"]
  try {
    root = parseLucene(`(${query})`, { ...SEARCH_QUERY, defaultField: "text" }).root
  } catch {
    return undefined
  }
  const leaves =
    root.kind === "predicate" ? [root] : root.clauses.map(({ occur, node }) => (occur === "must" ? node : null))
  const values: string[] = []
  for (const leaf of leaves) {
    if (
      leaf?.kind !== "predicate" ||
      leaf.implicit !== true ||
      (leaf.operator !== "term" && leaf.operator !== "phrase")
    )
      return undefined
    values.push(leaf.value)
  }
  const words = normalize(values.join(" "))
  return words === "" || /["\\]/u.test(words) ? undefined : words
}

/** Titles equal to the words come before titles that only hold them; each keeps its order. */
export const equalTitlesFirst = <T extends { note: Note }>(hits: T[], words: string): T[] => [
  ...hits.filter(({ note }) => normalize(note.title ?? "") === words),
  ...hits.filter(({ note }) => normalize(note.title ?? "") !== words),
]
