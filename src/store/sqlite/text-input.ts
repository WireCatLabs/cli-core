import { CliError } from "@wirecat/cli-base"

/** Trimmed text of 1–`max` characters, or 0–`max` when empty is allowed. */
export const textOf = (text: string, what: string, max = 100_000, allowEmpty = false) => {
  const value = text.trim()
  if ((!value && !allowEmpty) || value.length > max)
    throw new CliError("validation_error", `${what} takes ${allowEmpty ? 0 : 1}–${max} characters`)
  return value
}

export const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T => {
  if (!allowed.includes(value as T)) throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}
