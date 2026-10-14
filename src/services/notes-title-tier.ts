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

/** The `title:` terms that find every title holding all the words, in any order, and so every phrase match too. */
export const titleQuery = (words: string): string =>
  words
    .split(" ")
    .map((word) => `title:"${word}"`)
    .join(" AND ")

/** Titles equal to the words, then titles holding them as a phrase, then titles holding them apart; each keeps its order. */
export const titleTiers = <T extends { note: Note }>(hits: T[], words: string): T[] => {
  const rank = ({ note }: T) => {
    const title = normalize(note.title ?? "")
    return title === words ? 0 : title.includes(words) ? 1 : 2
  }
  return [...hits].sort((a, b) => rank(a) - rank(b))
}
