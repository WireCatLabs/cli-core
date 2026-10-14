import type { Stemmer } from "../search/stem.js"

/** A person the store knows, with every name it was seen under: its own, its accounts' and its aliases. */
export interface KnownPerson {
  id: number
  names: string[]
}

/** Name words by stem, each with the people whose names hold it. */
export interface NameIndex {
  people: Map<string, Set<number>>
  stem: Stemmer
}

/** One known name found in a text: the people it may be, one when a full name or a single bearer settles it. */
export interface FoundName {
  start: number
  end: number
  /** The stems of the written words, `валер` for both Валерий and Валерию. */
  value: string
  people: number[]
  confidence: number
}

// Profiles are often in Latin while the chats are in Russian: «Valery» has to find «Валерию».
const LATIN_TO_CYRILLIC: Record<string, string> = {
  shch: "щ",
  sch: "щ",
  zh: "ж",
  kh: "х",
  ch: "ч",
  sh: "ш",
  ts: "ц",
  yu: "ю",
  ya: "я",
  yo: "ё",
  a: "а",
  b: "б",
  v: "в",
  g: "г",
  d: "д",
  e: "е",
  z: "з",
  i: "и",
  j: "й",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  f: "ф",
  h: "х",
  c: "к",
  w: "в",
  x: "кс",
  y: "ы",
  q: "к",
}
const LATIN_UNIT = new RegExp(Object.keys(LATIN_TO_CYRILLIC).join("|"), "g")

/** A rough Russian spelling of a Latin name, enough for its stem: Valery → валерий, Dmitry → дмитрий. */
export const cyrillicOf = (latin: string): string =>
  latin
    .toLowerCase()
    .replace(/ey$/, "ей")
    .replace(/i?y$/, "ий")
    .replace(LATIN_UNIT, (unit) => LATIN_TO_CYRILLIC[unit] ?? unit)

// A stem of one letter matches too much; a word of three («Или», «Ира») is more often an ordinary word than a name.
const MIN_STEM = 2
const MIN_WORD = 4
const WORD = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{3,}(?![\p{L}\p{N}])/gu
const NAME_WORD = /^\p{L}{3,}$/u
// Snowball reads a surname's -ов as an ending: «Иванов» stems to «иван», «Иванову» to «иванов». The written
// name plus a case ending catches what the stem misses.
const MAX_ENDING = 3

const keyOf = (stem: Stemmer, word: string) => `s:${stem.stemToken(word)}`

export const nameIndex = (known: KnownPerson[], stem: Stemmer): NameIndex => {
  const people = new Map<string, Set<number>>()
  const add = (key: string, person: number) => {
    const bearers = people.get(key) ?? new Set<number>()
    bearers.add(person)
    people.set(key, bearers)
  }
  const addWord = (word: string, person: number) => {
    if (stem.stemToken(word).length >= MIN_STEM) add(keyOf(stem, word), person)
    add(`w:${word.toLowerCase()}`, person)
  }
  for (const { id, names } of known)
    for (const name of names)
      for (const word of name.split(/[\s.,()"«»-]+/u).filter((one) => NAME_WORD.test(one))) {
        addWord(word, id)
        if (/^[a-z]+$/i.test(word)) addWord(cyrillicOf(word), id)
      }
  return { people, stem }
}

const bearersOf = ({ people, stem }: NameIndex, word: string): Set<number> | undefined => {
  const byStem = people.get(keyOf(stem, word))
  const lower = word.toLowerCase()
  for (let cut = 0; cut <= MAX_ENDING && lower.length - cut >= MIN_WORD - 1; cut++) {
    const written = people.get(`w:${lower.slice(0, lower.length - cut)}`)
    if (written) return byStem ? new Set([...byStem, ...written]) : written
  }
  return byStem
}

const intersection = (a: Set<number>, b: Set<number>) => new Set([...a].filter((one) => b.has(one)))

/**
 * Capitalized words that are a known person's name in some case: Валерию for Valery, Иванову for Иванов. Two such
 * words in a row that one person shares are one full name. A word alone is a first name or a surname, and may be
 * several people.
 */
export const findNames = (text: string, index: NameIndex): FoundName[] => {
  if (index.people.size === 0) return []
  const found: FoundName[] = []
  let previous: { start: number; end: number; key: string; bearers: Set<number> } | undefined
  for (const match of text.matchAll(WORD)) {
    const bearers = bearersOf(index, match[0])
    const start = match.index
    const end = start + match[0].length
    if (!bearers) {
      previous = undefined
      continue
    }
    const key = index.stem.stemToken(match[0])
    const adjacent = previous && text.slice(previous.end, start) === " "
    const shared = previous && adjacent ? intersection(previous.bearers, bearers) : new Set<number>()
    if (previous && shared.size > 0) {
      found.pop()
      found.push({ start: previous.start, end, value: `${previous.key} ${key}`, people: [...shared], confidence: 0.9 })
      previous = undefined
      continue
    }
    found.push({ start, end, value: key, people: [...bearers], confidence: 0.6 })
    previous = { start, end, key, bearers }
  }
  return found
}
