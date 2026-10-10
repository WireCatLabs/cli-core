import { CliError } from "./errors.js"

const forbidden = new Set(["__proto__", "prototype", "constructor"])
const validate = (paths: readonly string[]): void => {
  if (
    paths.length === 0 ||
    paths.length > 128 ||
    paths.some(
      (path) =>
        path.length > 256 ||
        !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(path) ||
        path.split(".").some((part) => forbidden.has(part)),
    )
  )
    throw new CliError("validation_error", "--fields takes comma-separated field paths, for example id,locator,text")
}

export const fieldsOf = (value: string): string[] => {
  const paths = value.split(",").map((one) => one.trim())
  validate(paths)
  return [...new Set(paths)]
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const select = (value: unknown, paths: readonly string[], item = false): unknown => {
  if (!object(value)) return value
  const fields = item ? paths.map((path) => (path.startsWith("items.") ? path.slice(6) : path)) : paths
  const result: Record<string, unknown> = {}
  for (const path of fields.filter((one) => !fields.some((parent) => parent !== one && one.startsWith(`${parent}.`)))) {
    const parts = path.split(".")
    let found: unknown = value
    for (const part of parts) {
      if (!object(found) || !Object.hasOwn(found, part)) {
        found = undefined
        break
      }
      found = found[part]
    }
    if (found === undefined) continue
    let target = result
    for (const part of parts.slice(0, -1)) {
      if (!object(target[part])) target[part] = {}
      target = target[part] as Record<string, unknown>
    }
    target[parts.at(-1) as string] = found
  }
  for (const name of ["operationId", "sendId"]) if (Object.hasOwn(value, name)) result[name] = value[name]
  return result
}

/** Projects item data while retaining the list envelope and operation identifiers. */
export const projectFields = (value: unknown, fields: readonly string[]): unknown => {
  validate(fields)
  if (Array.isArray(value)) return value.map((item) => select(item, fields, true))
  if (object(value) && Array.isArray(value.items))
    return { ...value, items: value.items.map((item) => select(item, fields, true)) }
  return select(value, fields, object(value) && !Object.hasOwn(value, "items"))
}
