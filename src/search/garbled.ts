import { editDistance } from "./correct.js"
import { createStemmer } from "./stem.js"

/** A query word as speech search widens it: its folded form and the stems the store's stemmers give it. */
export interface GarbledProbe {
  literal: string
  stems: string[]
}

/** ztx's floor: a shorter word has too many neighbours to widen safely. */
export const SHORTEST_GARBLED = 4
const MOST_WIDENED = 64

/** The index folds ё but keeps э, and recognition writes «риэлтор» as often as «риелтор». */
const plain = (word: string): string => word.replaceAll("э", "е")

const russian = createStemmer({ cyrillic: "russian", latin: "none" }, { cacheLimit: 10_000 })
/**
 * Recognition swaps one number for another («восемь» and «шесть» for one spoken word), and «десять» is one edit
 * from «девять»; a widened number would be a wrong fact, so number words only ever match their own forms.
 */
const NUMBER_STEMS = new Set(
  `ноль нуль один одна одно одного одной одному одним одном одну два две двух двум двумя три трех трем тремя
  четыре четырех четырем четырьмя пять пяти пятью шесть шести шестью семь семи семью восемь восьми восемью
  девять девяти девятью десять десяти десятью одиннадцать двенадцать тринадцать четырнадцать пятнадцать
  шестнадцать семнадцать восемнадцать девятнадцать двадцать двадцати тридцать тридцати сорок сорока пятьдесят
  пятидесяти шестьдесят шестидесяти семьдесят семидесяти восемьдесят восьмидесяти девяносто девяноста сто ста
  двести двухсот триста трехсот четыреста четырехсот пятьсот пятисот шестьсот семьсот восемьсот девятьсот
  тысяча тысячи тысяч миллион миллиона миллионов миллиард первый второй третий четвертый пятый шестой седьмой
  восьмой девятый десятый сотый тысячный половина треть четверть`
    .split(/\s+/)
    .map((word) => russian.stemToken(word)),
)
export const isNumberWord = (word: string): boolean => /\d/.test(word) || NUMBER_STEMS.has(russian.stemToken(word))

/**
 * One edit between stems, tighter than typed-text correction (`maxEdits`), because a transcript always widens
 * instead of only when nothing matched: two edits turn «проверка» into «провела», «работа» into «заботы».
 * A stem shorter than this keeps its first letter; a longer one may gain one, as «дриелтора» does.
 */
const LOOSE_START = 7

/** What the index already finds for the word: its beginning or one of its stems. */
export const plainMatch = (probe: GarbledProbe, word: string, stems: string[]): boolean =>
  word.startsWith(probe.literal) || stems.some((stem) => probe.stems.includes(stem))

/**
 * How far a stored word is from a query word that recognition may have garbled, or `null` when it is not a
 * candidate. Stems are compared, not words: «рилторов» is three edits from «риелтор» but its stem one.
 * A stem one side extends counts only when the other side's word spells the extension out — «циана» (stem
 * `циа`) reaches «цианом» (`циан`), while «устав» (`уста`) does not reach «установить» (`установ`).
 * As in ztx, a stored word that begins the query word also matches, from four letters on.
 */
export const garbledDistance = (probe: GarbledProbe, word: string, stems: string[]): number | null => {
  if (probe.literal.length < SHORTEST_GARBLED || plainMatch(probe, word, stems)) return null
  if (isNumberWord(probe.literal) || isNumberWord(word)) return null
  const literal = plain(probe.literal)
  const stored = plain(word)
  let best: number | null = null
  for (const queryStem of probe.stems.map(plain))
    for (const wordStem of stems.map(plain)) {
      if (Math.min(queryStem.length, wordStem.length) < 3) continue
      if (
        (wordStem.startsWith(queryStem) && literal.startsWith(wordStem)) ||
        (queryStem.startsWith(wordStem) && stored.startsWith(queryStem))
      )
        return 0
      if (queryStem.length < SHORTEST_GARBLED) continue
      if (queryStem.length < LOOSE_START && queryStem[0] !== wordStem[0]) continue
      const distance = editDistance(queryStem, wordStem, 1)
      if (distance <= 1 && (best === null || distance < best)) best = distance
    }
  if (best === null && stored.length >= SHORTEST_GARBLED && literal.startsWith(stored)) return 0
  return best
}

/** `editDistance` from `stem` to the nearest beginning of `word`, or `max + 1` once every beginning is further. */
const prefixDistance = (stem: string, word: string, max: number): number => {
  let before = new Int32Array(word.length + 1)
  let previous = new Int32Array(word.length + 1)
  let current = new Int32Array(word.length + 1)
  for (let i = 1; i <= stem.length; i++) {
    current[0] = i
    let lowest = i
    for (let j = 1; j <= word.length; j++) {
      let value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (stem[i - 1] === word[j - 1] ? 0 : 1),
      )
      if (i > 1 && j > 1 && stem[i - 1] === word[j - 2] && stem[i - 2] === word[j - 1])
        value = Math.min(value, (before[j - 2] as number) + 1)
      current[j] = value
      lowest = Math.min(lowest, value)
    }
    if (lowest > max) return max + 1
    ;[before, previous, current] = [previous, current, before]
  }
  return previous.reduce((lowest, value) => Math.min(lowest, value), max + 1)
}

/**
 * Whether a stored word can pass `garbledDistance`, checked without stemming it: a stem begins its word, so a
 * near stem means a near beginning. Stemming every stored word in a fresh process costs half a second.
 */
const worthStemming = (probe: GarbledProbe, word: string): boolean => {
  const stored = plain(word)
  if (stored.length >= SHORTEST_GARBLED && plain(probe.literal).startsWith(stored)) return true
  return probe.stems.some((raw) => {
    const stem = plain(raw)
    if (stem.length >= 3 && stored.startsWith(stem)) return true
    return stem.length >= SHORTEST_GARBLED && prefixDistance(stem, stored, 1) <= 1
  })
}

/**
 * The stored words each probe widens to, nearest first and then the most used, from one pass over the
 * vocabulary, whose terms are folded as the index folds them. `stem` is the store's stemmer, so a stored
 * word's stem is the one its index holds.
 */
export const widenWords = (
  probes: GarbledProbe[],
  vocabulary: Iterable<{ term: string; docs: number }>,
  stem: (word: string) => string[],
): string[][] => {
  const found = probes.map(() => [] as { term: string; docs: number; distance: number }[])
  const live = probes.map((probe) => probe.literal.length >= SHORTEST_GARBLED)
  if (!live.some(Boolean)) return probes.map(() => [])
  for (const { term: word, docs } of vocabulary) {
    let stems: string[] | undefined
    probes.forEach((probe, at) => {
      if (!live[at] || !worthStemming(probe, word)) return
      stems ??= stem(word)
      const distance = garbledDistance(probe, word, stems)
      if (distance !== null) found[at]?.push({ term: word, docs, distance })
    })
  }
  return found.map((words) =>
    words
      .sort((a, b) => a.distance - b.distance || b.docs - a.docs || a.term.localeCompare(b.term))
      .slice(0, MOST_WIDENED)
      .map((word) => word.term),
  )
}
