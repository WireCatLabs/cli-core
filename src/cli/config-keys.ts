import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null

const unwrap = (schema: unknown): Node | undefined => {
  let current = schema
  while (isNode(current) && "wrapped" in current) current = current.wrapped
  return isNode(current) ? current : undefined
}

const child = (schema: unknown, key: string): unknown => {
  const node = unwrap(schema)
  if (isNode(node?.entries)) return node.entries[key]
  return node?.type === "record" ? node.value : undefined
}

const snakeCase = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

const reasonOf = (issue: v.BaseIssue<unknown>): string => {
  if (issue.expected === "never") return "is an unknown setting"
  const last = issue.path?.at(-1)
  if (last && "origin" in last && last.origin === "key" && issue.input === undefined) return "is missing"
  if (issue.kind === "validation" || ["picklist", "enum", "literal"].includes(issue.type)) return "has an invalid value"
  return "has the wrong type"
}

const renameHint = (issue: v.BaseIssue<unknown>, schema: v.GenericSchema): string => {
  if (issue.expected !== "never" || !issue.path) return ""
  const keys = issue.path.map((item) => String(item.key))
  const key = keys.pop() ?? ""
  const known = unwrap(keys.reduce<unknown>(child, schema))?.entries
  const snake = snakeCase(key)
  return snake !== key && isNode(known) && snake in known ? `; rename it to ${snake}` : ""
}

/**
 * The first problem only, by key and a fixed reason: valibot's own messages quote the value they got, and a
 * config value can be a secret pasted into the wrong place.
 */
const problemOf = (issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]], schema: v.GenericSchema): string => {
  // A file from an older version is missing every new key; the rename is what tells the reader how to fix it.
  const issue = issues.find((candidate) => renameHint(candidate, schema)) ?? issues[0]
  const more = issues.length - 1
  const count = more === 0 ? "" : ` (and ${more} more problem${more === 1 ? "" : "s"})`
  return `${v.getDotPath(issue) ?? "the whole file"} ${reasonOf(issue)}${renameHint(issue, schema)}${count}`
}

/** Reads and checks a config file; a missing one is the fallback, a broken one an error naming its first problem. */
export const loadSnakeCaseConfig = <T extends v.GenericSchema>(
  path: string,
  schema: T,
  fallback: () => v.InferOutput<T>,
): v.InferOutput<T> => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return fallback()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError("configuration_error", `${path} is not valid JSON`)
  }
  const result = v.safeParse(schema, parsed)
  if (!result.success) throw new CliError("configuration_error", `${path}: ${problemOf(result.issues, schema)}`)
  return result.output
}
