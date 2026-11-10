import { foldName } from "../resolve.js"

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
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
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "iu",
  я: "ia",
  і: "i",
  ї: "i",
  є: "e",
  ґ: "g",
}

/** Latin spellings of one sound, longest first, so `shch` is read before `sh` and `ch`. */
const LATIN_TO_CYRILLIC: [string, string][] = [
  ["shch", "щ"],
  ["sch", "щ"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ts", "ц"],
  ["tz", "ц"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["ya", "я"],
  ["ia", "я"],
  ["yu", "ю"],
  ["iu", "ю"],
  ["yo", "ё"],
  ["a", "а"],
  ["b", "б"],
  ["c", "к"],
  ["d", "д"],
  ["e", "е"],
  ["f", "ф"],
  ["g", "г"],
  ["h", "х"],
  ["i", "и"],
  ["j", "й"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["q", "к"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["v", "в"],
  ["w", "в"],
  ["x", "кс"],
  ["y", "й"],
  ["z", "з"],
]

const CYRILLIC = /[Ѐ-ӿ]/u
const LATIN = /[a-z]/u

/** Cyrillic letters in Latin, one passport-like spelling; other letters as they are. */
export const toLatin = (text: string): string =>
  [...foldName(text)].map((letter) => CYRILLIC_TO_LATIN[letter] ?? letter).join("")

/** A Russian reading of a Latin name, `Kuznetsova` as `Кузнецова`: a guess, good enough to search with. */
export const toCyrillic = (text: string): string => {
  const folded = foldName(text)
    .replace(/ii\b/gu, "ий")
    .replace(/(?<=[aeouy])i\b/gu, "й")
    .replace(/(?<=[b-df-hj-np-tv-z])i([au])/gu, (_, vowel: string) => (vowel === "a" ? "ия" : "ию"))
  let out = ""
  let at = 0
  while (at < folded.length) {
    const pair = LATIN_TO_CYRILLIC.find(([latin]) => folded.startsWith(latin, at))
    if (pair === undefined) {
      out += folded[at]
      at += 1
    } else {
      out += pair[1]
      at += pair[0].length
    }
  }
  return out
}

/**
 * One word reduced to what its spellings share: `Алексей`, `Aleksey` and `Aleksei` all give `aleksei`,
 * `Юлия`, `Yulia` and `Iuliia` give `iulia`. Two different names may give one skeleton; it finds, it never proves.
 */
export const wordSkeleton = (word: string): string =>
  toLatin(word)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replaceAll("tz", "ts")
    .replaceAll("kh", "h")
    .replaceAll("x", "ks")
    .replaceAll("w", "v")
    .replaceAll("j", "i")
    .replaceAll("y", "i")
    .replace(/(.)\1+/gu, "$1")

const wordsOf = (name: string): string[] =>
  foldName(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")

/** The name's words as skeletons, in order; empty for a name with nothing to read. */
export const nameSkeletons = (name: string | null | undefined): string[] =>
  typeof name === "string" ? wordsOf(name).map(wordSkeleton) : []

/**
 * The name once script, spelling, case and word order are set aside: `Светлана Кузнецова` and `Kuznetsova Svetlana`
 * give one key. `null` for a name with nothing to read.
 */
export const variantKey = (name: string | null | undefined): string | null => {
  const words = nameSkeletons(name)
  return words.length === 0 ? null : [...words].sort().join(" ")
}

/**
 * The text in the other script too, so a search in one finds a name stored in the other: Cyrillic in the passport
 * spelling and the older one with `y` (`Iuliia`, `Yuliia`), Latin read as Russian. Each spelling once.
 */
export const spellings = (text: string): string[] => {
  const folded = foldName(text).trim()
  if (folded === "") return []
  if (CYRILLIC.test(folded)) {
    const latin = toLatin(folded)
    return [...new Set([folded, latin, latin.replace(/\bi(?=[aeu])|(?<=[^aeiou ])i(?=[au])/gu, "y")])]
  }
  return [...new Set([folded, LATIN.test(folded) ? toCyrillic(folded) : folded])]
}
