import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { identifier, type ManifestOperation, type SchemaNode } from "@wirecat/cli-base/codegen"
import { isLosslessNumber, isSafeNumber, LosslessNumber, parse, stringify } from "lossless-json"
import * as v from "valibot"

/** `--timeout` is the program's own deadline: a parameter spelled like it would never reach MAX. */
const RENAMED: Readonly<Record<string, string>> = { timeout: "poll-timeout" }

export const apiFlagOf = (name: string): string =>
  RENAMED[name] ??
  name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()

export const apiOptionKey = (name: string): string =>
  apiFlagOf(name).replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())

const DIGITS = /^-?\d+$/

/** A flag's text as the JSON value it stands for, so a generated schema can judge it. */
const coerce = (raw: string): unknown => {
  if (DIGITS.test(raw)) return new LosslessNumber(raw)
  if (raw === "true" || raw === "false") return raw === "true"
  return raw
}

export const checkApiParameter = (
  name: string,
  node: SchemaNode,
  raw: string,
  schemas: Readonly<Record<string, v.GenericSchema>>,
): string | undefined => {
  switch (node.type) {
    case "ref": {
      const schema = (schemas as Record<string, v.GenericSchema>)[identifier(node.ref)]
      return schema && !v.safeParse(schema, coerce(raw)).success
        ? `--${apiFlagOf(name)} is not a valid ${node.ref}`
        : undefined
    }
    case "union":
      return node.of.some((member) => checkApiParameter(name, member, raw, schemas) === undefined)
        ? undefined
        : `--${apiFlagOf(name)} does not match any allowed type`
    case "integer":
      if (!DIGITS.test(raw)) return `--${apiFlagOf(name)} takes an integer`
      if (node.minimum !== undefined && BigInt(raw) < BigInt(node.minimum))
        return `--${apiFlagOf(name)} is at least ${node.minimum}`
      if (node.maximum !== undefined && BigInt(raw) > BigInt(node.maximum))
        return `--${apiFlagOf(name)} is at most ${node.maximum}`
      return undefined
    case "boolean":
      return raw === "true" || raw === "false" ? undefined : `--${apiFlagOf(name)} takes true or false`
    case "string":
      return node.enum && !node.enum.includes(raw)
        ? `--${apiFlagOf(name)} is one of ${node.enum.join(", ")}`
        : undefined
    case "array":
      return raw
        .split(",")
        .map((item) => checkApiParameter(name, node.items, item.trim(), schemas))
        .find((problem) => problem !== undefined)
    default:
      return undefined
  }
}

export const readApiBody = (
  options: { body?: string; bodyFile?: string },
  read: (path: string | number) => string = (path) => readFileSync(path, "utf8"),
): string | undefined => {
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw new CliError("validation_error", "--body and --body-file both given; pick one")
  }
  if (options.bodyFile !== undefined) return read(options.bodyFile === "-" ? 0 : options.bodyFile)
  if (options.body === "-") return read(0)
  return options.body
}

export const checkApiBody = (
  operation: ManifestOperation,
  text: string | undefined,
  schemas: Readonly<Record<string, v.GenericSchema>>,
): string | undefined => {
  if (text === undefined || text.trim() === "") {
    if (operation.request?.required) {
      throw new CliError(
        "validation_error",
        `${operation.command} needs a JSON body: --body '<json>', --body -, or --body-file`,
      )
    }
    return undefined
  }
  let value: unknown
  try {
    value = parse(text)
  } catch {
    throw new CliError("validation_error", "the body is not valid JSON")
  }
  const schema = operation.request?.schema
    ? (schemas as Record<string, v.GenericSchema>)[operation.request.schema]
    : undefined
  if (schema) {
    const result = v.safeParse(schema, value)
    if (!result.success) {
      // Valibot's own message quotes the value it got — message text, which must not reach a run record.
      const where = result.issues.map(
        (issue) => `${v.getDotPath(issue) ?? "(body)"} expects ${issue.expected ?? issue.kind}`,
      )
      throw new CliError(
        "validation_error",
        `the body does not match ${operation.request?.schema}: ${where.join("; ")}`,
      )
    }
  }
  // The validated output carries ids as strings; MAX wants the digits as numbers, so the text goes as written.
  return text
}

export const parseApiJson = (text: string): unknown => {
  try {
    return parse(text)
  } catch {
    throw new CliError("validation_error", "the body is not valid JSON")
  }
}

export const apiJson = (value: unknown): string => stringify(value) ?? "null"

export const apiPlainJson = (value: unknown): unknown =>
  JSON.parse(
    stringify(value, (_, inner) =>
      isLosslessNumber(inner) && !isSafeNumber(inner.value) ? inner.toString() : inner,
    ) ?? "null",
  )
