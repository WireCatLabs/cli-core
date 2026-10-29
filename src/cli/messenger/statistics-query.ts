import { annotate } from "@wirecat/cli-base/commands"
import {
  defineQuery,
  type FieldSpec,
  fieldsHelp,
  parseLucene,
  type QueryNode,
  type QueryRegistry,
  queryError,
  validateQuery,
  walkQuery,
} from "@wirecat/cli-base/query"
import type { Command } from "commander"
import { QUERY_FIELDS } from "../../search/lucene/registry.js"
import { MESSAGE_PARSING } from "../../search/lucene/types.js"
import { LIST_QUERY_GUIDE, type QueryWords, typedQuery } from "../list-query.js"

export type StatisticsQuery = "contacts-top" | "messages-top" | "discussion" | "unanswered" | "responses"
const FIELDS: Record<StatisticsQuery, readonly string[]> = {
  "contacts-top": ["message_kind", "min_messages"],
  "messages-top": ["message_kind"],
  discussion: ["min_views", "max_replies"],
  unanswered: ["older_than"],
  responses: [],
}
const PATHS: Record<StatisticsQuery, string> = {
  "contacts-top": "stats contacts top",
  "messages-top": "stats messages top",
  discussion: "stats messages discussion",
  unanswered: "stats messages unanswered",
  responses: "stats contacts responses",
}
const FIELD_SPECS: readonly FieldSpec[] = [
  {
    name: "message_kind",
    type: "enum",
    values: ["all", "posts", "comments"],
    operators: ["term", "phrase"],
    example: "message_kind:posts",
    placement: "and",
    relation: "proven posts or comments selected before ranking",
  },
  {
    name: "min_messages",
    type: "num",
    operators: ["term"],
    example: "min_messages:5",
    placement: "and",
    relation: "minimum selected messages per ranked author",
  },
  {
    name: "min_views",
    type: "num",
    operators: ["term"],
    example: "min_views:10",
    placement: "and",
    relation: "minimum known cumulative views of a discussion post",
  },
  {
    name: "max_replies",
    type: "num",
    operators: ["term"],
    example: "max_replies:0",
    placement: "and",
    relation: "maximum observed discussion replies",
  },
  {
    name: "older_than",
    type: "kw",
    operators: ["term", "phrase"],
    example: "older_than:24h",
    placement: "and",
    relation: "minimum age of an unanswered question; positive duration",
  },
]
const fieldsFor = (report: StatisticsQuery) => FIELD_SPECS.filter(({ name }) => FIELDS[report].includes(name))

const registries = new Map<StatisticsQuery, QueryRegistry>()
const registryOf = (report: StatisticsQuery): QueryRegistry => {
  const known = registries.get(report)
  if (known) return known
  const registry = defineQuery({
    entity: report.endsWith("top") ? "ranking" : "admin_report",
    backend: "sql",
    fields: [
      ...QUERY_FIELDS.map((field) => ({
        ...field,
        example: field.name === "text" ? "text:invoice" : field.name === "topic" ? "topic:42" : field.example,
      })),
      ...fieldsFor(report),
    ],
  })
  registries.set(report, registry)
  return registry
}

export const withStatisticsQuery = (command: Command, report: StatisticsQuery): Command => {
  const extra = fieldsFor(report)
  const query = registryOf(report)
  annotate(command, { query })
  command.addHelpText(
    "after",
    `\n${fieldsHelp({ fields: extra }, LIST_QUERY_GUIDE)}\nReport predicates are positive AND terms; the remaining query selects stored messages.\n`,
  )
  return command
}

/** Report predicates become the existing source/aggregate parameters; the message query keeps its syntax. */
export interface StatisticsFilters {
  text?: string
  messageKind?: string
  minMessages?: number
  minViews?: number
  maxReplies?: number
  olderThan?: string
}
export const statisticsQuery = (words: QueryWords, report: StatisticsQuery): StatisticsFilters => {
  const source = typedQuery(words)
  if (!source.trim()) return {}
  const ast = parseLucene(source, MESSAGE_PARSING)
  const reserved = new Set(FIELD_SPECS.map(({ name }) => name))
  const hasReport = (node: QueryNode) => walkQuery(node).some(({ field }) => reserved.has(field))
  if (!hasReport(ast.root)) return { text: source }
  const context = { command: PATHS[report], guide: LIST_QUERY_GUIDE }
  const values = new Map<string, string>()
  const original = (node: QueryNode): string => {
    const piece = source.slice(node.span.start, node.span.end)
    if (node.kind === "boolean") {
      const prefix = /(?:^|[\s(])([a-z_][a-z0-9_-]*)\s*:\s*$/i.exec(source.slice(0, node.span.start))
      return prefix ? `${prefix[1]}:${piece}` : piece
    }
    const named = /^([a-z_][a-z0-9_-]*)\s*[:<>]/i.exec(piece)?.[1]
    return node.implicit || named?.toLowerCase() === node.field.toLowerCase() ? piece : `${node.field}:${piece}`
  }
  const prune = (node: QueryNode): string | undefined => {
    if (!hasReport(node)) return original(node)
    if (node.kind === "boolean") {
      if (
        node.clauses.some(({ occur, node: child }) => occur === "should" || (occur === "must_not" && hasReport(child)))
      )
        queryError("query.unsupported-placement", node.span, "report predicates must be positive AND terms", context)
      const kept = node.clauses
        .map(({ occur, node: child }) => {
          const part = prune(child)
          return part === undefined ? undefined : occur === "must_not" ? `NOT (${part})` : part
        })
        .filter((part) => part !== undefined)
      return kept.length ? kept.map((part) => `(${part})`).join(" AND ") : undefined
    }
    if (!FIELDS[report].includes(node.field))
      queryError("query.unsupported-field", node.span, `${node.field} is not a filter for ${PATHS[report]}`, context)
    validateQuery({ ...ast, root: node }, { entity: "statistics", backend: "sql", fields: fieldsFor(report) }, context)
    if (values.has(node.field))
      queryError("query.unsupported-placement", node.span, `${node.field} only once here`, context)
    if (["min_messages", "min_views", "max_replies"].includes(node.field)) {
      const value = Number(node.value)
      if (!Number.isSafeInteger(value) || value < (node.field === "min_messages" ? 1 : 0))
        queryError(
          "query.invalid-number",
          node.span,
          `${node.field} takes a ${node.field === "min_messages" ? "positive" : "nonnegative"} integer`,
          context,
        )
    }
    if (node.field === "older_than") {
      const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
      const duration = Number(node.value.slice(0, -1)) * (units[node.value.at(-1) ?? ""] ?? 0)
      if (!/^\d+(?:\.\d+)?[smhdw]$/.test(node.value) || !Number.isSafeInteger(duration) || duration <= 0)
        queryError(
          "query.invalid-duration",
          node.span,
          "older_than takes a positive duration such as 4h or 7d",
          context,
        )
    }
    values.set(node.field, node.value)
    return undefined
  }
  const text = prune(ast.root)
  return {
    ...(text ? { text } : {}),
    ...(values.has("message_kind") ? { messageKind: values.get("message_kind")?.toLowerCase() } : {}),
    ...(values.has("min_messages") ? { minMessages: Number(values.get("min_messages")) } : {}),
    ...(values.has("min_views") ? { minViews: Number(values.get("min_views")) } : {}),
    ...(values.has("max_replies") ? { maxReplies: Number(values.get("max_replies")) } : {}),
    ...(values.has("older_than") ? { olderThan: values.get("older_than") } : {}),
  }
}
