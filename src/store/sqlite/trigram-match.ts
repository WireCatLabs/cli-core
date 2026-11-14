const MOST_YO_SPELLINGS = 64

/** Every spelling of `run` with each е or ё as either: a trigram index keeps the text as written. */
export const yoSpellings = (run: string): string[] | undefined => {
  let spellings = [""]
  for (const c of run) {
    spellings = spellings.flatMap((start) => (c === "е" || c === "ё" ? [`${start}е`, `${start}ё`] : [`${start}${c}`]))
    if (spellings.length > MOST_YO_SPELLINGS) return undefined
  }
  return spellings
}

const phrase = (value: string) => `"${value.replaceAll('"', '""')}"`

/**
 * An FTS5 trigram MATCH for `part` anywhere in the text, ё and е either way, as message text matches. The index folds
 * case itself; past 64 spellings only the typed one is asked.
 */
export const trigramPart = (part: string): string => {
  const typed = part.normalize("NFC").toLowerCase()
  const spellings = yoSpellings(typed) ?? [typed]
  return spellings.length === 1 ? phrase(typed) : `(${spellings.map(phrase).join(" OR ")})`
}

/** A GLOB pattern for `word` anywhere in the text, in any case, ё and е either way: what a trigram cannot match. */
export const anyCaseGlob = (word: string): string =>
  `*${[...word.normalize("NFC")]
    .map((c) => {
      const forms = new Set(
        [c, c.toLowerCase(), c.toUpperCase(), ...("еёЕЁ".includes(c) ? ["е", "ё", "Е", "Ё"] : [])].filter(
          (form) => [...form].length === 1,
        ),
      )
      return forms.size === 1 ? c : `[${[...forms].join("")}]`
    })
    .join("")}*`
