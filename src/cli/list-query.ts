import { annotate } from "@wirecat/cli-base/commands"
import {
  dateRange,
  defineQuery,
  type FieldSpec,
  type FieldType,
  fieldsHelp,
  fieldsNamed,
  OPERATORS_BY_TYPE,
  type Predicate,
  parseLucene,
  QUERY_LIMITS,
  type QueryAst,
  type QueryNode,
  type QueryRegistry,
  queryError,
  queryFieldsOf,
  timezoneOf,
  validateQuery,
} from "@wirecat/cli-base/query"
import type { Command } from "commander"
import * as v from "valibot"
import { queryWordsAfterOptions } from "../meetings/cli/index.js"
import { type ListBody, type ListInput, listOf } from "./envelope.js"
import type { Settings } from "./settings.js"

export const LIST_QUERY_GUIDE = "https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md"

/**
 * A list that narrows by one query: `[query...]` last, a Fields section in its help, and the fields in
 * `commands --json`. The registry is checked here, so a field whose example does not run fails at startup.
 */
export const withQuery = (command: Command, registry: QueryRegistry): Command => {
  const query = defineQuery(registry)
  annotate(command, { query, output: { entity: registry.entity } })
  const shown = askable(query)
  queryWordsAfterOptions(command).argument(
    "[query...]",
    shown.length > 0
      ? "field:value terms that narrow the list — the fields are below"
      : "field:value terms; this list filters by none yet",
  )
  if (shown.length > 0) command.addHelpText("after", `\n${fieldsHelp({ ...query, fields: shown }, LIST_QUERY_GUIDE)}`)
  return command
}

/**
 * A list its source answers whole and cannot narrow: the entity's fields are named, none is filterable, so any
 * term is `query.unsupported-field` rather than a filter applied to what came back.
 */
export const unfilteredQuery = (entity: string, schema: Parameters<typeof queryFieldsOf>[0]): QueryRegistry => ({
  entity,
  backend: "native",
  fields: queryFieldsOf(schema, {}),
})

/** `tasks list`, as a query error names the command. */
export const commandPath = (command: Command): string => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words.join(" ")
}

/**
 * The query as typed, validated against the list's fields, with each default whose field it does not name;
 * `undefined` when nothing narrows the list. CLI and MCP read a list's query through this one function.
 */
export const listQuery = (text: string, registry: QueryRegistry, command: string): QueryAst | undefined => {
  const context = { command, guide: LIST_QUERY_GUIDE }
  const typed = text.trim() === "" ? undefined : parseLucene(text, { defaultField: "none", ...context })
  if (typed) validateQuery(typed, registry, context)
  const named = typed ? fieldsNamed(typed) : new Set<string>()
  const defaults = (registry.defaults ?? [])
    .filter((term) => !named.has(term.replace(/^-/, "").split(/[:<>=]/)[0] ?? ""))
    .map((term) => parseLucene(term, { defaultField: "none", ...context }).root)
  const roots = [...(typed ? [typed.root] : []), ...defaults]
  if (roots.length === 0) return undefined
  if (roots.length === 1 && typed) return typed
  return {
    version: 1,
    language: "lucene-v1",
    root: {
      kind: "boolean",
      clauses: roots.map((node) => ({ occur: "must" as const, node })),
      span: { start: 0, end: text.length },
    },
  }
}

/** A list's `[query...]` as typed: the words after its arguments, or one string from MCP. */
export type QueryWords = readonly string[] | string | undefined

/** The query a list's action or MCP tool received, as one string for `listQuery`. */
export const typedQuery = (words: QueryWords): string => (typeof words === "string" ? words : (words ?? []).join(" "))

const EVERY = Number.MAX_SAFE_INTEGER - 1

/** The rows a page-numbered list asks its store for; `--all` asks for every one. */
export const pageOf = ({ limit, page, all }: Pick<Settings, "limit" | "page" | "all">) =>
  all ? { limit: EVERY, offset: 0 } : { limit, offset: (page - 1) * limit }

/** A page-numbered list's answer; under `--all` its limit is what it holds. */
export const pagedList = <T>(
  command: string,
  { limit, page, all }: Pick<Settings, "limit" | "page" | "all">,
  { items, has_more, ...rest }: Omit<ListInput<T>, "limit" | "page" | "cursor">,
): ListBody<T> =>
  listOf(command, {
    ...rest,
    items,
    limit: all ? Math.max(1, items.length) : limit,
    has_more: all ? false : has_more,
    page,
  })

/** The fields a list can be narrowed by: a provider list only those its source answers. */
const askable = (registry: QueryRegistry) =>
  registry.backend === "native" ? registry.fields.filter((field) => field.native) : registry.fields

