import { CliError } from "@wirecat/cli-base"
import { implicitTextTerms, parseLucene, walkQuery } from "@wirecat/cli-base/query"
import { normalize } from "../store/normalize.js"
import { MESSAGE_PARSING } from "./lucene/types.js"

export const words = (text: string) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []
const scaffolding = new Set(
  words(
    "what which how many much who where when is are was were do does did can could should we the a an for of to under from in on at has have сколько какой какая какие какое кто кому кем где когда как что во по на в к с у через ли должен должна нужно идёт идет можно может могут",
  ),
)
const questionWord =
  /\b(?:what|which|how|who|where|when|can|could|should)\b|(?:^|\s)(?:сколько|какой|какая|какие|какое|кто|кому|кем|где|когда|как|что|можно|может|могут|ли)(?:\s|$)/iu
const QUESTION_STARTS = new Set(
  words(
    "what which how who whom whose where when why can could should would did do does is are was were will " +
      "что кто кого кому кем где когда как какой какая какое какие какую каким какого каких почему зачем откуда " +
      "куда сколько ли можно разве чей чья чьё чьи",
  ),
)
const QUESTION_FILLER = new Set(
  words("about any did does why whom whose would will это мы вы я они он она о об про ли"),
)
/**
 * A question's content words — «что решили по цене?» → решили, цене — or null when the text is not a question: it
 * ends with «?» or starts with a question word.
 */
export const questionTerms = (text: string): string[] | null =>
  /\?\s*$/u.test(text) || QUESTION_STARTS.has(words(text)[0] ?? "")
    ? words(text).filter((word) => !scaffolding.has(word) && !QUESTION_STARTS.has(word) && !QUESTION_FILLER.has(word))
    : null

export function planQuestion(text: string, strict = false) {
  if (strict)
    return {
      changed: false,
      natural: false,
      queries: [text],
      scope: "",
      terms: words(text),
      rankingTerms: words(text),
      removed: [] as string[],
      aliases: [] as string[],
    }
  const inputAst = parseLucene(text, MESSAGE_PARSING)
  const rawTextual = walkQuery(inputAst.root).filter((node) => node.field === "text" || node.field === "exact")
  const body = rawTextual.map((node) => node.value).join(" ")
  const prefix = words(body).slice(0, 2)
  const questionPrefix =
    [
      "what",
      "which",
      "how",
      "who",
      "where",
      "when",
      "can",
      "could",
      "should",
      "сколько",
      "какои",
      "какая",
      "какие",
      "какое",
      "кто",
      "кому",
      "кем",
      "где",
      "когда",
      "как",
      "что",
      "можно",
      "может",
      "могут",
    ].includes(prefix[0] ?? "") ||
    (["к", "во"].includes(prefix[0] ?? "") && ["кому", "сколько"].includes(prefix[1] ?? ""))
  const natural = questionWord.test(body) && (/\?/u.test(body) || questionPrefix)
  let cleaned = text
  if (natural && !text.includes("\\")) {
    const last = rawTextual.at(-1)
    const mark = (last?.span.end ?? 0) - 1
    if (last?.operator === "wildcard" && text[mark] === "?") cleaned = text.slice(0, mark) + text.slice(mark + 1)
  }

  const ast = cleaned === text ? inputAst : parseLucene(cleaned, MESSAGE_PARSING)
  const predicates = walkQuery(ast.root)
  const textual = predicates.filter((p) => p.field === "text" || p.field === "exact")
  const fields = predicates.filter((p) => p.field !== "text" && p.field !== "exact")
  // A `field:value` term's span covers its field; a term inside `field:( … )` covers only its value.
  const scope = fields
    .map((p) => {
      const raw = cleaned.slice(p.span.start, p.span.end)
      return new RegExp(`^${p.field}[:=<>]`, "u").test(raw) ? raw : `${p.field}:${raw}`
    })
    .join(" ")
  const bypass =
    strict ||
    !natural ||
    implicitTextTerms(cleaned).size === 0 ||
    // A quoted single word is how `plainQuery` keeps `10:30` or `HH:MM` literal; it is no phrase the asker wrote.
    textual.some(
      (p) => !(p.operator === "term" || (p.operator === "phrase" && !/\s/u.test(p.value))) || p.field === "exact",
    )
  if (bypass)
    return {
      changed: false,
      natural: false,
      queries: [text],
      scope,
      terms: textual.flatMap((p) => words(p.value)),
      rankingTerms: textual.flatMap((p) => words(p.value)),
      removed: [] as string[],
      aliases: [] as string[],
    }
  const original = textual.flatMap((p) => words(p.value))
  const removed = original.filter((w) => scaffolding.has(w))
  const terms = [...new Set(original.filter((w) => !scaffolding.has(w)))]
  if (!terms.length)
    return {
      changed: false,
      natural: true,
      queries: [text],
      scope,
      terms,
      rankingTerms: original,
      removed,
      aliases: [] as string[],
    }
  const alias = [...terms]
  const changes: string[] = []
  const replace = (from: string[], to: string) => {
    for (let i = 0; i < alias.length; i++)
      if (from.includes(alias[i] ?? "")) {
        changes.push(`${alias[i]} -> ${to}`)
        alias[i] = to
      }
  }
  if (terms.some((w) => ["refund", "euros", "euro", "money", "возврата", "возврат", "евро"].includes(w))) {
    replace(["returned", "refunded", "received"], "refund")
    replace(["вернули", "возвращено", "перечислено"], "возврат")
  }
  if (terms.some((w) => ["log", "logs", "retention", "backup", "логов", "логи", "хранение", "хранения"].includes(w))) {
    replace(["lifetime", "kept", "keep"], "retention")
    replace(["хранятся", "хранят", "хранить", "срок"], "хранение")
  }
  if (terms.includes("service") || terms.includes("build")) replace(["currently", "now"], "current")
  const render = (ws: string[]) => [...new Set(ws)].join(" ") + (scope ? ` ${scope}` : "")
  const queries = [...new Set([render(terms), render(alias)])].slice(0, 2)
  return { changed: true, natural: true, queries, scope, terms, rankingTerms: original, removed, aliases: changes }
}

