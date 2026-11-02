import { CliError } from "@wirecat/cli-base"
import { dateRange, defineQuery, type Predicate, queryError, timezoneOf } from "@wirecat/cli-base/query"
import type { ListWindow } from "../../services/messages.js"
import { listQuery, nativeField, nativeTermLists, type QueryWords, typedQuery } from "../list-query.js"

/** What a chat's history can be read by: where it starts, and one topic. */
export const HISTORY_QUERY = defineQuery({
  entity: "message",
  backend: "native",
  fields: [
    nativeField({ name: "id", type: "kw", operators: ["range"], example: "id<42" }),
    nativeField({ name: "date", type: "time", operators: ["range"], example: "date>2026-10-01" }),
    nativeField({ name: "topic", type: "kw", operators: ["term"], example: "topic:12" }),
  ],
})

const STARRED = nativeField({ name: "starred", type: "bool", operators: ["term"], example: "starred:true" })

const historyQueryOf = (topics: boolean, stars: boolean) =>
  defineQuery({
    entity: "message",
    backend: "native",
    fields: [...HISTORY_QUERY.fields.filter((field) => topics || field.name !== "topic"), ...(stars ? [STARRED] : [])],
  })

const HISTORY_QUERIES = {
  untopical: historyQueryOf(false, false),
  starred: historyQueryOf(true, true),
  untopicalStarred: historyQueryOf(false, true),
}

/** The history query of a messenger: without `topic:` where it has no forum topics, `starred:` where it has stars. */
export const historyQuery = (messenger: { topics?: boolean; messageStars?: boolean }) => {
  const stars = messenger.messageStars === true
  if (messenger.topics === false) return stars ? HISTORY_QUERIES.untopicalStarred : HISTORY_QUERIES.untopical
  return stars ? HISTORY_QUERIES.starred : HISTORY_QUERY
}

const COMMENTS_QUERY = defineQuery({
  entity: "message",
  backend: "native",
  fields: [nativeField({ name: "id", type: "kw", operators: ["range"], example: "id<42" })],
})

export { COMMENTS_QUERY }

type Start = Pick<ListWindow, "before" | "beforeTime" | "after" | "until">

/**
 * Where the last page stopped and which way it read: `before:<id>` goes on back, `after:<id>` forward. A window's end
 * travels as `~<epoch ms>`, so a resumed read stops where the first one would have. Ids are opaque, so only the first
 * colon splits it.
 */
export const cursorOf = (start: Start, edge: { first?: string; last?: string }): string | undefined => {
  const forward = start.after !== undefined
  const id = forward ? edge.last : edge.first
  if (id === undefined) return undefined
  const end = forward && start.until !== undefined ? `~${start.until}` : ""
  return `${forward ? "after" : "before"}:${id}${end}`
}

const isId = (value: string) => value !== "" && !/[\s\p{Cc}]/u.test(value)

const fromCursor = (cursor: string): Start => {
  const at = cursor.indexOf(":")
  const [way, rest] = at < 0 ? [cursor, ""] : [cursor.slice(0, at), cursor.slice(at + 1)]
  const ended = way === "after" ? /^(.*)~(\d+)$/u.exec(rest) : null
  const id = ended ? (ended[1] as string) : rest
  if (!isId(id) || (way !== "before" && way !== "after"))
    throw new CliError(
      "validation_error",
      `--cursor takes what page.next gave, before:<id> or after:<id> — not "${cursor}"`,
    )
  if (way === "before") return { before: id }
  return { after: { id }, ...(ended ? { until: Number(ended[2]) } : {}) }
}

type Bound = { start: Start; span: Predicate["span"]; date: boolean }

