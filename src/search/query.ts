import { CliError } from "@wirecat/cli-base"
import type { Provider } from "../domain/models.js"

export type Term = { kind: "word"; text: string } | { kind: "phrase"; words: string[] }

/** `personal` and `bots` split `all`: a bot's account is one whose provider ends in `-bot` (`isBotProvider`). */
export type Source = Provider | "personal" | "bots" | "all"

/** How the store tells a bot's copy from a personal account: `max-bot`, `telegram-bot`. */
export const isBotProvider = (provider: Provider): boolean => provider.endsWith("-bot")

/** Whether an account of `provider` is inside `source`. */
export const inSource = (source: Source, provider: Provider): boolean =>
  source === "all" ||
  (source === "bots" && isBotProvider(provider)) ||
  (source === "personal" && !isBotProvider(provider)) ||
  source === provider

/**
 * A parsed search (phase 2 plan §4). `required` is AND of groups, each group OR of terms — OR binds
 * tighter than the implied AND. Words are as typed; normalizing them is the search's job.
 */
export interface SearchQuery {
  required: Term[][]
  excluded: Term[]
  from?: string
  chat?: string
  /** Epoch ms, inclusive. */
  after?: number
  /** Epoch ms, exclusive. */
  before?: number
  has: string[]
  in?: Source
}

const FILTERS = ["from", "chat", "after", "before", "has", "in"] as const
type Filter = (typeof FILTERS)[number]
const DAY = 24 * 60 * 60 * 1000

interface Token {
  negated: boolean
  filter?: Filter
  /** A quoted piece is a phrase, and a quoted `OR` is the word "or". */
  quoted: boolean
  text: string
}

const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}

const tokenize = (query: string): Token[] => {
  const tokens: Token[] = []
  let at = 0
  while (at < query.length) {
    if (/\s/.test(query[at] ?? "")) {
      at++
      continue
    }
    let negated = false
    let filter: Filter | undefined
    const rest = query.slice(at)
    const named = /^([a-z]+):(?=\S)/i.exec(rest)
    const name = named?.[1]?.toLowerCase()
    if (named && FILTERS.includes(name as Filter)) {
      filter = name as Filter
      at += named[0].length
    } else if (query[at] === "-" && query[at + 1] !== undefined && /\S/.test(query[at + 1] ?? "")) {
      negated = true
      at++
    }
    if (query[at] === '"') {
      const end = query.indexOf('"', at + 1)
      const close = end === -1 ? query.length : end
      tokens.push({ negated, ...(filter ? { filter } : {}), quoted: true, text: query.slice(at + 1, close).trim() })
      at = close + 1
      continue
    }
    const end = query.slice(at).search(/\s/)
    const close = end === -1 ? query.length : at + end
    tokens.push({ negated, ...(filter ? { filter } : {}), quoted: false, text: query.slice(at, close) })
    at = close
  }
  return tokens
}

const termOf = (token: Token): Term => {
  const words = token.text.split(/\s+/).filter(Boolean)
  return token.quoted && words.length > 1 ? { kind: "phrase", words } : { kind: "word", text: words.join(" ") }
}

const day = (name: string, value: string, now: number): number => {
  const back = /^(\d+)d$/.exec(value)
  if (back) return now - Number(back[1]) * DAY
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const at = date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])) : undefined
  if (!at || at.getMonth() !== Number(date?.[2]) - 1 || at.getDate() !== Number(date?.[3])) {
    return fail(`${name}: takes a day, 2026-01-31, or a count of days back, 7d — not "${value}"`)
  }
  return at.getTime()
}

/** `in:` and `--source` take a messenger the store holds, `personal`, `bots` or `all`. */
export const sourceOf = (name: string, value: string, providers: readonly Provider[]): Source => {
  const sources: Source[] = [...providers, "personal", "bots", "all"]
  const source = value.toLowerCase()
  if (!sources.includes(source)) fail(`${name} takes ${sources.join(", ")} — not "${value}"`)
  return source
}

/** `providers` are the messengers the store holds; `in:` takes one of them, or `all`. */
export const parseQuery = (
  query: string,
  { now = Date.now(), providers = [] }: { now?: number; providers?: readonly Provider[] } = {},
): SearchQuery => {
  const parsed: SearchQuery = { required: [], excluded: [], has: [] }
  const tokens = tokenize(query)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token
    if (token.filter) {
      const { filter, text } = token
      if (text === "") fail(`${filter}: needs a value`)
      if (filter === "has") {
        parsed.has.push(text.toLowerCase())
        continue
      }
      if (parsed[filter] !== undefined) fail(`${filter}: is given twice`)
      if (filter === "after" || filter === "before") parsed[filter] = day(filter, text, now)
      else if (filter === "in") parsed.in = sourceOf("in:", text, providers)
      else parsed[filter] = text
      continue
    }
    if (token.text === "") continue
    if (!token.quoted && token.text === "OR") {
      const previous = tokens[index - 1]
      const next = tokens[index + 1]
      if (previous?.negated || next?.negated) fail("a word left out cannot be one side of OR")
      const word = (side?: Token) => side && !side.filter && side.text !== "" && (side.quoted || side.text !== "OR")
      if (!word(previous) || !word(next)) fail("OR needs a word on each side")
      parsed.required.at(-1)?.push(termOf(next as Token))
      index++
      continue
    }
    if (token.negated) parsed.excluded.push(termOf(token))
    else parsed.required.push([termOf(token)])
  }
  if (parsed.required.length === 0 && parsed.excluded.length > 0) {
    fail("say what to find, not only what to leave out")
  }
  return parsed
}
