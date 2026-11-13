import { CliError } from "@wirecat/cli-base"
import {
  dateRange,
  dayBoundary,
  type Predicate,
  type QueryAst,
  type QueryNode,
  type QueryRegistry,
  timezoneOf,
} from "@wirecat/cli-base/query"
import type { DocumentListRequest, MeetingListRequest } from "../services/listings.js"
import { DOCUMENT_KINDS, MEETING_ROW_KINDS, type MeetingRowKind } from "../store/index.js"
import { listQuery, nativeField, nativeTermLists, type QueryWords, termField, typedQuery } from "./list-query.js"

const SOURCE = termField("source", "kw", 'source:"google-drive:ana@example.com"', {
  relation: "one account, provider:account, or every account of a provider; repeat for several",
})

/** `documents list`: what the store filters, and `text`, which the notes search answers first. */
export const DOCUMENTS_LIST_QUERY = {
  entity: "document_entry",
  backend: "native",
  fields: [
    nativeField({
      name: "text",
      type: "txt",
      operators: ["term", "phrase"],
      example: "text:budget",
      relation: "words in the title or the text, found as search notes finds them; a bare word means text:",
    }),
    SOURCE,
    termField("kind", "enum", "kind:pdf", { values: DOCUMENT_KINDS, relation: "repeat for any of several" }),
    termField("folder", "kw", 'folder:"Projects/Acme"', {
      relation: "in this folder of its account or in a folder under it",
    }),
    nativeField({
      name: "source_modified_at",
      type: "time",
      operators: ["term", "range"],
      example: "source_modified_at:[2026-10-01 TO 2026-11-01}",
    }),
    termField("has_text", "bool", "has_text:false", { relation: "whether the store holds its text" }),
    termField("tag", "kw", "tag:budget", { relation: "a local owner tag" }),
    termField("person", "kw", 'person:"person:12"', { relation: "a person it is linked to, as person:<id>" }),
  ],
} as const satisfies QueryRegistry

/** `meetings list`: the time window, and filters every row answers. */
export const MEETINGS_LIST_QUERY = {
  entity: "meeting_entry",
  backend: "native",
  fields: [
    nativeField({
      name: "text",
      type: "txt",
      operators: ["term", "phrase"],
      example: "text:standup",
      relation: "words its title holds, in any letter case; a bare word means text:",
    }),
    nativeField({
      name: "started_at",
      type: "time",
      operators: ["term", "range"],
      example: "started_at:[2026-11-02 TO 2026-11-09}",
      relation: "rows that overlap this time; a week or a month for a calendar",
    }),
    SOURCE,
    termField("kind", "enum", "kind:call", { values: MEETING_ROW_KINDS, relation: "repeat for any of several" }),
    termField("person", "kw", 'person:"person:12"', {
      relation: "invited, took part, or was on the other end of a call, as person:<id>",
    }),
    termField("has_transcript", "bool", "has_transcript:true", {
      relation: "whether one of its meetings has a transcript",
    }),
  ],
} as const satisfies QueryRegistry

/** Without `started_at`, the meetings list reads the last 30 days and the next 7: calls are all in the past. */
export const MEETINGS_RECENT_DAYS = 30
export const MEETINGS_AHEAD_DAYS = 7

const REPEATABLE = ["text", "source", "kind", "tag", "person"]

const bool = (node: Predicate) => node.value.toLowerCase() === "true"

const termsOf = (words: QueryWords, registry: QueryRegistry, command: string) =>
  nativeTermLists(listQuery(typedQuery(words), registry, command, { defaultField: "text" }), command, REPEATABLE)

const values = (terms: Map<string, Predicate[]>, field: string) => (terms.get(field) ?? []).map(({ value }) => value)

const textOf = (nodes: readonly Predicate[]) =>
  nodes.map((node) => (node.operator === "phrase" ? `"${node.value.replaceAll('"', "")}"` : node.value)).join(" ")

/** The query's terms as one AND, with repeated kinds as an OR inside it, for the store's own fields. */
const storeQueryOf = (terms: Map<string, Predicate[]>, fields: readonly string[]): QueryAst | undefined => {
  const span = { start: 0, end: 0 }
  const clauses: { occur: "must"; node: QueryNode }[] = []
  for (const field of fields) {
    const nodes = terms.get(field) ?? []
    if (nodes.length === 0) continue
    if (field === "kind" && nodes.length > 1)
      clauses.push({
        occur: "must",
        node: { kind: "boolean", clauses: nodes.map((node) => ({ occur: "should" as const, node })), span },
      })
    else for (const node of nodes) clauses.push({ occur: "must", node })
  }
  if (clauses.length === 0) return undefined
  return { version: 1, language: "lucene-v1", root: { kind: "boolean", clauses, span } }
}

