import { fold } from "../store/normalize.js"
import { createStemmer, DEFAULT_STEMMERS, START_LETTERS } from "./stem.js"

/**
 * Word matching over text read into memory, for the stores that keep no stem index: a query word matches a stored word
 * that is the same, one it begins (`START_LETTERS` letters or more; shorter words only as whole words: «с» or "a"
 * begins half the words of any title), or one of the same stem by the default Snowball stemmers.
 */
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu
const stemmer = createStemmer(DEFAULT_STEMMERS, { cacheLimit: 20_000 })
export const stemsOf = (token: string): string[] => stemmer.stemSequences(token).flat()

export type StoredWord = { token: string; literal: string }
export type Probe = { literal: string; stems: string[] }
/** One word of a query clause, with the corrections that may stand for it. */
export type QueryWord = Probe[]

export const probeOf = (token: string): Probe => ({ literal: fold(token), stems: stemsOf(token) })
export const tokensOf = (text: string): string[] => text.normalize("NFC").toLowerCase().match(TOKEN) ?? []

export const wordMatches = (probe: Probe, word: StoredWord, exact: boolean): boolean => {
  if (word.literal === probe.literal) return true
  if (exact) return false
  if (probe.literal.length >= START_LETTERS && word.literal.startsWith(probe.literal)) return true
  // A stem begins its word, so a word that does not start like the stem needs no stemming.
  return (
    probe.stems.some((stem) => word.literal.startsWith(stem.slice(0, 3))) &&
    stemsOf(word.token).some((stem) => probe.stems.includes(stem))
  )
}

/** A clause of several words, `КТП-630` or an e-mail, matches only where they follow each other. */
export const clauseIn = (clause: QueryWord[], words: StoredWord[], exact: boolean): boolean =>
  words.some((_, at) =>
    clause.every((alternatives, offset) => {
      const word = words[at + offset]
      return word !== undefined && alternatives.some((probe) => wordMatches(probe, word, exact))
    }),
  )
