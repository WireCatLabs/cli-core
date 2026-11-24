import { normalize } from "../store/normalize.js"
import { correctWords, type Vocabulary } from "./correct.js"

const LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
}

/** A Cyrillic word as Latin letters, the way a Latin name is written in Russian («хецнер», «ноксвел» for noxvel). */
export const latinSpellings = (word: string): string[] => {
  if (!/\p{Script=Cyrillic}/u.test(word)) return []
  const plain = [...normalize(word)].map((letter) => LATIN[letter] ?? letter).join("")
  return [...new Set([plain, plain.replaceAll("ks", "x")])]
}

// Longest first, so "shch" is read before "sh" and "s".
const CYRILLIC: [string, string][] = Object.entries({
  shch: "щ",
  sch: "щ",
  zh: "ж",
  kh: "х",
  ts: "ц",
  ch: "ч",
  sh: "ш",
  yu: "ю",
  ya: "я",
  yo: "е",
  y: "ы",
  a: "а",
  b: "б",
  c: "к",
  d: "д",
  e: "е",
  f: "ф",
  g: "г",
  h: "х",
  i: "и",
  j: "дж",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  q: "к",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  v: "в",
  w: "в",
  x: "кс",
  z: "з",
})

/**
 * A Latin word as Cyrillic letters, the way a Russian name is typed in Latin («finpoint», «finpoynt» for ФинПоинт).
 * A lone `y` may be и, й or ы, so each is tried, for up to three of them.
 */
export const cyrillicSpellings = (word: string): string[] => {
  const latin = normalize(word)
  if (!/^[a-z]+$/.test(latin) || latin.split("y").length > 4) return []
  let spellings = [""]
  for (let at = 0; at < latin.length; ) {
    const [from, to] = CYRILLIC.find(([one]) => latin.startsWith(one, at)) ?? [latin[at] as string, latin[at] as string]
    const letters = from === "y" ? ["и", "й", "ы"] : [to]
    spellings = spellings.flatMap((start) => letters.map((letter) => start + letter))
    at += from.length
  }
  return spellings
}

/**
 * For each word no message holds, not even as the beginning of a longer one, the words the store does hold that it
 * may stand for. A Cyrillic word: its Latin spelling or the nearest known spellings of that, and only when there are
 * none, its own nearest known spellings (up to two edits, as `correctWords` allows). A Latin word: its Cyrillic
 * spelling when the store holds it as it is, else its own nearest spellings. A word any message holds is left alone, so a
 * correct word never turns into another.
 */
export const respelled = async (vocabulary: Vocabulary, words: string[]): Promise<Map<string, string[]>> => {
  const known = await vocabulary.knownTerms(words)
  const found = new Map<string, string[]>()
  for (const word of words.filter((one) => !known.has(one))) {
    const latin = latinSpellings(word)
    if (latin.length) {
      const held = await vocabulary.knownTerms(latin)
      const nearLatin = await correctWords(
        vocabulary,
        latin.filter((one) => !held.has(one)),
      )
      const asLatin = [...new Set([...held, ...[...nearLatin.values()].flat()])]
      // A Latin name found in Latin letters says what the word was; its Cyrillic neighbours are then other words.
      const forms = asLatin.length ? asLatin : ((await correctWords(vocabulary, [word])).get(normalize(word)) ?? [])
      if (forms.length) found.set(word, forms)
      continue
    }
    // Only a Cyrillic word held exactly as typed: one near it is often a translation, not the name («cement», цемент).
    const held = [...(await vocabulary.knownTerms(cyrillicSpellings(word)))]
    const forms = held.length ? held : ((await correctWords(vocabulary, [word])).get(normalize(word)) ?? [])
    if (forms.length) found.set(word, forms)
  }
  return found
}
