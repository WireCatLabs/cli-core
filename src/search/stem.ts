import { CliError } from "@wirecat/cli-base"
import { normalize } from "../store/normalize.js"
import { type Language, type LanguageOf, languagesOf } from "./languages.js"
import EnglishStemmer from "./snowball/english-stemmer.js"
import RussianStemmer from "./snowball/russian-stemmer.js"
import SpanishStemmer from "./snowball/spanish-stemmer.js"

/** The version of the vendored files in `./snowball/`; `bin/snowball-update` regenerates them. */
export const SNOWBALL_VERSION = "3.1.1"

export type CyrillicStemmer = LanguageOf<"cyrillic"> | "none"
export type LatinStemmer = LanguageOf<"latin"> | "none"
export const CYRILLIC_STEMMERS: readonly CyrillicStemmer[] = [...languagesOf("cyrillic"), "none"]
export const LATIN_STEMMERS: readonly LatinStemmer[] = [...languagesOf("latin"), "none"]
/** `latin` is one stemmer, `none`, or several joined by commas in alphabetical order (`english,spanish`). */
export type Stemmers = { cyrillic: CyrillicStemmer; latin: string }

export const DEFAULT_STEMMERS: Stemmers = { cyrillic: "russian", latin: "english,spanish" }
/**
 * Raised with every change to `DEFAULT_STEMMERS`. A default saved in the store carries it, so a newer build
 * replaces an older default and an older build never rebuilds a newer one back.
 */
export const DEFAULT_STEMMERS_VERSION = 2

/**
 * Between the stem sequences of one text when several Latin stemmers give different ones, so a phrase
 * never matches across two sequences. Letters and digits, so `unicode61` keeps it as one token.
 */
export const STEM_SEPARATOR = "0stemsep0"

/** Clear-all rather than LRU: the 1M benchmark corpus holds 523k distinct words, and a Map stays cheap below this. */
export const STEM_CACHE_LIMIT = 200_000

/** Recorded beside an index built with these choices; a different value means the index must be rebuilt. */
export const analyzerIdentity = (stemmers: Stemmers): string =>
  `snowball-${SNOWBALL_VERSION} cyrillic=${stemmers.cyrillic} latin=${stemmers.latin}`

/** Checks choices that come from outside the type system — the store, a config value, an MCP argument. */
export const parseStemmers = (value: unknown): Stemmers => {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  const pick = <T extends string>(script: string, allowed: readonly T[], fallback: T): T => {
    const choice = record[script] ?? fallback
    if (allowed.includes(choice as T)) return choice as T
    throw new CliError(
      "validation_error",
      `${script} words cannot be stemmed with ${JSON.stringify(choice)} — choose ${allowed.join(", ")}`,
      { reason: "stemmer.invalid", script, allowed: [...allowed] },
    )
  }
  return {
    cyrillic: pick("cyrillic", CYRILLIC_STEMMERS, DEFAULT_STEMMERS.cyrillic),
    latin: latinOf(record.latin ?? DEFAULT_STEMMERS.latin),
  }
}

const latinOf = (value: unknown): string => {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((part) => part.trim())
      : [value]
  const unknown = parts.find((part) => !LATIN_STEMMERS.includes(part as LatinStemmer))
  const named = [...new Set(parts as LatinStemmer[])].filter((part) => part !== "none").sort()
  if (unknown !== undefined || parts.length === 0 || (named.length > 0 && parts.includes("none")))
    throw new CliError(
      "validation_error",
      `latin words cannot be stemmed with ${JSON.stringify(value)} — choose none, or one or more of english, spanish joined by commas`,
      { reason: "stemmer.invalid", script: "latin", allowed: [...LATIN_STEMMERS] },
    )
  return named.length ? named.join(",") : "none"
}

/** What FTS5 `unicode61` keeps inside a token: letters, digits, private use, and combining marks. */
const TOKEN = /[\p{L}\p{N}\p{Co}\p{M}]+/gu
const MARKS = /\p{M}+/gu
const CYRILLIC = /^\p{Script=Cyrillic}+$/u
const LATIN = /^\p{Script=Latin}+$/u

const snowball: Record<Language | "none", () => { stemWord(word: string): string } | null> = {
  russian: () => new RussianStemmer(),
  spanish: () => new SpanishStemmer(),
  english: () => new EnglishStemmer(),
  none: () => null,
}

