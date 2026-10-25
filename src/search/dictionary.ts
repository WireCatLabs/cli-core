import { readFileSync } from "node:fs"
import { fold } from "../store/normalize.js"
import { LANGUAGES, type Language } from "./languages.js"

interface Affix {
  flag: string
  strip: string
  condition: RegExp
  cross: boolean
}
interface Dictionary {
  /** A folded word → its flags. */
  words: Map<string, string>
  suffixes: Map<string, Affix[]>
  prefixes: Map<string, Affix[]>
  longest: number
}

/** The Hunspell dictionary that tells a real word from a garbled one, for each language the store stems. */
export const DICTIONARIES = Object.fromEntries(LANGUAGES.map(({ name, dictionary }) => [name, dictionary])) as Record<
  Language,
  string
>
export type DictionaryLanguage = Language

/** `fold`, without Unicode normalisation for plain Russian letters: it would double the time Russian loads in. */
const folded = (word: string): string =>
  /^[а-яё'-]*$/.test(word) ? word.replaceAll("ё", "е").replaceAll("й", "и") : fold(word)

const loaded = new Map<DictionaryLanguage, Dictionary>()

/**
 * Hunspell's own check, an affix at a time, instead of nspell's: nspell expands Russian's 146,269 entries into
 * 1.44 million forms (1.4 s, 172 MB) where this loads in about 0.2 s. The index stores words folded as `normalize`
 * folds them, so entries, affixes and conditions are folded too; a condition such as `[^ейоь]` then refuses и as
 * well, which changed none of 12,769 sample words. Continuation classes and compounds are not followed: a word
 * only they make counts as unknown and may widen.
 */
const dictionary = (language: DictionaryLanguage): Dictionary => {
  const cached = loaded.get(language)
  if (cached) return cached
  const file = (name: string) => readFileSync(new URL(name, import.meta.resolve(DICTIONARIES[language])), "utf8")
  const words = new Map<string, string>()
  for (const line of file("index.dic").split("\n").slice(1)) {
    const [entry, flags = ""] = line.trim().split("/")
    if (!entry) continue
    // Names and abbreviations are capitalised in the dictionary; the index is lower case.
    const spelled = entry.toLowerCase()
    const key = folded(spelled)
    words.set(key, (words.get(key) ?? "") + flags)
  }
  const suffixes = new Map<string, Affix[]>()
  const prefixes = new Map<string, Affix[]>()
  const crosses = new Set<string>()
  let longest = 0
  for (const line of file("index.aff").split("\n")) {
    const [kind, flag, strip, add, condition] = line.trim().split(/\s+/)
    if ((kind !== "SFX" && kind !== "PFX") || flag === undefined || strip === undefined || add === undefined) continue
    if (!condition) {
      if (strip === "Y") crosses.add(`${kind}${flag}`)
      continue
    }
    const affix = folded((add.split("/")[0] as string).replace(/^0$/, ""))
    const pattern = condition === "." ? "" : folded(condition)
    const into = kind === "SFX" ? suffixes : prefixes
    const rules = into.get(affix) ?? []
    rules.push({
      flag,
      strip: strip === "0" ? "" : folded(strip),
      condition: new RegExp(kind === "SFX" ? `${pattern}$` : `^${pattern}`),
      cross: crosses.has(`${kind}${flag}`),
    })
    into.set(affix, rules)
    longest = Math.max(longest, affix.length)
  }
  const made = { words, suffixes, prefixes, longest }
  loaded.set(language, made)
  return made
}

const entry = ({ words }: Dictionary, key: string, rule: Affix, also?: string): boolean => {
  const flags = words.get(key) ?? ""
  return flags.includes(rule.flag) && (also === undefined || flags.includes(also)) && rule.condition.test(key)
}

/** A suffix on a dictionary word; `prefix` is the flag of a prefix already taken off, which both must allow. */
const suffixed = (found: Dictionary, word: string, prefix?: string): boolean => {
  for (let cut = 0; cut <= Math.min(word.length - 1, found.longest); cut++)
    for (const rule of found.suffixes.get(word.slice(word.length - cut)) ?? [])
      if (
        (prefix === undefined || rule.cross) &&
        entry(found, word.slice(0, word.length - cut) + rule.strip, rule, prefix)
      )
        return true
  return false
}

const spelled = (language: DictionaryLanguage, word: string): boolean => {
  const found = dictionary(language)
  if (found.words.has(word) || suffixed(found, word)) return true
  for (let cut = 1; cut <= Math.min(word.length - 1, found.longest); cut++)
    for (const rule of found.prefixes.get(word.slice(0, cut)) ?? []) {
      const rest = rule.strip + word.slice(cut)
      if (entry(found, rest, rule) || (rule.cross && suffixed(found, rest, rule.flag))) return true
    }
  return false
}

const CYRILLIC = /\p{Script=Cyrillic}/u
const SCRIPT_OF: Record<DictionaryLanguage, "cyrillic" | "latin"> = {
  russian: "cyrillic",
  english: "latin",
  spanish: "latin",
}

/**
 * `known`: whether a folded word the index stores is real in one of `languages` that write in its alphabet.
 * `covers`: whether any of them does; without one, a garbled spelling cannot be told from a real word.
 */
export const knownWord = (languages: readonly DictionaryLanguage[]) => {
  const byScript = (word: string) => {
    const script = CYRILLIC.test(word) ? "cyrillic" : "latin"
    return languages.filter((language) => SCRIPT_OF[language] === script)
  }
  return {
    covers: (word: string): boolean => byScript(word).length > 0,
    known: (word: string): boolean => byScript(word).some((language) => spelled(language, word)),
  }
}

/** The dictionaries of the store's stemmers: Russian for Cyrillic, each named Latin stemmer for Latin. */
export const dictionaryLanguages = (stemmers: { cyrillic: string; latin: string }): DictionaryLanguage[] =>
  [stemmers.cyrillic, ...stemmers.latin.split(",")].filter((name): name is DictionaryLanguage =>
    Object.hasOwn(DICTIONARIES, name),
  )
