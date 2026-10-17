import type { Stemmer } from "../search/stem.js"
import { FIRST_NAMES, NAME_WORDS, NOT_NAMES } from "./first-names.js"

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

// Case endings a Russian first name takes once its final vowel is dropped: Ольга → Ольге, Дмитрий → Дмитрию.
const ENDINGS = ["а", "я", "у", "ю", "е", "и", "ы", "ой", "ей", "ом", "ем", "ою", "ею", "ью", "ий", "ия", "ию", "ием"]
// Only real case endings: «Отлично», «Логично» and «Безусловно» end like a patronymic's stem, not its endings.
const PATRONYMIC = /^\p{Lu}\p{Ll}+(?:(?:ов|ев)ич(?:а|у|ем|е)?|ьич(?:а|у|ом|ём|е)?|(?:ов|ев|ич)н(?:а|ы|е|у|ой|ою))$/u
const SENTENCE_START = /(?:^|[.!?…\n]\s*)$/u
// Russian surnames by their endings, in any case: Иванов, Петровой, Смирнову, Шевченко, Сухишвили.
const SURNAME = /^\p{Lu}\p{Ll}+(?:ов|ев|ёв|ин|ын|ск|цк|енко|ук|юк|ян|дзе|швили)\p{Ll}{0,3}$/u
const CYRILLIC_WORD = /^\p{Script=Cyrillic}+$/u
// A saint's or a holy name is part of a place or a feast: Saint Michael's Bridge, Coves de Sant Josep, Девы Марии.
const HOLY_BEFORE =
  /(?:^|[^\p{L}])(?:saint|sainte|st\.|sant|santa|santo|san|são|святого|святой|святая|святых|св\.|девы|богородицы)\s$/iu
// A city that is also a first name, in the prepositional case: «во Владимире», «в Милане».
const IN_CITY = /(?:^|[^\p{L}])во?\s$/iu

type Role = "first" | "word" | "patronymic"
let forms: Map<string, Role> | undefined

const formsOf = (name: string): string[] => {
  const lower = name.toLowerCase()
  if (!CYRILLIC_WORD.test(lower)) return [lower, `${lower}'s`]
  const base = lower.replace(/(?:ий|[аяйьо])$/u, "")
  return [lower, ...ENDINGS.map((ending) => base + ending)]
}

/** Every written form of a listed first name, and whether it is also an ordinary word (Вера, Grace). */
const nameForms = (): Map<string, Role> => {
  if (forms) return forms
  forms = new Map()
  for (const name of FIRST_NAMES) for (const form of formsOf(name)) forms.set(form, "first")
  for (const name of NAME_WORDS) for (const form of formsOf(name)) forms.set(form, "word")
  for (const word of NOT_NAMES) forms.delete(word)
  return forms
}

const roleOf = (word: string): Role | undefined =>
  PATRONYMIC.test(word) ? "patronymic" : nameForms().get(word.toLowerCase())

/**
 * Names of people the store does not know, by rule: a listed first name, a patronymic, and the surname or second
 * name beside them. A first name that is also a word (Вера, Grace) counts only with a neighbour. Never linked by
 * rule; they wait for review.
 */
export const findUnknownNames = (
  text: string,
  stem: Stemmer,
  taken: readonly { start: number; end: number }[],
): FoundName[] => {
  const words = [...text.matchAll(WORD)]
    .map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
    .filter((word) => !taken.some((one) => word.start < one.end && word.end > one.start))
  const adjacent = (a: number, b: number) => {
    const left = words[a]
    const right = words[b]
    return left !== undefined && right !== undefined && text.slice(left.end, right.start) === " "
  }
  const found: FoundName[] = []
  for (let at = 0; at < words.length; at++) {
    const role = roleOf((words[at] as { text: string }).text)
    if (role === undefined) continue
    let first = at
    let last = at
    const cyrillic = CYRILLIC_WORD.test((words[at] as { text: string }).text)
    if (role === "patronymic") {
      // A patronymic alone is too often a word; the name before it counts unless it only opens a sentence
      // («Спасибо Ивановичу»).
      const before = words[at - 1]
      if (!before || !adjacent(at - 1, at)) continue
      if (roleOf(before.text) !== "first" && SENTENCE_START.test(text.slice(0, before.start))) continue
      first = at - 1
    } else {
      if (cyrillic && adjacent(at - 1, at) && SURNAME.test(words[at - 1]?.text ?? "")) first = at - 1
      if (adjacent(last, last + 1) && PATRONYMIC.test(words[last + 1]?.text ?? "")) last += 1
      const next = words[last + 1]?.text ?? ""
      const surname = cyrillic ? SURNAME.test(next) : !CYRILLIC_WORD.test(next) && roleOf(next) === undefined
      if (last - first < 2 && adjacent(last, last + 1) && surname) last += 1
    }
    if (first === last && role === "word") continue
    const before = text.slice(
      Math.max(0, (words[first] as { start: number }).start - 12),
      (words[first] as { start: number }).start,
    )
    if (HOLY_BEFORE.test(before)) continue
    if (first === last && cyrillic && /е$/u.test((words[at] as { text: string }).text) && IN_CITY.test(before)) continue
    const span = words.slice(first, last + 1)
    found.push({
      start: (span[0] as { start: number }).start,
      end: (span.at(-1) as { end: number }).end,
      value: span.map((word) => stem.stemToken(word.text)).join(" "),
      people: [],
      confidence: first === last ? 0.4 : 0.5,
    })
    at = last
  }
  return found
}
