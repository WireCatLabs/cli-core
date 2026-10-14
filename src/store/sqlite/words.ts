import { normalize } from "../normalize.js"
import type { StoredHit } from "../store.js"
import type { StoreContext } from "./open.js"

/** A hit with its relevance — bm25 turned round so higher is better; `null` from steps that do not rank. */
/** `exact: false`: a stemmed search found it only through another form of the words. */
export type ScoredHit = StoredHit & {
  score: number | null
  exact?: boolean
  /** Where the words were: the message's text, a voice note's transcript, a file's name or a file's text. */
  matchedIn?: MatchPlace
  /** The text of that place, for the excerpt; never part of an answer. */
  matchedText?: string
}
export type MatchPlace = "text" | "transcript" | "filename" | "file"

const VOCABULARY = "SELECT term, doc FROM message_words_vocab WHERE col = 'normalized_text'"

/**
 * The words the index knows, of those given: a whole word, or the beginning of one — otherwise
 * `квартир` would be "corrected" to `квартира` and lose `квартиру` (plan S4).
 */
export const knownTerms = ({ database }: StoreContext, terms: string[]): Set<string> => {
  const lookup = database.prepare(`${VOCABULARY} AND term >= ? AND term <= ? LIMIT 1`)
  return new Set(
    terms.filter((term) => {
      const word = normalize(term)
      return lookup.get(word, `${word}\u{10FFFF}`) !== undefined
    }),
  )
}

/**
 * Words sharing trigrams with `term`, between the lengths given, most shared first — and only those
 * the index still has, so a word whose messages were all deleted never comes back (plan S7).
 */
export const termCandidates = (
  { database }: StoreContext,
  pieces: string[],
  { shortest, longest }: { shortest: number; longest: number },
): { term: string; docs: number }[] => {
  if (pieces.length === 0) return []
  const candidates = database
    .prepare(
      `SELECT term, count(*) AS shared FROM search_term_trigrams
       WHERE trigram IN (${pieces.map(() => "?").join(", ")}) AND length BETWEEN ? AND ?
       GROUP BY term ORDER BY shared DESC, term LIMIT 200`,
    )
    .all(...pieces, shortest, longest)
  const docs = database.prepare(`${VOCABULARY} AND term = ?`)
  return candidates.flatMap((row) => {
    const held = docs.get(String(row.term))
    return held ? [{ term: String(row.term), docs: Number(held.doc) }] : []
  })
}