/** A term's lower and upper bound; a date's as moments in the zone, an exclusive end 1 ms inside. */
const boundsOf = (term: Predicate, command: string): { lower?: Bound; upper?: Bound } => {
  const context = { command }
  const hasLower = term.value !== "*"
  const hasUpper = term.upper !== undefined && term.upper !== "*"
  const span = term.span
  if (term.field === "id") {
    if (hasLower === hasUpper) queryError("query.unsupported-operator", span, "id takes one side: id< or id>", context)
    return hasLower
      ? { lower: { start: { after: { id: term.value } }, span, date: false } }
      : { upper: { start: { before: term.upper as string }, span, date: false } }
  }
  if (!hasLower && !hasUpper)
    queryError("query.unsupported-operator", span, `${term.field} needs a start, an end or both`, context)
  const range = dateRange(
    term.value,
    term.upper ?? "*",
    term.lower_inclusive ?? true,
    term.upper_inclusive ?? true,
    timezoneOf(),
    span,
  )
  if ((hasLower && range.lower === undefined) || (hasUpper && range.upper === undefined))
    queryError("query.invalid-date", span, "that is not a time", context)
  return {
    // The messenger and the store read strictly after a start, so an inclusive one moves 1 ms back.
    ...(range.lower === undefined
      ? {}
      : { lower: { start: { after: { time: range.lower - (range.lower_inclusive ? 1 : 0) } }, span, date: true } }),
    ...(range.upper === undefined
      ? {}
      : { upper: { start: { until: range.upper - (range.upper_inclusive ? 0 : 1) }, span, date: true } }),
  }
}

/**
 * The window the query names. A start reads forward from it, oldest first, and stops at an end; an end alone reads
 * back from it, newest page first.
 */
const windowOf = (terms: readonly Predicate[], command: string): Start => {
  const context = { command }
  const lowers: Bound[] = []
  const uppers: Bound[] = []
  for (const term of terms) {
    const { lower, upper } = boundsOf(term, command)
    if (lower) lowers.push(lower)
    if (upper) uppers.push(upper)
  }
  const [lower, extraLower] = lowers
  const [upper, extraUpper] = uppers
  if (extraLower) queryError("query.unsupported-placement", extraLower.span, "the window has one start", context)
  if (extraUpper) queryError("query.unsupported-placement", extraUpper.span, "the window has one end", context)
  if (lower && upper && !upper.date)
    queryError("query.unsupported-placement", upper.span, "a window from a start ends at a date: date<…", context)
  if (lower) return { ...lower.start, ...upper?.start }
  if (upper?.start.until !== undefined) return { beforeTime: upper.start.until + 1 }
  return upper?.start ?? {}
}

/** A list reads one way from one place: the query or the cursor names at most one window. */
export const historyWindow = (
  words: QueryWords,
  cursor: string | undefined,
  command: string,
  registry = HISTORY_QUERY,
): Omit<ListWindow, "limit"> => {
  const terms = nativeTermLists(listQuery(typedQuery(words), registry, command), command, ["date", "id"])
  const bounds = [...(terms.get("date") ?? []), ...(terms.get("id") ?? [])]
  const start = windowOf(bounds, command)
  if (cursor !== undefined && bounds.length > 0)
    throw new CliError("validation_error", "the query and --cursor name two starting points; give one of them")
  const topic = terms.get("topic")?.[0]?.value
  const starred = terms.get("starred")?.[0]?.value.toLowerCase()
  return {
    ...(cursor === undefined ? start : fromCursor(cursor)),
    ...(topic === undefined ? {} : { threadId: topic }),
    ...(starred === undefined ? {} : { starred: starred === "true" }),
  }
}

/**
 * The query `page.next` reruns with its cursor: the topic and the stars, never the bounds, which the cursor carries
 * and which would name a second starting point beside it.
 */
export const resumeQuery = (words: QueryWords, command: string, registry = HISTORY_QUERY): string | undefined => {
  const terms = nativeTermLists(listQuery(typedQuery(words), registry, command), command, ["date", "id"])
  const kept = ["topic", "starred"].flatMap((field) => terms.get(field)?.map((term) => `${field}:${term.value}`) ?? [])
  return kept.length > 0 ? kept.join(" ") : undefined
}
