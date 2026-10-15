import { CliError, singleLine } from "@wirecat/cli-base"
import { DEFAULT_TASK_CATEGORIES, FALLBACK_CATEGORY, type TaskCategory } from "../domain/task-categories.js"
import { createStemmer, type Stemmer } from "../search/stem.js"

export {
  DEFAULT_TASK_CATEGORIES,
  FALLBACK_CATEGORY,
  parseTaskCategory,
  type TaskCategory,
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

let stemmer: Stemmer | undefined
const stemsByList = new WeakMap<readonly TaskCategory[], { name: string; stems: Set<string> }[]>()

const triggerStems = (categories: readonly TaskCategory[], stem: Stemmer) => {
  const known = stemsByList.get(categories)
  if (known) return known
  const built = categories.map(({ name, triggers }) => ({
    name,
    stems: new Set(Object.values(triggers).flatMap((words) => words.flatMap((word) => stem.stemTokens(word)))),
  }))
  stemsByList.set(categories, built)
  return built
}

/** The category whose trigger stems the text shares most; none shared is `other`. A tie goes to the earlier one. */
export const categorize = (text: string, categories: readonly TaskCategory[] = DEFAULT_TASK_CATEGORIES): string => {
  stemmer ??= createStemmer()
  const words = new Set(stemmer.stemTokens(text))
  let best = { name: FALLBACK_CATEGORY, hits: 0 }
  for (const { name, stems } of triggerStems(categories, stemmer)) {
    let hits = 0
    for (const stem of stems) if (words.has(stem)) hits += 1
    if (hits > best.hits) best = { name, hits }
  }
  return best.name
}