/** `documents list`'s query and page, as `listDocuments` takes them. */
export const documentListRequest = (
  words: QueryWords,
  { limit, page, zone = timezoneOf(), now = Date.now() }: { limit: number; page: number; zone?: string; now?: number },
  command = "documents list",
): DocumentListRequest => {
  const terms = termsOf(words, DOCUMENTS_LIST_QUERY, command)
  const sources = values(terms, "source")
  const text = textOf(terms.get("text") ?? [])
  const query = storeQueryOf(terms, ["kind", "folder", "source_modified_at", "has_text", "tag", "person"])
  return {
    ...(sources.length ? { sources } : {}),
    ...(text ? { text } : {}),
    ...(query ? { query } : {}),
    zone,
    now,
    limit,
    offset: (page - 1) * limit,
  }
}

const localDate = (at: number, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)

const plusDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

const midnight = (date: string, zone: string) => dayBoundary(date, zone, false, { start: 0, end: date.length })

/** A `started_at` term as the instants a row must overlap: from `lower` on, and before `upper`. */
const windowOf = (node: Predicate, zone: string, now: number) => {
  const range = dateRange(
    node.value,
    node.operator === "range" ? (node.upper ?? "*") : node.value,
    node.operator === "range" ? node.lower_inclusive !== false : true,
    node.operator === "range" ? node.upper_inclusive !== false : true,
    zone,
    node.span,
    now,
  )
  return {
    ...(range.lower === undefined ? {} : { from: range.lower_inclusive ? range.lower : range.lower + 1 }),
    ...(range.upper === undefined ? {} : { to: range.upper_inclusive ? range.upper + 1 : range.upper }),
  }
}

export interface MeetingWindowMeta {
  timezone: string
  window: { since?: string; until?: string }
}

/** `meetings list`'s query and page, as `listMeetingEntries` takes them, and the window it read for `meta`. */
export const meetingListRequest = (
  words: QueryWords,
  {
    limit,
    page,
    from,
    to,
    order = "newest",
    zone = timezoneOf(),
    now = Date.now(),
  }: {
    limit: number
    page: number
    /** Instants with their offset, as a calendar asks for its window; in place of a `started_at` term. */
    from?: string
    to?: string
    /** `start`: oldest first, so a window cut at `limit` is whole up to its last row. */
    order?: "newest" | "start"
    zone?: string
    now?: number
  },
  command = "meetings list",
): { request: MeetingListRequest; meta: MeetingWindowMeta } => {
  const terms = termsOf(words, MEETINGS_LIST_QUERY, command)
  const started = terms.get("started_at")?.[0]
  const instant = (value: string | undefined, flag: string) => {
    if (value === undefined) return undefined
    const at = Date.parse(value)
    if (!/(?:[zZ]|[+-]\d\d:?\d\d)$/u.test(value) || !Number.isFinite(at))
      throw new CliError("validation_error", `${flag} takes an ISO 8601 instant with its offset, not ${value}`, {
        reason: "input.invalid",
        param: flag,
      })
    return at
  }
  let bounds: { from?: number; to?: number }
  if (from !== undefined || to !== undefined) {
    if (started)
      throw new CliError("validation_error", "give the window as --from/--to or as started_at:, not both", {
        reason: "query.unsupported-placement",
      })
    const lower = instant(from, "--from")
    const upper = instant(to, "--to")
    bounds = { ...(lower === undefined ? {} : { from: lower }), ...(upper === undefined ? {} : { to: upper }) }
  } else if (started) bounds = windowOf(started, zone, now)
  else {
    const today = localDate(now, zone)
    bounds = {
      from: midnight(plusDays(today, -MEETINGS_RECENT_DAYS), zone),
      to: midnight(plusDays(today, MEETINGS_AHEAD_DAYS + 1), zone),
    }
  }
  if (bounds.from !== undefined && bounds.to !== undefined && bounds.to <= bounds.from)
    throw new CliError("validation_error", "started_at's window ends before it starts", {
      reason: "query.empty-window",
    })
  const sources = values(terms, "source")
  const kinds = values(terms, "kind").map((kind) => kind.toLowerCase() as MeetingRowKind)
  const person = values(terms, "person")
  if (person.length > 1)
    throw new CliError("validation_error", "person: once here", { reason: "query.unsupported-placement" })
  const transcript = terms.get("has_transcript")?.[0]
  const titleWords = (terms.get("text") ?? []).map(({ value }) => value)
  // All-day events have days, not instants: the store compares them by these local days.
  const request: MeetingListRequest = {
    ...(sources.length ? { sources } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(person[0] === undefined ? {} : { person: person[0] }),
    ...(transcript ? { hasTranscript: bool(transcript) } : {}),
    ...(titleWords.length ? { titleWords } : {}),
    ...(bounds.from === undefined ? {} : { from: bounds.from, fromDate: localDate(bounds.from, zone) }),
    ...(bounds.to === undefined ? {} : { to: bounds.to, toDate: plusDays(localDate(bounds.to - 1, zone), 1) }),
    newest: order !== "start",
    limit,
    offset: (page - 1) * limit,
  }
  return {
    request,
    meta: {
      timezone: zone,
      window: {
        ...(bounds.from === undefined ? {} : { since: new Date(bounds.from).toISOString() }),
        ...(bounds.to === undefined ? {} : { until: new Date(bounds.to - 1).toISOString() }),
      },
    },
  }
}
