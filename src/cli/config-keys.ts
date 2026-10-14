import { readFileSync, statSync } from "node:fs"
import { CliError, writeSecurely } from "@wirecat/cli-base"
import * as v from "valibot"

export const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

type Schema = v.GenericSchema & { type: string; entries?: v.ObjectEntries; wrapped?: Schema; value?: Schema }

const unwrapped = (schema: Schema): Schema =>
  schema.wrapped && ["optional", "nullable", "nullish", "exact_optional"].includes(schema.type)
    ? unwrapped(schema.wrapped)
    : schema

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())

/**
 * A setting from one section of the file, under its snake_case name or the camelCase one an app's own schema still
 * declares (max-cli's, until it renames): the file is only renamed where the schema says so, and a value read under
 * the wrong name would silently fall back to the default — `read_only` among them.
 */
export const settingAt = (scope: Readonly<Record<string, unknown>> | undefined, key: string): unknown =>
  scope?.[key] ?? scope?.[camel(key)]

/**
 * A setting name as typed into `config set`, in the schema's snake_case: `readOtherBots` is `read_other_bots`. A command
 * path under `permissions` and a model purpose are data and keep their spelling.
 */
export const declaredSettingName = (setting: string): string => {
  const [head = setting, ...rest] = setting.split(".")
  if (head === "permissions") return setting
  if (head === "models" && rest.length === 2) return `models.${rest[0]}.${snake(rest[1] as string)}`
  return [snake(head), ...rest].join(".")
}

export interface ConfigRename {
  /** `defaults.timeoutMs`, as found in the file. */
  from: string
  to: string
}

/**
 * Renames a setting to the spelling the schema declares: snake_case from the camelCase name an older version wrote,
 * or back to camelCase for an app whose own schema still says so (max-cli's, until it renames). Only names the
 * schema declares move: a profile name, a command path under `permissions` or a model purpose is data and keeps its
 * spelling.
 */
const renamed = (schema: Schema, value: unknown, path: string, renames: ConfigRename[]): unknown => {
  const at = unwrapped(schema)
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  if (at.type === "record" && at.value) {
    const inner = at.value
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [key, renamed(inner, one, `${path}${key}.`, renames)]),
    )
  }
  const entries = at.entries
  if (!entries || !["object", "strict_object", "loose_object"].includes(at.type)) return value
  const result: Record<string, unknown> = {}
  for (const [key, one] of Object.entries(value)) {
    const target = key in entries ? key : snake(key) in entries ? snake(key) : camel(key) in entries ? camel(key) : key
    if (target !== key) {
      if (
        Object.hasOwn(value, target) &&
        JSON.stringify((value as Record<string, unknown>)[target]) !== JSON.stringify(one)
      )
        throw new CliError(
          "configuration_error",
          `${path}${key} and ${path}${target} are the same setting with different values — keep one`,
        )
      renames.push({ from: `${path}${key}`, to: `${path}${target}` })
    }
    const inner = entries[target] as Schema | undefined
    result[target] = inner ? renamed(inner, one, `${path}${target}.`, renames) : one
  }
  return result
}

export const snakeCaseConfig = (
  schema: v.GenericSchema,
  raw: unknown,
): { config: unknown; renames: ConfigRename[] } => {
  const renames: ConfigRename[] = []
  const config = renamed(schema as Schema, raw, "", renames)
  return { config, renames }
}

/**
 * Reads a config file, moving setting names an older version wrote in camelCase to snake_case. The file is
 * rewritten — in its own mode — only when something moved and the result is valid: a broken file is left as it
 * is for the schema to report. `rewrite: false` reads the moved names and leaves the file as it is.
 */
export const loadSnakeCaseConfig = <T extends v.GenericSchema>(
  path: string,
  schema: T,
  fallback: () => v.InferOutput<T>,
  { rewrite = true }: { rewrite?: boolean } = {},
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
  const { config, renames } = snakeCaseConfig(schema, parsed)
  const result = v.safeParse(schema, config)
  if (!result.success) {
    const problems = result.issues.map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
    throw new CliError("configuration_error", `${path} is not a valid config:\n  ${problems.join("\n  ")}`)
  }
  if (rewrite && renames.length > 0)
    writeSecurely(path, `${JSON.stringify(config, null, 2)}\n`, statSync(path).mode & 0o777)
  return result.output
}