/** An MCP list's `query` argument: the language the CLI list takes after its arguments. */
export const queryArgument = (registry: QueryRegistry) => {
  const fields = askable(registry)
  return v.optional(
    v.pipe(
      v.string(),
      v.maxLength(QUERY_LIMITS.bytes),
      v.description(
        fields.length === 0
          ? "field:value terms; this list filters by none yet, so any term is refused"
          : `${
              registry.backend === "native"
                ? "field:value terms joined by AND that narrow the list"
                : "field:value terms that narrow the list (Lucene: AND OR NOT, [a TO b], > <)"
            }; fields: ${fields.map((field) => field.name).join(", ")}; e.g. ${fields[0]?.example ?? ""}`,
      ),
    ),
  )
}

/**
 * The terms of a query a provider answers: field:value joined by AND, each field once. Anything else is a
 * question the source cannot ask, so it is refused rather than answered from a part of the list.
 */
export const nativeTerms = (ast: QueryAst | undefined, command: string): Map<string, Predicate> => {
  const terms = new Map<string, Predicate>()
  if (!ast) return terms
  const context = { command, guide: LIST_QUERY_GUIDE }
  // listQuery wraps a typed `a:x b:y` as one clause beside the defaults, so an all-AND group nests.
  const add = (node: QueryNode) => {
    if (node.kind === "boolean") {
      for (const clause of node.clauses) {
        if (clause.occur !== "must")
          queryError(
            "query.unsupported-placement",
            clause.node.span,
            "this list takes only field:value terms joined by AND",
            context,
          )
        add(clause.node)
      }
      return
    }
    if (terms.has(node.field))
      queryError("query.unsupported-placement", node.span, `${node.field} only once here`, context)
    terms.set(node.field, node)
  }
  add(ast.root)
  return terms
}

/**
 * A store that compares whole values: each field's `field:value` or `field:"two words"`, enum values lowercased
 * as validation already accepts them. A range or wildcard is refused rather than read as a value.
 */
export const queryTerms = (words: QueryWords, registry: QueryRegistry, command: string): Map<string, string> => {
  const terms = new Map<string, string>()
  for (const [field, node] of nativeTerms(listQuery(typedQuery(words), registry, command), command)) {
    if (node.operator !== "term" && node.operator !== "phrase")
      queryError("query.unsupported-placement", node.span, `${field} takes one whole value here`, {
        command,
        guide: LIST_QUERY_GUIDE,
      })
    const enumerated = registry.fields.find(({ name }) => name === field)?.type === "enum"
    terms.set(field, enumerated ? node.value.toLowerCase() : node.value)
  }
  return terms
}

/**
 * A `time` term as epoch ms bounds: `time>=7d`, `time:[2026-10-01 TO 2026-10-07]`, `time:today`, and the `meta`
 * an answer reports them by: the zone calendar words and bare dates were read in, and the bounds in UTC.
 * `until` is inclusive: an exclusive end (a bare date's next midnight, `… TO …}`) comes back 1 ms inside. `since` stays
 * as written, because the inbox reads strictly after a `date>` start.
 */
export const timeBounds = (
  term: Predicate | undefined,
  zone = timezoneOf(),
): { since?: number; until?: number; meta?: { timezone: string; window: { since?: string; until?: string } } } => {
  if (!term) return {}
  const upper = term.operator === "range" ? (term.upper ?? "*") : term.value
  const range = dateRange(
    term.value,
    upper,
    term.operator === "range" ? term.lower_inclusive !== false : true,
    term.operator === "range" ? term.upper_inclusive !== false : true,
    zone,
    term.span,
  )
  const until = range.upper === undefined ? undefined : range.upper - (range.upper_inclusive ? 0 : 1)
  return {
    ...(range.lower === undefined ? {} : { since: range.lower }),
    ...(until === undefined ? {} : { until }),
    meta: {
      timezone: zone,
      window: {
        ...(range.lower === undefined ? {} : { since: new Date(range.lower).toISOString() }),
        ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
      },
    },
  }
}

/** A text term as the plain words a provider searches by: `name:ana`, `name:"Ana K"`, `name:*ana*`. */
export const searchText = (term: Predicate | undefined): string | undefined =>
  term === undefined ? undefined : term.value.replace(/^\*+|\*+$/g, "")

/** A field the provider filters itself; names follow the search language, as in `search messages`. */
export const nativeField = (field: Omit<FieldSpec, "native">): FieldSpec => ({ ...field, native: true })

/** A field the store filters by whole values only, as `queryTerms` reads them. */
export const termField = (
  name: string,
  type: FieldType,
  example: string,
  more: Pick<FieldSpec, "values" | "relation"> = {},
): FieldSpec =>
  nativeField({
    name,
    type,
    operators: OPERATORS_BY_TYPE[type].filter((operator) => operator === "term" || operator === "phrase"),
    example,
    ...more,
  })

/** The Fields section of a list's help, for a list that places its own `[query...]`. */
export const queryHelp = (registry: QueryRegistry): string => `\n${fieldsHelp(registry, LIST_QUERY_GUIDE)}`
