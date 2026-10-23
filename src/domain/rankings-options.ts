import { CliError } from "@wirecat/cli-base"

export const MESSAGE_MEASURES = ["views", "reactions", "forwards", "comments", "replies", "thread-size"] as const
export const AUTHOR_MEASURES = [
  "messages",
  "words",
  "reactions",
  "replies",
  "answers",
  "answer-time",
  "threads",
  "active-days",
] as const
export type RankingTarget = "messages" | "contacts"
export type MessageKind = "all" | "posts" | "comments"
export type RankingMeasure = (typeof MESSAGE_MEASURES)[number] | (typeof AUTHOR_MEASURES)[number]
export type RankingComponent =
  | Exclude<RankingMeasure, "answer-time">
  | "replies-from-others"
  | "reactions-per-message"
  | "replies-from-others-per-message"
export type ScorePreset = "helpful" | "active" | "engaging"
export type RankingWeights = Partial<Record<RankingComponent, number>>
export interface RankingInput {
  measure?: string
  score?: string
  weights?: unknown
  minMessages?: number
  messageKind?: string
}
export interface RankingOptions {
  target: RankingTarget
  measure: RankingMeasure | "score"
  order: "ascending" | "descending"
  minMessages: number
  messageKind: MessageKind
  weights: RankingWeights | null
  preset: ScorePreset | "custom" | null
  components: (RankingMeasure | RankingComponent)[]
}
const CONTEXT = new Set([
  "replies",
  "replies-from-others",
  "replies-from-others-per-message",
  "thread-size",
  "threads",
  "answers",
  "answer-time",
])
export const needsRankingContext = (options: RankingOptions): boolean =>
  options.components.some((name) => CONTEXT.has(name))

const presets: Record<ScorePreset, RankingWeights> = {
  helpful: { answers: 0.5, "replies-from-others": 0.25, reactions: 0.25 },
  active: { "active-days": 0.6, messages: 0.4 },
  engaging: { "reactions-per-message": 0.5, "replies-from-others-per-message": 0.5 },
}
function invalid(message: string): never {
  throw new CliError("validation_error", message, { reason: "ranking.invalid" })
}

export const rankingOptions = (target: RankingTarget, input: RankingInput): RankingOptions => {
  const measures: readonly string[] = target === "messages" ? MESSAGE_MEASURES : AUTHOR_MEASURES
  const { measure, score, weights: given, minMessages } = input
  const messageKind = input.messageKind ?? "all"
  if (!["all", "posts", "comments"].includes(messageKind)) invalid("message_kind takes all, posts or comments")
  if (target === "messages" && minMessages !== undefined) invalid("min_messages applies to stats contacts top")
  if (minMessages !== undefined && (!Number.isSafeInteger(minMessages) || minMessages < 1))
    invalid("min_messages takes a positive integer")
  if (measure !== undefined && !measures.includes(measure)) invalid(`--measure takes ${measures.join(", ")}`)
  if (measure !== undefined && (score !== undefined || given !== undefined))
    invalid("--measure cannot be combined with --score or --weights")
  if (score !== undefined && !["helpful", "active", "engaging"].includes(score))
    invalid("--score takes helpful, active or engaging")
  if (target === "messages" && score !== undefined && score !== "engaging")
    invalid("helpful and active scores apply to authors only")
  const scoring = score !== undefined || given !== undefined
  const preset = score as ScorePreset | undefined
  let weights: RankingWeights | null = null
  if (scoring) {
    let raw: unknown =
      given !== undefined
        ? given
        : target === "messages"
          ? { reactions: 0.5, "replies-from-others": 0.5 }
          : presets[preset as ScorePreset]
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw)
      } catch {
        invalid("--weights takes a JSON object of component weights")
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      invalid("--weights takes a JSON object of component weights")
    const allowed: readonly string[] =
      target === "messages"
        ? [...MESSAGE_MEASURES, "replies-from-others"]
        : [
            ...AUTHOR_MEASURES.filter((name) => name !== "answer-time"),
            "replies-from-others",
            "reactions-per-message",
            "replies-from-others-per-message",
          ]
    const entries = Object.entries(raw)
    for (const [name, weight] of entries) {
      if (!allowed.includes(name)) invalid(`unknown ${target} score component: ${name}`)
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0)
        invalid(`weight for ${name} must be a finite nonnegative number`)
    }
    if (!entries.some(([, weight]) => (weight as number) > 0)) invalid("--weights needs at least one positive weight")
    weights = Object.fromEntries(entries) as RankingWeights
  }
  const selected = (measure ?? (target === "messages" ? "reactions" : "messages")) as RankingMeasure
  return {
    target,
    messageKind: messageKind as MessageKind,
    minMessages: minMessages ?? (target === "contacts" && score === "engaging" ? 5 : 1),
    measure: scoring ? "score" : selected,
    order: !scoring && selected === "answer-time" ? "ascending" : "descending",
    weights,
    preset: scoring ? (preset ?? "custom") : null,
    components:
      weights === null
        ? [selected]
        : Object.entries(weights)
            .filter(([, weight]) => weight > 0)
            .map(([name]) => name as RankingComponent),
  }
}

export interface ScoreComponents {
  score: number
  normalized: Partial<Record<RankingComponent, number>>
  contributions: Partial<Record<RankingComponent, number>>
}

/** Scale weights first so valid finite weights cannot overflow their sum. */
export const rankingScore = (
  raw: Partial<Record<RankingComponent, number | null>>,
  maxima: Partial<Record<RankingComponent, number>>,
  weights: RankingWeights,
): ScoreComponents | null => {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0) as [RankingComponent, number][]
  const scale = Math.max(...entries.map(([, weight]) => weight))
  const denominator = entries.reduce((sum, [, weight]) => sum + weight / scale, 0)
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(denominator) || denominator <= 0) return null
  const normalized: ScoreComponents["normalized"] = {}
  const contributions: ScoreComponents["contributions"] = {}
  let sum = 0
  for (const [name, weight] of entries) {
    const value = raw[name]
    const maximum = maxima[name]
    if (
      value == null ||
      !Number.isFinite(value) ||
      value < 0 ||
      maximum === undefined ||
      !Number.isFinite(maximum) ||
      maximum < value
    )
      return null
    const part = maximum === 0 ? 0 : value / maximum
    normalized[name] = part
    contributions[name] = (100 * part * (weight / scale)) / denominator
    sum += contributions[name]
  }
  return { score: Math.min(100, sum), normalized, contributions }
}

export const RANKING_TOKENIZER_VERSION = 1
const withoutUrls = (text: string): string =>
  text.replace(/\S+/gu, (token) => {
    for (let offset = 0; ; ) {
      const marker = token.indexOf("://", offset)
      if (marker < 0) break
      let start = marker
      while (start > 0 && /[a-z0-9+.-]/iu.test(token[start - 1] as string)) start--
      if (
        /^[a-z][a-z0-9+.-]*$/iu.test(token.slice(start, marker)) &&
        (start === 0 || !/\w/u.test(token[start - 1] as string))
      )
        return token.slice(0, start)
      offset = marker + 3
    }
    const folded = token.toLowerCase()
    for (let offset = 0; ; ) {
      const start = folded.indexOf("www.", offset)
      if (start < 0) break
      if (start === 0 || !/\w/u.test(token[start - 1] as string)) return token.slice(0, start)
      offset = start + 4
    }
    return token
  })
export const rankingWords = (text: string): number => withoutUrls(text).match(/[\p{L}\p{N}]+/gu)?.length ?? 0
export const rankingQuestion = (text: string): boolean => withoutUrls(text).includes("?")
