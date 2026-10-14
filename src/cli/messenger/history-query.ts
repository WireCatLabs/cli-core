import { CliError } from "@wirecat/cli-base"
import { dateEndpoint, defineQuery, type Predicate, queryError, timezoneOf } from "@wirecat/cli-base/query"
import type { ListWindow } from "../../services/messages.js"
import { listQuery, nativeField, nativeTerms, type QueryWords, typedQuery } from "../list-query.js"

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

const COMMENTS_QUERY = defineQuery({
  entity: "message",
  backend: "native",
  fields: [nativeField({ name: "id", type: "kw", operators: ["range"], example: "id<42" })],
})

export { COMMENTS_QUERY }

type Start = Pick<ListWindow, "before" | "beforeTime" | "after">

/**
 * Where the last page stopped and which way it read: `before:<id>` goes on back, `after:<id>` forward. Ids are
 * opaque, so only the first colon splits it.
 */
export const cursorOf = (start: Start, edge: { first?: string; last?: string }): string | undefined => {
  const forward = start.after !== undefined
  const id = forward ? edge.last : edge.first
  return id === undefined ? undefined : `${forward ? "after" : "before"}:${id}`
}

const isId = (value: string) => value !== "" && !/[\s\p{Cc}]/u.test(value)

const fromCursor = (cursor: string): Start => {
  const at = cursor.indexOf(":")
  const [way, id] = at < 0 ? [cursor, ""] : [cursor.slice(0, at), cursor.slice(at + 1)]
  if (!isId(id) || (way !== "before" && way !== "after"))
    throw new CliError(
      "validation_error",
      `--cursor takes what page.next gave, before:<id> or after:<id> — not "${cursor}"`,
    )
  return way === "before" ? { before: id } : { after: { id } }
}

const startOf = (term: Predicate, command: string): Start => {
  const context = { command }
  const older = term.value === "*" && term.upper !== undefined && term.upper !== "*"
  const newer = term.value !== "*" && (term.upper === undefined || term.upper === "*")
  if (older === newer)
    queryError(
      "query.unsupported-operator",
      term.span,
      `${term.field} takes one side: ${term.field}< or ${term.field}>`,
      context,
    )
  if (term.field === "id") return older ? { before: term.upper as string } : { after: { id: term.value } }
  const bound = older ? (term.upper as string) : term.value
  const inclusive = (older ? term.upper_inclusive : term.lower_inclusive) ?? true
  const { time } = dateEndpoint(bound, timezoneOf(), older ? "upper" : "lower", inclusive, term.span)
  if (time === undefined) queryError("query.invalid-date", term.span, `${bound} is not a time`, context)
  return older ? { beforeTime: time } : { after: { time } }
}

/** A list reads one way from one place: the query or the cursor names at most one starting point. */
export const historyWindow = (
  words: QueryWords,
  cursor: string | undefined,
  command: string,
  registry = HISTORY_QUERY,
): Omit<ListWindow, "limit"> => {
  const terms = [...nativeTerms(listQuery(typedQuery(words), registry, command), command).values()]
  const starts = terms.filter((term) => term.field !== "topic").map((term) => startOf(term, command))
  if (cursor !== undefined) starts.push(fromCursor(cursor))
  if (starts.length > 1)
    throw new CliError("validation_error", "the query and --cursor name two starting points; give one of them")
  const topic = terms.find((term) => term.field === "topic")?.value
  return { ...starts[0], ...(topic === undefined ? {} : { threadId: topic }) }
}
