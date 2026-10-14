import { annotate } from "@wirecat/cli-base/commands"
import {
  dateRange,
  defineQuery,
  type FieldSpec,
  fieldsHelp,
  fieldsNamed,
  type Predicate,
  parseLucene,
  QUERY_LIMITS,
  type QueryAst,
  type QueryRegistry,
  queryError,
  validateQuery,
} from "@wirecat/cli-base/query"
import type { Command } from "commander"
import * as v from "valibot"
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
  // `-kind:channel` is a negated term, not an option; a mistyped option still fails, as a query word.
  command
    .allowUnknownOption()
    .argument(
      "[query...]",
      shown.length > 0
        ? "field:value terms that narrow the list — the fields are below"
        : "field:value terms; this list filters by none yet",
    )
  if (shown.length > 0) command.addHelpText("after", `\n${fieldsHelp({ ...query, fields: shown }, LIST_QUERY_GUIDE)}`)
  return command
}

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
          : `field:value terms that narrow the list (Lucene: AND OR NOT, [a TO b], > <); fields: ${fields
              .map((field) => field.name)
              .join(", ")}; e.g. ${fields[0]?.example ?? ""}`,
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
  const add = (node: Predicate) => {
    if (terms.has(node.field))
      queryError("query.unsupported-placement", node.span, `${node.field} only once here`, context)
    terms.set(node.field, node)
  }
  const { root } = ast
  if (root.kind === "predicate") add(root)
  else
    for (const clause of root.clauses) {
      if (clause.occur !== "must" || clause.node.kind !== "predicate")
        queryError(
          "query.unsupported-placement",
          clause.node.span,
          "this list takes only field:value terms joined by AND",
          context,
        )
      add(clause.node)
    }
  return terms
}

/** A `time` term as epoch ms bounds: `time>=7d`, `time:[2026-10-01 TO 2026-10-07]`, `time:today`. */
export const timeBounds = (term: Predicate | undefined, zone = "UTC"): { since?: number; until?: number } => {
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
  return {
    ...(range.lower === undefined ? {} : { since: range.lower }),
    ...(range.upper === undefined ? {} : { until: range.upper }),
  }
}

/** A text term as the plain words a provider searches by: `name:ana`, `name:"Ana K"`, `name:*ana*`. */
export const searchText = (term: Predicate | undefined): string | undefined =>
  term === undefined ? undefined : term.value.replace(/^\*+|\*+$/g, "")

/** A field the provider filters itself; names follow the search language, as in `search messages`. */
export const nativeField = (field: Omit<FieldSpec, "native">): FieldSpec => ({ ...field, native: true })

/** The Fields section of a list's help, for a list that places its own `[query...]`. */
export const queryHelp = (registry: QueryRegistry): string => `\n${fieldsHelp(registry, LIST_QUERY_GUIDE)}`