/**
 * Text as a question is searched. Its own "?" would parse as a one-character wildcard and send it to strict search
 * (BUG-395); the colon of a time or ratio ("22:00", "1:1") would parse as a field and fail the whole search, and
 * escaped it is syntax again, so it splits the numbers (BUG-450). A quoted timestamp keeps its colons (BUG-458).
 */
export const questionText = (text: string) =>
  text
    .replace(/(?<=\p{L})\?(?=\s|$)/gu, "")
    .replace(/"(?:[^"\\]|\\.)*"|(?<=\d):(?=\d)/gu, (found) => (found === ":" ? " " : found))

/** The words a question's partial lookup takes: its content words and the words its aliases stand for. */
export const lookupTerms = (plan: ReturnType<typeof planQuestion>) => [
  ...new Set(plan.terms.concat(plan.aliases.flatMap((alias) => words(alias.split(" -> ")[1] ?? "")))),
]

/** Any of the words, and every field the question names. */
export const anyOfTerms = (terms: string[], scope: string) => `(${terms.join(" OR ")})${scope ? ` ${scope}` : ""}`

/**
 * The partial lookup `search messages --discover` runs, for a store that has no discovery of its own: a question's
 * content words joined by OR, its fields kept. `undefined` when the text is not a question in natural language, so
 * words and query syntax are searched as typed.
 */
export const questionLookup = (text: string): string | undefined => {
  let plan: ReturnType<typeof planQuestion>
  try {
    plan = planQuestion(questionText(text))
  } catch (error) {
    // A query the messages language refuses is not a plain question; the store's own parser answers it.
    if (error instanceof CliError) return undefined
    throw error
  }
  const terms = plan.changed ? lookupTerms(plan) : []
  return terms.length ? anyOfTerms(terms, plan.scope) : undefined
}
