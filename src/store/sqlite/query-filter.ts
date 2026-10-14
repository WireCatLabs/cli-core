import {
  dateRange,
  type FieldType,
  type Predicate,
  type QueryAst,
  type QueryContext,
  type QueryNode,
  queryError,
} from "@wirecat/cli-base/query"
import type { SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import { type SQL, sql } from "./drizzle/core.js"

export interface Where {
  sql: string
  params: SqlValue[]
  /** Never NULL, so it needs no `IFNULL` — which would keep SQLite from using an index. */
  known?: true
}

/**
 * How a list's store answers one field. A column names its SQL expression; times are epoch milliseconds,
 * booleans 0 or 1. A field that is not one column — words, a relation, an array — builds its own condition.
 * `folded`: the expression holds `fold()` of the text, so the value is folded the same way and compared as is —
 * `lower()` folds ASCII only. GLOB, not LIKE, so a prefix pattern can use the column's index.
 */
export type ColumnMap = Readonly<
  Record<
    string,
    { type: Exclude<FieldType, "txt">; sql: string; folded?: true } | { where: (node: Predicate) => Where }
  >
>

export interface FilterOptions extends QueryContext {
  zone?: string
  now?: number
}

/** A wildcard term as a GLOB pattern: `\x` is a literal x, and a literal `*`, `?` or `[` is bracketed. */
const glob = (value: string) =>
  [...fold(value).matchAll(/\\(.)|([*?])|(.)/gsu)]
    .map(([, escaped, wildcard, plain]) => {
      const literal = escaped ?? plain ?? ""
      return wildcard ?? (/[*?[]/u.test(literal) ? `[${literal}]` : literal)
    })
    .join("")

const like = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\\%_]/gu, "\\$&")
    .replaceAll("*", "%")
    .replaceAll("?", "_")

const leaf = (node: Predicate, columns: ColumnMap, options: FilterOptions): Where => {
  const column = columns[node.field]
  if (!column) throw new Error(`query filter: no column for "${node.field}"; validate the query first`)
  if ("where" in column) return column.where(node)
  const { sql, type } = column
  if (node.operator === "wildcard" && node.value === "*")
    return { sql: `${sql} IS NOT NULL AND ${sql} <> ''`, params: [] }
  if (node.operator === "regex")
    queryError("query.unsupported-operator", node.span, `${node.field} takes no regular expression`, options)
  switch (type) {
    case "num": {
      if (node.operator !== "range") return { sql: `${sql} = ?`, params: [Number(node.value)] }
      const bounds: Where[] = []
      if (node.value !== "*")
        bounds.push({ sql: `${sql} ${node.lower_inclusive ? ">=" : ">"} ?`, params: [Number(node.value)] })
      if (node.upper !== undefined && node.upper !== "*")
        bounds.push({ sql: `${sql} ${node.upper_inclusive ? "<=" : "<"} ?`, params: [Number(node.upper)] })
      return all([{ sql: `${sql} IS NOT NULL`, params: [] }, ...bounds])
    }
    case "time": {
      const range =
        node.operator === "range"
          ? [node.value, node.upper ?? "*", node.lower_inclusive ?? true, node.upper_inclusive ?? true]
          : [node.value, node.value, true, true]
      const { lower, upper, lower_inclusive, upper_inclusive } = dateRange(
        range[0] as string,
        range[1] as string,
        range[2] as boolean,
        range[3] as boolean,
        options.zone ?? "UTC",
        node.span,
        options.now,
      )
      return all([
        { sql: `${sql} IS NOT NULL`, params: [] },
        ...(lower === undefined ? [] : [{ sql: `${sql} ${lower_inclusive ? ">=" : ">"} ?`, params: [lower] }]),
        ...(upper === undefined ? [] : [{ sql: `${sql} ${upper_inclusive ? "<=" : "<"} ?`, params: [upper] }]),
      ])
    }
    case "bool":
      return { sql: `${sql} = ?`, params: [node.value.toLowerCase() === "true" ? 1 : 0] }
    default:
      if (column.folded)
        return node.operator === "wildcard"
          ? { sql: `${sql} IS NOT NULL AND ${sql} GLOB ?`, params: [glob(node.value)], known: true }
          : { sql: `${sql} IS NOT NULL AND ${sql} = ?`, params: [fold(node.value)], known: true }
      return node.operator === "wildcard"
        ? { sql: `lower(${sql}) LIKE ? ESCAPE '\\'`, params: [like(node.value)] }
        : { sql: `lower(${sql}) = ?`, params: [node.value.toLowerCase()] }
  }
}

const all = (parts: Where[]): Where => ({
  sql: parts.map(({ sql }) => `(${sql})`).join(" AND "),
  params: parts.flatMap(({ params }) => params),
})

// NULL is false here, as in cli-base's `evaluate`: without it, NOT over a missing value would drop the row.
const known = (where: Where): Where =>
  where.known ? where : { sql: `IFNULL((${where.sql}), 0)`, params: where.params }

const compile = (node: QueryNode, columns: ColumnMap, options: FilterOptions): Where => {
  if (node.kind === "predicate") return known(leaf(node, columns, options))
  const of = (occur: string) =>
    node.clauses.filter((clause) => clause.occur === occur).map((clause) => compile(clause.node, columns, options))
  const [must, should, mustNot] = [of("must"), of("should"), of("must_not")]
  const parts = [
    ...must,
    ...(must.length === 0 && should.length > 0
      ? [{ sql: should.map(({ sql }) => `(${sql})`).join(" OR "), params: should.flatMap(({ params }) => params) }]
      : []),
    ...mustNot.map(({ sql, params }) => ({ sql: `NOT (${sql})`, params })),
  ]
  return all(parts)
}

/**
 * A validated list query as a `WHERE` condition with bound parameters, matching cli-base's `evaluate`: kw, enum
 * and ref compare without case (a `folded` column for names in any script), a lone NOT means everything else, and a
 * `should` clause counts only when nothing is required.
 */
export const queryFilter = (ast: QueryAst, columns: ColumnMap, options: FilterOptions = {}): Where =>
  compile(ast.root, columns, options)

/** The SQL a list query compiled to, with its values bound, for a Drizzle `where`. */
export const bound = ({ sql: text, params }: Where): SQL =>
  sql.join(
    text.split("?").map((part, at) => (at < params.length ? sql`${sql.raw(part)}${params[at]}` : sql.raw(part))),
    sql``,
  )
