import { CliError } from "@wirecat/cli-base"
import { parseLucene } from "@wirecat/cli-base/query"
import { RRF_K } from "../search/fusion.js"
import { meaningWords } from "../search/lucene/meaning-parts.js"
import { SEARCH_QUERY } from "../search/lucene/types.js"
import type { Period } from "../search/question-period.js"
import { isFunctionWord, words as plainWords } from "../search/question-plan.js"
import type { SearchAllItem, SearchAllRecordItem } from "./search-all.js"

/**
 * What a deal or a lead is found by: plain words or phrases, all of them, or any with OR. Anything else is refused,
 * so `search all` skips deals with the reason instead of matching a field they do not have.
 */
export const titleWords = (
  text: string,
  refused = "deals and leads are found by the words of their title, company, contacts and activities only",
): { words: string[]; anyWord: boolean } => {
  const { root } = parseLucene(text, SEARCH_QUERY)
  const clauses = root.kind === "boolean" ? root.clauses : [{ node: root, occur: "must" as const }]
  const words = clauses.map(({ node, occur }) =>
    occur !== "must_not" &&
    node.kind === "predicate" &&
    (node.field === "text" || node.field === "title") &&
    (node.operator === "term" || node.operator === "phrase")
      ? // A title holds "invoice", not the question mark of "invoice?".
        node.value.replace(/\?+$/u, "") || node.value
      : (() => {
          throw new CliError("validation_error", refused)
        })(),
  )
  return { words, anyWord: clauses.length > 1 && clauses.every(({ occur }) => occur === "should") }
}

/** A question finds by any of its words, so «что», «кто» or "the" would match nearly every record. */
export const contentWords = (found: { words: string[]; anyWord: boolean }, discover: boolean) => {
  if (!discover) return found
  const content = found.words.filter((word) => !plainWords(word).every(isFunctionWord))
  return content.length ? { ...found, words: content } : found
}

/**
 * What the meaning half embeds: the words and phrases asked for, OR included, as notes take them. `title:` narrows to
 * the title, which a hit by meaning cannot be held to, so such a query is searched by words only.
 */
export const meaningWordsOf = (text: string): string | undefined => {
  try {
    const { root } = parseLucene(text, SEARCH_QUERY)
    const nodes = root.kind === "boolean" ? root.clauses.map(({ node }) => node) : [root]
    if (!nodes.every((node) => node.kind === "predicate" && node.field === "text")) return undefined
    return meaningWords(root) || undefined
  } catch {
    return undefined
  }
}

/**
 * One list for a lane found both ways, as notes and messages fuse theirs: each hit's rank in either list votes, a
 * question's hit voting once; a hit found both ways keeps its words' text and is found by meaning too.
 */
export const fusedLane = (
  byWords: SearchAllRecordItem[],
  byMeaning: { hit: SearchAllRecordItem; score: number }[],
  discover: boolean,
  cosines: Map<string, number>,
): SearchAllRecordItem[] => {
  const fused = new Map<string, { item: SearchAllRecordItem; score: number }>()
  byWords.forEach((item, rank) => {
    fused.set(item.ref, { item, score: 1 / (RRF_K + rank + 1) })
  })
  byMeaning.forEach(({ hit, score }, rank) => {
    cosines.set(hit.ref, score)
    const held = fused.get(hit.ref)
    if (held && !held.item.foundBy.includes("meaning")) held.item.foundBy = [...held.item.foundBy, "meaning"]
    const vote = 1 / (RRF_K + rank + 1)
    if (held && discover) held.score = Math.max(held.score, vote)
    else fused.set(hit.ref, { item: held?.item ?? hit, score: (held?.score ?? 0) + vote })
  })
  return [...fused.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
}

/** Passages of one meeting share its `ref`, the reference evidence cites; each is still a hit of its own. */
const hitKey = (item: SearchAllItem): string =>
  item.kind === "meeting" ? `${item.ref}\u0000${item.scope}\u0000${item.id}` : item.ref

/**
 * Every source's hits as one list: each source's best hit first, then every other hit by cosine, then by its rank in
 * its source. Taking turns by rank (MEMO-37) gave each of two sources half of a ten-hit page however weak its hits;
 * one model scores every source, so cosine compares across them. A hit only words found takes the cosine of
 * the hit above it in its source: its source ranked it there, and with none it would follow every hit meaning found.
 */
export const oneList = (lists: SearchAllItem[][], cosines: Map<string, number>): SearchAllItem[] => {
  const place = new Map<string, { item: SearchAllItem; rank: number; cosine: number }>()
  for (const list of lists) {
    let above = Number.NEGATIVE_INFINITY
    list.forEach((item, rank) => {
      const key = hitKey(item)
      above = cosines.get(item.ref) ?? above
      const held = place.get(key)
      if (!held || rank < held.rank) place.set(key, { item, rank, cosine: above })
    })
  }
  const head = (rank: number) => Math.min(rank, 1)
  return [...place.values()]
    .sort((a, b) => head(a.rank) - head(b.rank) || b.cosine - a.cosine || a.rank - b.rank)
    .map(({ item }) => item)
}

export const PERIOD_DEPTH = 100
const PERIOD_BOOST = 0.5

/**
 * A hit dated inside the question's period gains 0.5 over its place, 1 - rank/100: by rank, because only some hits have
 * a cosine to compare. One scale for every page, so paging past the first 100 never reorders what came before.
 */
export const insidePeriodFirst = (ordered: SearchAllItem[], period: Period | undefined): SearchAllItem[] => {
  if (!period) return ordered
  const inside = ({ timestamp }: SearchAllItem) => {
    const at = timestamp === null ? Number.NaN : Date.parse(timestamp)
    return at >= period.from && at < period.to
  }
  return ordered
    .map((item, rank) => ({ item, score: 1 - rank / PERIOD_DEPTH + (inside(item) ? PERIOD_BOOST : 0) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
}
