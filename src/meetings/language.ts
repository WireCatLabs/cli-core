/**
 * Words frequent in one Latin-script language and rare in the others here. Letters alone cannot tell Spanish from
 * English, and calling a Spanish meeting English is worse than calling it nothing.
 */
const LATIN_WORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "is", "that", "you", "this", "what", "have", "with", "are"],
  es: ["el", "los", "las", "por", "pero", "para", "está", "muy", "también", "hay"],
  de: ["der", "und", "ist", "nicht", "das", "ich", "wir", "mit", "auch", "ein"],
  fr: ["le", "les", "est", "une", "pas", "je", "vous", "nous", "avec", "mais"],
  it: ["gli", "della", "sono", "perché", "anche", "questo", "molto", "che", "di", "è"],
  pt: ["não", "você", "isso", "muito", "então", "com", "uma", "também", "mas", "eu"],
}
const LATIN_LANGUAGE = new Map(
  Object.entries(LATIN_WORDS).flatMap(([language, words]) => words.map((word) => [word, language] as const)),
)
/** Letters Ukrainian writes and Russian does not. */
const UKRAINIAN = /[іїєґ]/giu
const CYRILLIC = /\p{Script=Cyrillic}/gu
const LATIN = /\p{Script=Latin}/gu
const MIN_LETTERS = 20
/** A meeting in one language keeps a few lines of another; a share below this is a mixed meeting. */
const DOMINANT = 0.75

const countOf = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

const latinLanguage = (texts: readonly string[]): string | null => {
  const votes = new Map<string, number>()
  for (const text of texts)
    for (const word of text.toLowerCase().split(/[^\p{L}]+/u)) {
      const language = LATIN_LANGUAGE.get(word)
      if (language) votes.set(language, (votes.get(language) ?? 0) + 1)
    }
  const [first, second] = [...votes].sort((a, b) => b[1] - a[1])
  if (!first || first[1] < 3 || (second && first[1] < 2 * second[1])) return null
  return first[0]
}

/**
 * The language most of a transcript is in, from its letters: Cyrillic is Russian (Ukrainian when its own letters
 * show), Latin is decided by frequent words. `null` when the text is too short, mixed, or in neither script.
 */
export const transcriptLanguage = (texts: Iterable<string>): string | null => {
  const all = [...texts]
  let cyrillic = 0
  let latin = 0
  let ukrainian = 0
  for (const text of all) {
    cyrillic += countOf(text, CYRILLIC)
    latin += countOf(text, LATIN)
    ukrainian += countOf(text, UKRAINIAN)
  }
  const letters = cyrillic + latin
  if (letters < MIN_LETTERS) return null
  if (cyrillic / letters >= DOMINANT) return ukrainian / cyrillic >= 0.01 ? "uk" : "ru"
  if (latin / letters >= DOMINANT) return latinLanguage(all)
  return null
}
