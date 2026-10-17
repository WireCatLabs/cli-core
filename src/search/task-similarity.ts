import { normalize } from "../store/normalize.js"
import { createStemmer, DEFAULT_STEMMERS, type Stemmer } from "./stem.js"
import { amountOf, dayOf, dueDayOf, type TaskAmount } from "./task-signature.js"

/**
 * How alike two tasks are, field by field, as the tasks plan's duplicate chain scores them
 * (`docs/dev/tasks-plan.md`, "Duplicates — the comparison chain" § 1, 4, 5). Ported from the scorer that
 * tuned the weights, WireCatLabs/cli-testing `performance/tasks/duplicates/` (cli-testing#60); the counts
 * quoted beside each weight are that run's duplicate / other candidate pairs at the level.
 */

const DAY = 86_400_000

export type TaskSide = {
  title: string
  description?: string
  /** `person:<id>` of whoever the task is from; the caller resolves it through identities. */
  person?: string
  category?: string
  /** Given by an agent (`--amount`); when absent the text is read for one. `null` says there is none. */
  amount?: TaskAmount | null
  /** Given by an agent (`--due`); when absent the text is read for one. `null` says there is none. */
  due?: Date | null
  createdAt: Date
  /** One message the task stands on, read with its own text at compare time; a task never stores message text. */
  message?: { text: string; sentAt: Date }
}

export type PreparedTask = {
  stems: ReadonlySet<string>
  trigrams: ReadonlySet<string>
  person?: string
  category?: string
  amount: TaskAmount | null
  dueDay: number | null
  createdMs: number
}

const STOP_WORDS = new Set(
  [
    // Russian and English as the test set ran them, already folded (пожалуйста → пожалуиста).
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от",
    "меня еще нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь",
    "там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без чего раз тоже",
    "себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мои тем чтобы нее",
    "сейчас были куда зачем всех можно при об другой хоть после над больше тот через эти нас про всего них какая",
    "много три эту моя свою этой перед им всегда между пожалуиста плиз",
    "i me my we our you your he him his she her it its they them their what which who this that these those am",
    "is are was were be been being have has had do does did a an the and but if or because as until while of at",
    "by for with about against between into through during before after above below to from up down in out on off",
    "over under again further then once here there when where why how all any both each few more most other some",
    "such no nor not only own same so than too very s t can will just don should now please pls hi hey",
    // Spanish, not in the test set (it had no Spanish task); English look-alikes (son, hay, todo) left out.
    "de la que el en y o u e los las del al lo le les se su sus mi mis tu te ti yo nos un una unos unas por para",
    "con sin sobre entre hasta desde como mas pero muy ya si ni este esta esto estos estas ese esa eso es ser fue",
    "ha han porque cuando donde tambien favor",
  ]
    .join(" ")
    .split(" "),
)

/** `15 000` (any space) and `1,500` become one token; only before exactly three digits, so `20.10` stays a date. */
const joinDigitGroups = (text: string): string => text.replace(/(\d)[ \u00a0\u202f,](?=\d{3}(?!\d))/gu, "$1")

/** What `task_words` holds: the search normalizer, digit groups joined. Message and note words keep `normalize` alone. */
export const taskWordsOf = (text: string): string => normalize(joinDigitGroups(text))

const defaultStemmer = createStemmer(DEFAULT_STEMMERS)

/** What `task_stems` holds and the candidate lookup matches: one cleaning for both sides, or bm25 compares unlike. */
export const taskStemsOf = (text: string, stemmer: Stemmer): Set<string> =>
  new Set(
    stemmer
      .explain(joinDigitGroups(text))
      .filter(({ word }) => !STOP_WORDS.has(normalize(word)))
      .map(({ stem }) => stem),
  )

const trigramsOf = (text: string): Set<string> => {
  const grams = new Set<string>()
  for (let at = 0; at + 3 <= text.length; at++) grams.add(text.slice(at, at + 3))
  return grams
}

