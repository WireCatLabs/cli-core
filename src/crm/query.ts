import { CliError } from "@wirecat/cli-base"
import { type FieldSpec, type Predicate, parseLucene, type QueryRegistry, walkQuery } from "@wirecat/cli-base/query"
import { LIST_QUERY_GUIDE, timeBounds } from "../cli/list-query.js"
import type { CrmField } from "../domain/crm.js"
import type { CrmCondition } from "./source.js"
import { fieldNamed, optionOf, unknownField } from "./writes.js"

/** How one query field reaches the CRM: the name the condition carries, and how its values read. */
export interface CrmQueryField {
  field: string
  kind: "id" | "number" | "time" | "text"
}

/** A CRM's own words for a value: a time as its filter takes it, and which custom field types are numbers. */
export interface CrmConditionHooks {
  /** Epoch ms when absent. */
  time?: (ms: number) => string | number
  /** Whether a custom field's values go as numbers; none does when absent. */
  numeric?: (field: CrmField) => boolean
}

const valueFor = (kind: CrmQueryField["kind"], raw: string, name: string): string | number => {
  if (kind === "id") {
    if (!/^[\w.:-]{1,100}$/u.test(raw))
      throw new CliError("validation_error", `${name} takes an id; got ${raw}`, { reason: "query.bad-value" })
    return raw
  }
  if (kind !== "number") return raw
  const found = Number(raw)
  if (raw.trim() === "" || !Number.isFinite(found))
    throw new CliError("validation_error", `${name} takes a number; got ${raw}`, { reason: "query.bad-value" })
  return found
}

const range = (node: Predicate, map: CrmQueryField, name: string): CrmCondition[] => [
  ...(node.value === "*"
    ? []
    : [
        {
          field: map.field,
          op: node.lower_inclusive === false ? (">" as const) : (">=" as const),
          value: valueFor(map.kind, node.value, name),
        },
      ]),
  ...(node.upper === undefined || node.upper === "*"
    ? []
    : [
        {
          field: map.field,
          op: node.upper_inclusive === false ? ("<" as const) : ("<=" as const),
          value: valueFor(map.kind, node.upper, name),
        },
      ]),
]

/** The query's terms as conditions, AND-ed: `nativeTerms` has already refused anything the CRM cannot ask. */
export const conditionsOf = (
  terms: ReadonlyMap<string, Predicate>,
  fields: Readonly<Record<string, CrmQueryField>>,
  hooks: CrmConditionHooks = {},
): CrmCondition[] =>
  [...terms].flatMap(([name, node]): CrmCondition[] => {
    const map = fields[name]
    if (!map)
      throw new CliError("validation_error", `the CRM cannot filter by ${name}`, { reason: "query.unsupported-field" })
    if (map.kind === "time") {
      const at = hooks.time ?? ((ms: number) => ms)
      const { since, until } = timeBounds(node)
      return [
        ...(since === undefined ? [] : [{ field: map.field, op: ">=" as const, value: at(since) }]),
        ...(until === undefined ? [] : [{ field: map.field, op: "<=" as const, value: at(until) }]),
      ]
    }
    if (node.operator === "range") return range(node, map, name)
    return [{ field: map.field, op: "=", value: valueFor(map.kind, node.value, name) }]
  })

/** The field names a query uses that the list's own fields do not have: the CRM's custom fields, if any. */
export const customNames = (
  text: string,
  registry: QueryRegistry,
  command: string,
  defaultField = "none",
): string[] => {
  if (text.trim() === "") return []
  const known = new Set(registry.fields.map((field) => field.name))
  const named = walkQuery(parseLucene(text, { defaultField, command, guide: LIST_QUERY_GUIDE }).root)
    .filter((term) => !term.implicit)
    .map((term) => term.field)
  return [...new Set(named.filter((name) => !known.has(name)))]
}

/** The custom fields a query names, each as typed, refused unless the CRM can filter a list by it. */
export const filterableFields = (fields: readonly CrmField[], names: readonly string[]): [string, CrmField][] =>
  names.map((name) => {
    const field = fieldNamed(fields, name, "--query")
    if (!field.filterable)
      throw new CliError("validation_error", `the CRM cannot filter a list by ${field.label ?? field.code}`, {
        reason: "field.not-filterable",
        field: field.code,
      })
    return [name, field]
  })

/** The list's query fields and the custom ones, each a whole value, so cli-base validates the query as it is. */
export const withCustomFields = (registry: QueryRegistry, chosen: readonly [string, CrmField][]): QueryRegistry => ({
  ...registry,
  fields: [
    ...registry.fields,
    ...chosen.map(
      ([name]): FieldSpec => ({ name, type: "kw", operators: ["term", "phrase"], example: `${name}:x`, native: true }),
    ),
  ],
})

const customValue = (field: CrmField, typed: string, hooks: CrmConditionHooks): string | number => {
  const value = field.options ? optionOf(field, typed, "--query") : typed
  const number = Number(value)
  return hooks.numeric?.(field) && value.trim() !== "" && Number.isFinite(number) ? number : value
}

/** The custom terms as conditions on their codes, taken out of `terms` so the rest map by `conditionsOf`. */
export const customConditions = (
  terms: Map<string, Predicate>,
  chosen: readonly [string, CrmField][],
  hooks: CrmConditionHooks = {},
): CrmCondition[] =>
  chosen.flatMap(([name, field]) => {
    const term = terms.get(name)
    terms.delete(name)
    return term ? [{ field: field.code, op: "=" as const, value: customValue(field, term.value, hooks) }] : []
  })

/**
 * The custom fields `--json` names, as `provider_metadata.<code>`, or every one for a bare `provider_metadata`;
 * undefined when it names none.
 */
export const wantedCodes = (paths: string | undefined): string[] | "all" | undefined => {
  if (!paths) return undefined
  const parts = paths.split(",").map((path) =>
    path
      .trim()
      .replace(/^items\./, "")
      .split("."),
  )
  const metadata = parts.filter(([top]) => top === "provider_metadata")
  if (metadata.some((part) => part.length === 1)) return "all"
  const codes = metadata.flatMap(([, code]) => (code ? [code] : []))
  return codes.length ? [...new Set(codes)] : undefined
}

/** The codes `wanted` names, each one the CRM lists: a CRM may refuse a whole call over one unknown name. */
export const selectedCodes = (fields: readonly CrmField[], wanted: string[] | "all" | undefined): string[] => {
  if (wanted === undefined) return []
  if (wanted === "all") return fields.map((field) => field.code)
  return wanted.map((code) => {
    if (!fields.some((field) => field.code === code)) throw unknownField(fields, code, "--json")
    return code
  })
}