export type Stemmer = {
  readonly stemmers: Stemmers
  readonly identity: string
  /** The indexed form of one token: stemmed by the script of its letters, then folded with `normalize()`. */
  stemToken(token: string): string
  /** `stemToken` over every word of a text, split as `unicode61` splits it; tokens that fold to nothing are dropped. */
  stemTokens(text: string): string[]
  /** One stem sequence per Latin stemmer, the identical ones once; a text without Latin words has one. */
  stemSequences(text: string): string[][]
  /** What the stem index stores for a text: its sequences, apart by `STEM_SEPARATOR`. */
  indexText(text: string): string
  /** An FTS5 expression for a text as phrases of stems, one per sequence; `undefined` when no word stems. */
  phrases(text: string): string | undefined
  /** Each word of a text with its stem and the stemmer its script chose — what a search answer shows. */
  explain(text: string): { word: string; stem: string; stemmer: CyrillicStemmer | LatinStemmer }[]
}

/**
 * One stemmer per fill run or write drain: it owns its cache, so a cache never outlives the choices it was
 * built with. A token is stemmed only when all its letters are of one script and it has no digit: mixed scripts
 * (`Москвa` with a Latin `a`) are usually homoglyph spoofing or code, and `covid19` is a name, not a word form.
 * Ukrainian and other Cyrillic languages go through the Russian stemmer — there is no language detection.
 */
export const createStemmer = (
  stemmers: Stemmers = DEFAULT_STEMMERS,
  { cacheLimit = STEM_CACHE_LIMIT }: { cacheLimit?: number } = {},
): Stemmer => {
  const valid = parseStemmers(stemmers)
  const cyrillic = snowball[valid.cyrillic]()
  const latinNames = valid.latin.split(",") as LatinStemmer[]
  const latins = latinNames.map((name) => snowball[name]())
  const cache = new Map<string, string>()

  const compute = (token: string, variant: number): string => {
    // Stress marks survive NFC (кварти́ру) and would hide the suffix from Snowball; ё and й compose and stay.
    const word = token.normalize("NFC").toLowerCase().replace(MARKS, "")
    const engine = CYRILLIC.test(word) ? cyrillic : LATIN.test(word) ? (latins[variant] ?? null) : null
    const stem = engine?.stemWord(word) || word
    return normalize(stem)
  }

  const stemOf = (token: string, variant: number): string => {
    const key = variant === 0 ? token : `${variant}\u0000${token}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const stem = compute(token, variant)
    if (cache.size >= cacheLimit) cache.clear()
    if (cacheLimit > 0) cache.set(key, stem)
    return stem
  }
  const stemToken = (token: string): string => stemOf(token, 0)
  const tokensOf = (text: string) => text.normalize("NFC").toLowerCase().match(TOKEN) ?? []

  const stemSequences = (text: string): string[][] => {
    const tokens = tokensOf(text)
    const seen = new Set<string>()
    return latins.flatMap((_, variant) => {
      const sequence = tokens.map((token) => stemOf(token, variant)).filter(Boolean)
      const key = sequence.join(" ")
      if (seen.has(key)) return []
      seen.add(key)
      return [sequence]
    })
  }

  return {
    stemmers: valid,
    identity: analyzerIdentity(valid),
    stemToken,
    stemTokens: (text) => tokensOf(text).map(stemToken).filter(Boolean),
    stemSequences,
    indexText: (text) =>
      stemSequences(text)
        .map((sequence) => sequence.join(" "))
        .filter(Boolean)
        .join(` ${STEM_SEPARATOR} `),
    phrases: (text) => {
      const phrases = stemSequences(text)
        .filter((sequence) => sequence.length > 0)
        .map((sequence) => `"${sequence.join(" ").replaceAll('"', '""')}"`)
      return phrases.length ? phrases.join(" OR ") : undefined
    },
    explain: (text) =>
      tokensOf(text).flatMap((word) => {
        const bare = word.replace(MARKS, "")
        const script = CYRILLIC.test(bare) ? "cyrillic" : LATIN.test(bare) ? "latin" : "none"
        const variants =
          script === "latin"
            ? latinNames.map((name, variant) => ({ name, variant }))
            : [{ name: script === "cyrillic" ? valid.cyrillic : "none", variant: 0 }]
        const seen = new Set<string>()
        return variants.flatMap(({ name, variant }) => {
          const stem = stemOf(word, variant)
          if (!stem || seen.has(stem)) return []
          seen.add(stem)
          return [{ word, stem, stemmer: name as CyrillicStemmer | LatinStemmer }]
        })
      }),
  }
}