/** `stemmer` is the store's configured one; the default stems Latin words with both English and Spanish. */
export const prepareTask = (task: TaskSide, stemmer: Stemmer = defaultStemmer): PreparedTask => {
  const description = task.description ?? ""
  const createdMs = task.createdAt.getTime()
  const signatureText = normalize(joinDigitGroups(`${description}\n${task.title}`))
  const { message } = task
  const messageText = message === undefined ? "" : normalize(joinDigitGroups(message.text))
  // The task's own words first; a message's "tomorrow" is read from when that message was sent.
  const amountIn = () => amountOf(signatureText) ?? (message === undefined ? null : amountOf(messageText))
  const dueIn = () =>
    dueDayOf(signatureText, createdMs) ??
    (message === undefined ? null : dueDayOf(messageText, message.sentAt.getTime()))
  return {
    stems: taskStemsOf(`${task.title}\n${description}${message === undefined ? "" : `\n${message.text}`}`, stemmer),
    trigrams: trigramsOf(normalize(joinDigitGroups(task.title))),
    ...(task.person === undefined ? {} : { person: task.person }),
    ...(task.category === undefined ? {} : { category: task.category }),
    amount: task.amount === undefined ? amountIn() : task.amount,
    dueDay: task.due === undefined ? dueIn() : task.due === null ? null : dayOf(task.due.getTime()),
    createdMs,
  }
}

type Weighted = { weight: number; why: string }

/**
 * The only place the weights live. Levels no duplicate in the set showed keep the plan's first-draft value:
 * an estimate from a zero count reflects how the set was written, not evidence.
 */
export const TASK_SIMILARITY_WEIGHTS = {
  text: {
    high: { weight: 5, why: "Jaccard ≥ 0.6: 11 / 18; +5 estimated on both halves" },
    middle: { weight: 5, why: "Jaccard 0.3–0.6: 54 / 102; reminders are short, so worth as much as ≥ 0.6" },
    low: { weight: -2, why: "Jaccard < 0.3: 15 / 4493" },
  },
  person: {
    same: { weight: 1, why: "80 / 2149; candidates come mostly from the same-person lookup, so most share it" },
    different: { weight: -3, why: "0 / 2293; no duplicate showed it, first-draft value kept" },
    unknown: { weight: 0, why: "0 / 171; no duplicate showed it, first-draft value kept" },
  },
  amount: {
    equal: { weight: 6, why: "20 / 13; the least stable weight: +10 on half A, +6 on half B" },
    different: { weight: -4, why: "0 / 849; no duplicate showed it, first-draft value kept" },
    missing: { weight: 0, why: "60 / 3751" },
  },
  category: {
    same: { weight: 1, why: "80 / 2667" },
    different: { weight: -1, why: "0 / 1946; no duplicate showed it, first-draft value kept" },
    unknown: { weight: 0, why: "not in the set: every task there had a category" },
  },
  due: {
    near: { weight: 4, why: "≤ 2 days apart: 26 / 126" },
    far: { weight: -1, why: "more than 2 days apart: 4 / 707" },
    missing: { weight: 0, why: "50 / 3780" },
  },
  reply: {
    yes: {
      weight: 2,
      why: "real chats: wrong 11 times in 13 among shown pairs; +2 lifted shown-pair precision on both labelled sets",
    },
    no: { weight: 0, why: "74 / 4608" },
  },
  time: {
    near: { weight: 2, why: "≤ 3 days apart: 69 / 888" },
    weeks: { weight: -2, why: "4–14 days apart: 8 / 2456" },
    far: { weight: -3, why: "more than 14 days apart: 3 / 1269" },
  },
} as const satisfies Record<string, Record<string, Weighted>>

/**
 * Likely only orders a list; nothing merges on a score. On the set, ≥ 10 is 85% precise at 43% recall, and
 * the first threshold with no wrong pair (≥ 16) finds 4% of duplicates. ≥ 5 puts 90% of duplicates in maybe or
 * likely at 58% precision, refusing 21% of new tasks.
 */
export const TASK_SIMILARITY_BANDS = { likely: 10, maybe: 5 } as const

type Weights = typeof TASK_SIMILARITY_WEIGHTS
export type SimilarityLevels = { [Field in keyof Weights]: keyof Weights[Field] }
export type SimilarityBand = "likely" | "maybe" | "different"

export type Similarity = {
  score: number
  band: SimilarityBand
  levels: SimilarityLevels
  /** What says the two are one job, as a candidate list shows it; category and age stay in `levels`. */
  reasons: string[]
  text: { sharedStems: number; allStems: number; stems: number; trigrams: number }
}

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  const all = a.size + b.size - shared
  return { shared, all, jaccard: a.size && b.size ? shared / all : 0 }
}

const LEVEL_REASONS: { [Field in "person" | "amount"]: Partial<Record<SimilarityLevels[Field], string>> } = {
  person: { same: "same person", different: "different person" },
  amount: { equal: "same amount", different: "different amount" },
}

