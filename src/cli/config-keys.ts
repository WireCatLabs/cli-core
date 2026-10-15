import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"

/** Reads and checks a config file; a missing one is the fallback, a broken one an error naming every problem. */
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
  if (!result.success) {
    const problems = result.issues.map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
    throw new CliError("configuration_error", `${path} is not a valid config:\n  ${problems.join("\n  ")}`)
  }
  return result.output
}
