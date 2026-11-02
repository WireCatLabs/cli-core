import { CliError, singleLine } from "@wirecat/cli-base"
import { DEFAULT_TASK_CATEGORIES, FALLBACK_CATEGORY, type TaskCategory } from "../domain/task-categories.js"
import { createStemmer, type Stemmer } from "../search/stem.js"

export {
  DEFAULT_TASK_CATEGORIES,
  FALLBACK_CATEGORY,
  parseTaskCategory,
  type TaskCategory,
  type UnlistedCategory,
  unlistedNote,
  withTaskCategory,
} from "../domain/task-categories.js"

const names = (categories: readonly TaskCategory[]) => categories.map(({ name }) => name).join(", ")

/** A category the list holds, or a refusal that names the list. */
export const taskCategoryOf =
  (categories: readonly TaskCategory[] = DEFAULT_TASK_CATEGORIES, flag = "--category") =>
  (typed: string): string => {
    const name = typed.trim().toLowerCase()
    if (categories.some((one) => one.name === name)) return name
    throw new CliError(
      "validation_error",
      `${flag} takes ${names(categories)} — not "${singleLine(typed)}"; tasks categories says what each means`,
      { reason: "task.category-unknown" },
    )
  }

/**
 * A Latin word may be English or Spanish. Every trigger meets the message's English stems, as it always has; Spanish
 * triggers also meet its Spanish stems, but only in a message that reads as Spanish: Spanish stems are short and
 * English words land on them (`page` → `pag`, the stem of `pagar`).
 */
let stemmers: { english: Stemmer; spanish: Stemmer } | undefined
const stemmersOf = () =>
  (stemmers ??= {
    english: createStemmer({ cyrillic: "russian", latin: "english" }),
    spanish: createStemmer({ cyrillic: "russian", latin: "spanish" }),
  })

const SPANISH_LETTERS = /[ñáéíóú¿¡]/u
const SPANISH_WORDS = new Set("de del la las el los que por para una unos unas hay tengo hola gracias".split(" "))
const readsSpanish = (text: string) =>
  SPANISH_LETTERS.test(text.toLowerCase()) ||
  (text.toLowerCase().match(/\p{L}+/gu) ?? []).some((word) => SPANISH_WORDS.has(word))

type TriggerStems = { name: string; english: Set<string>; spanish: Set<string> }
const stemsByList = new WeakMap<readonly TaskCategory[], TriggerStems[]>()

const triggerStems = (categories: readonly TaskCategory[]) => {
  const known = stemsByList.get(categories)
  if (known) return known
  const { english, spanish } = stemmersOf()
  const built = categories.map(({ name, triggers }) => ({
    name,
    english: new Set(Object.values(triggers).flatMap((words) => words.flatMap((word) => english.stemTokens(word)))),
    spanish: new Set(triggers.es.flatMap((word) => spanish.stemTokens(word))),
  }))
  stemsByList.set(categories, built)
  return built
}

/** For each list the text hits, the number of distinct trigger stems it hit, in list order. */
const hitsByList = (text: string, categories: readonly TaskCategory[]): { name: string; hits: number }[] => {
  const stem = stemmersOf()
  const english = stem.english.stemTokens(text)
  const spanish = readsSpanish(text) ? stem.spanish.stemTokens(text) : []
  const counted: { name: string; hits: number }[] = []
  for (const triggers of triggerStems(categories)) {
    const hit = new Set<string>()
    english.forEach((word, at) => {
      const other = spanish[at]
      if (triggers.english.has(word)) hit.add(word)
      else if (other !== undefined && triggers.spanish.has(other)) hit.add(other)
    })
    counted.push({ name: triggers.name, hits: hit.size })
  }
  return counted
}

/** The names of every list the text hits, so a message can be a request and a promise at once. */
export const listsHit = (text: string, categories: readonly TaskCategory[]): string[] =>
  hitsByList(text, categories)
    .filter(({ hits }) => hits > 0)
    .map(({ name }) => name)

/**
 * The category with the most distinct trigger stems in the text; none is `other`, a tie goes to the earlier one.
 * A word hits by its English stem first, so a cognate (`hospital`) counts once, not twice.
 */
export const categorize = (text: string, categories: readonly TaskCategory[] = DEFAULT_TASK_CATEGORIES): string => {
  let best = { name: FALLBACK_CATEGORY, hits: 0 }
  for (const counted of hitsByList(text, categories)) if (counted.hits > best.hits) best = counted
  return best.name
}
