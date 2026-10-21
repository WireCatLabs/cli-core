import { readFileSync } from "node:fs"

interface Suffix {
  flag: string
  strip: string
  condition: RegExp
}
interface Dictionary {
  stems: Map<string, string>
  suffixes: Map<string, Suffix[]>
  longest: number
}

let loaded: Dictionary | undefined

/**
 * Hunspell's own check, an ending at a time, instead of nspell's: nspell expands the 146,269 entries into
 * 1.44 million forms (1.4 s, 172 MB) where this loads in about 0.15 s and agrees on every word it knows.
 */
const dictionary = (): Dictionary => {
  if (loaded) return loaded
  const file = (name: string) => readFileSync(new URL(name, import.meta.resolve("dictionary-ru")), "utf8")
  const stems = new Map<string, string>()
  for (const line of file("index.dic").split("\n").slice(1)) {
    const [entry, flags = ""] = line.trim().split("/")
    if (!entry) continue
    // Names and abbreviations are capitalised in the dictionary; a transcript's word index is lower case.
    const word = entry.toLowerCase()
    stems.set(word, (stems.get(word) ?? "") + flags)
  }
  const suffixes = new Map<string, Suffix[]>()
  let longest = 0
  for (const line of file("index.aff").split("\n")) {
    const [kind, flag, strip, append, condition] = line.trim().split(/\s+/)
    if (kind !== "SFX" || flag === undefined || strip === undefined || append === undefined || !condition) continue
    const ending = append === "0" ? "" : append
    const rules = suffixes.get(ending) ?? []
    rules.push({
      flag,
      strip: strip === "0" ? "" : strip,
      condition: new RegExp(`${condition === "." ? "" : condition}$`),
    })
    suffixes.set(ending, rules)
    longest = Math.max(longest, ending.length)
  }
  loaded = { stems, suffixes, longest }
  return loaded
}

const spelled = (word: string): boolean => {
  const { stems, suffixes, longest } = dictionary()
  if (stems.has(word)) return true
  for (let cut = 0; cut <= Math.min(word.length - 1, longest); cut++)
    for (const rule of suffixes.get(word.slice(word.length - cut)) ?? []) {
      const stem = word.slice(0, word.length - cut) + rule.strip
      if (stems.get(stem)?.includes(rule.flag) && rule.condition.test(stem)) return true
    }
  return false
}

/**
 * Whether a word the index stores is a real Russian word. The index folds й into и and ё into е, so each is
 * tried back one letter at a time.
 */
export const knownRussianWord = (word: string): boolean => {
  if (spelled(word)) return true
  for (const [folded, original] of [
    ["и", "й"],
    ["е", "ё"],
  ] as const)
    for (let at = word.indexOf(folded); at >= 0; at = word.indexOf(folded, at + 1))
      if (spelled(word.slice(0, at) + original + word.slice(at + 1))) return true
  return false
}