const weightOf = <Field extends keyof Weights>(field: Field, level: SimilarityLevels[Field]): number =>
  (TASK_SIMILARITY_WEIGHTS[field][level] as Weighted).weight

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

export const bandOf = (score: number): SimilarityBand =>
  score >= TASK_SIMILARITY_BANDS.likely ? "likely" : score >= TASK_SIMILARITY_BANDS.maybe ? "maybe" : "different"

/** `replyChain`: the source messages reply to one another — the caller knows the messages, this module does not. */
export const compareTasks = (
  a: PreparedTask,
  b: PreparedTask,
  { replyChain = false }: { replyChain?: boolean } = {},
): Similarity => {
  const stems = overlap(a.stems, b.stems)
  const trigrams = overlap(a.trigrams, b.trigrams).jaccard
  const text = Math.max(stems.jaccard, trigrams)
  const days = Math.abs(a.createdMs - b.createdMs) / DAY
  const dueApart = a.dueDay !== null && b.dueDay !== null ? Math.abs(a.dueDay - b.dueDay) : null
  const levels: SimilarityLevels = {
    text: text >= 0.6 ? "high" : text >= 0.3 ? "middle" : "low",
    person: a.person && b.person ? (a.person === b.person ? "same" : "different") : "unknown",
    amount:
      a.amount && b.amount
        ? a.amount.value === b.amount.value &&
          (a.amount.currency === b.amount.currency || !a.amount.currency || !b.amount.currency)
          ? "equal"
          : "different"
        : "missing",
    category: a.category && b.category ? (a.category === b.category ? "same" : "different") : "unknown",
    due: dueApart === null ? "missing" : dueApart <= 2 ? "near" : "far",
    reply: replyChain ? "yes" : "no",
    time: days <= 3 ? "near" : days <= 14 ? "weeks" : "far",
  }
  const score =
    weightOf("text", levels.text) +
    weightOf("person", levels.person) +
    weightOf("amount", levels.amount) +
    weightOf("category", levels.category) +
    weightOf("due", levels.due) +
    weightOf("reply", levels.reply) +
    weightOf("time", levels.time)
  const textReason =
    stems.jaccard >= trigrams
      ? `${stems.shared} of ${plural(stems.all, "stem")} shared`
      : `titles ${Math.round(trigrams * 100)}% alike letter by letter`
  const reasons = [
    LEVEL_REASONS.person[levels.person],
    LEVEL_REASONS.amount[levels.amount],
    dueApart === null ? undefined : dueApart === 0 ? "same due date" : `due ${plural(dueApart, "day")} apart`,
    replyChain ? "in one reply chain" : undefined,
    textReason,
  ].filter((reason): reason is string => reason !== undefined)
  return {
    score,
    band: bandOf(score),
    levels,
    reasons,
    text: { sharedStems: stems.shared, allStems: stems.all, stems: stems.jaccard, trigrams },
  }
}

/**
 * A task read several ways — its own text alone, then its text with each message it stands on — compared view by
 * view; the best pair counts whole, so the text never comes from one message and the amount from another. Keeping
 * the own-text view means a linked message can raise a score, never lower it.
 */
export const compareViews = (
  a: readonly PreparedTask[],
  b: readonly PreparedTask[],
  options: { replyChain?: boolean } = {},
): Similarity => {
  let best: Similarity | undefined
  for (const one of a)
    for (const other of b) {
      const scored = compareTasks(one, other, options)
      if (!best || scored.score > best.score) best = scored
    }
  if (!best) throw new Error("compareViews needs at least one view on each side")
  return best
}

export type TaskCandidate<Id> = {
  id: Id
  views: readonly PreparedTask[]
  replyChain?: boolean
  /** The new task's views to use against this one, when not all of them. */
  subjectViews?: readonly PreparedTask[]
}

/** Every candidate scored against the new task, best first; ties keep the order they came in. */
export const rankCandidates = <Id>(
  views: readonly PreparedTask[],
  candidates: readonly TaskCandidate<Id>[],
): (Similarity & { id: Id })[] =>
  candidates
    .map(({ id, views: candidate, replyChain, subjectViews }) => ({
      id,
      ...compareViews(subjectViews ?? views, candidate, replyChain === undefined ? {} : { replyChain }),
    }))
    .sort((a, b) => b.score - a.score)
