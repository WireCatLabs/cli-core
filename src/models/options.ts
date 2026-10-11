import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"

export const checkedOptions = (
  provider: string,
  schema: v.GenericSchema,
  options: Record<string, unknown>,
): Record<string, unknown> => {
  const parsed = v.safeParse(schema, options)
  if (!parsed.success) {
    throw new CliError(
      "validation_error",
      `${provider} option ${v.getDotPath(parsed.issues[0]) ?? "options"} is unknown or has the wrong type`,
    )
  }
  return parsed.output as Record<string, unknown>
}

export const range = (min: number, max: number) =>
  v.optional(v.pipe(v.number(), v.finite(), v.minValue(min), v.maxValue(max)))
