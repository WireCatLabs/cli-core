import { annotate } from "@wirecat/cli-base/commands"
import {
  defineQuery,
  fieldsHelp,
  fieldsNamed,
  parseLucene,
  QUERY_LIMITS,
  type QueryAst,
  type QueryRegistry,
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
  annotate(command, { query: defineQuery(registry), output: { entity: registry.entity } })
  // `-kind:channel` is a negated term, not an option; a mistyped option still fails, as a query word.
  return command
    .allowUnknownOption()
    .argument("[query...]", "field:value terms that narrow the list — the fields are below")
    .addHelpText("after", `\n${fieldsHelp(registry, LIST_QUERY_GUIDE)}`)
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

/** The query words a list's action receives, for `listQuery`. */
export const typedQuery = (words: readonly string[] | undefined): string => (words ?? []).join(" ")

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

/** An MCP list's `query` argument: the language the CLI list takes after its arguments. */
export const queryArgument = (registry: QueryRegistry) =>
  v.optional(
    v.pipe(
      v.string(),
      v.maxLength(QUERY_LIMITS.bytes),
      v.description(
        `field:value terms that narrow the list (Lucene: AND OR NOT, [a TO b], > <); fields: ${registry.fields
          .map((field) => field.name)
          .join(", ")}; e.g. ${registry.fields[0]?.example ?? ""}`,
      ),
    ),
  )
