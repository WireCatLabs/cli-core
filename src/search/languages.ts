/** The languages search can stem and spell-check. Adding one here needs its Snowball stemmer in `stem.ts`. */
export const LANGUAGES = [
  { name: "russian", code: "ru", label: "Russian", script: "cyrillic", dictionary: "dictionary-ru" },
  { name: "english", code: "en", label: "English", script: "latin", dictionary: "dictionary-en" },
  { name: "spanish", code: "es", label: "Spanish", script: "latin", dictionary: "dictionary-es" },
] as const

type Entry = (typeof LANGUAGES)[number]
export type Language = Entry["name"]
export type Script = Entry["script"]
export type LanguageOf<S extends Script> = Extract<Entry, { script: S }>["name"]

export const languagesOf = <S extends Script>(script: S): LanguageOf<S>[] =>
  LANGUAGES.filter((one) => one.script === script).map(({ name }) => name as LanguageOf<S>)
