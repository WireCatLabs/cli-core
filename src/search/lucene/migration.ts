import { parseLucene, type QueryAst } from "@wirecat/cli-base/query"
import type { Provider } from "../../domain/models.js"
import { parseQuery, type Term } from "../query.js"
import { SEARCH_QUERY } from "./types.js"

export interface SavedQuery {
  version: 1
  language: "lucene-v1" | "legacy-v1"
  text: string
  timezone?: string
  fieldsVersion: number
}
export interface QueryMigration {
  from: "legacy-v1"
  to: "lucene-v1"
  query: string
  ast: QueryAst
  warnings: string[]
}
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
const term = (value: Term) => quoted(value.kind === "phrase" ? value.words.join(" ") : value.text)
export const migrateLegacyQuery = (
  text: string,
  options: { now?: number; providers?: readonly Provider[] } = {},
): QueryMigration => {
  const legacy = parseQuery(text, options)
  const parts = legacy.required.map((group) =>
    group.length === 1 ? term(group[0] as Term) : `(${group.map(term).join(" OR ")})`,
  )
  parts.push(...legacy.excluded.map((one) => `NOT ${term(one)}`))
  if (legacy.from !== undefined) parts.push(`from:${quoted(legacy.from)}`)
  if (legacy.chat !== undefined) parts.push(`chat:${quoted(legacy.chat)}`)
  if (legacy.in !== undefined) parts.push(`in:${quoted(legacy.in)}`)
  parts.push(...legacy.has.map((kind) => `has:${quoted(kind)}`))
  if (legacy.after !== undefined) parts.push(`date:[${quoted(new Date(legacy.after).toISOString())} TO *]`)
  if (legacy.before !== undefined) parts.push(`date:[* TO ${quoted(new Date(legacy.before).toISOString())}}`)
  if (parts.length === 0) parts.push("date:[* TO *]")
  const query = parts.join(" AND ")
  const warnings = [
    "Strict Lucene matching does not preserve legacy prefix, typo, any-word or substring discovery; keep explicit legacy mode when those results matter.",
  ]
  if ((text.match(/"/gu)?.length ?? 0) % 2 !== 0)
    warnings.push("Legacy accepted an unclosed quote; the interpreted phrase has been closed explicitly.")
  return { from: "legacy-v1", to: "lucene-v1", query, ast: parseLucene(query, SEARCH_QUERY), warnings }
}
