import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"

const reasonOf = (issue: v.BaseIssue<unknown>): string => {
  if (issue.expected === "never") return "is an unknown setting"
  const last = issue.path?.at(-1)
  if (last && "origin" in last && last.origin === "key" && issue.input === undefined) return "is missing"
  if (issue.kind === "validation" || ["picklist", "enum", "literal"].includes(issue.type)) return "has an invalid value"
  return "has the wrong type"
}

/**
 * The first problem only, by key and a fixed reason: valibot's own messages quote the value they got, and a
 * config value can be a secret pasted into the wrong place.
 */
const problemOf = (issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]): string => {
  const [issue] = issues
  const more = issues.length - 1
  const count = more === 0 ? "" : ` (and ${more} more problem${more === 1 ? "" : "s"})`
  return `${v.getDotPath(issue) ?? "the whole file"} ${reasonOf(issue)}${count}`
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
  if (!result.success) throw new CliError("configuration_error", `${path}: ${problemOf(result.issues)}`)
  return result.output
}
