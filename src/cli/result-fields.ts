import { CliError, fieldsOf as coreFieldsOf, projectFields as coreProjectFields } from "@wirecat/cli-base"

const named = <T>(work: () => T): T => {
  try {
    return work()
  } catch (error) {
    if (error instanceof CliError && error.code === "validation_error")
      throw new CliError("validation_error", "--json takes comma-separated field paths, for example --json=id,text", {
        param: "--json",
      })
    throw error
  }
}

export const fieldsOf = (value: string): string[] => named(() => coreFieldsOf(value))

const isItemAnswer = (value: unknown): value is { item: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "item" in value && "meta" in value

/** An item answer keeps its `next`, `missing` and `meta`; only the item is cut down. */
export const projectFields = (value: unknown, fields: readonly string[]): unknown => {
  return named(() =>
    isItemAnswer(value) ? { ...value, item: coreProjectFields(value.item, fields) } : coreProjectFields(value, fields),
  )
}
