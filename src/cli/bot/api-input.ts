import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { identifier, type ManifestOperation, type SchemaNode } from "@wirecat/cli-base/codegen/runtime"
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

/** @experimental */
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

const JSON_BODY = /[/+]json\s*(;|$)/i
const FORM_BODY = /^(multipart\/form-data|application\/x-www-form-urlencoded)\s*(;|$)/i

/** An upload sent as the bytes themselves, as the spec types a binary body: `application/octet-stream`, `image/png`. */
export const sendsBytes = (operation: ManifestOperation): boolean => {
  const type = operation.request?.contentType
  return type !== undefined && !JSON_BODY.test(type) && !FORM_BODY.test(type)
}

/** The file `--body-file` names, `-` for stdin, as the bytes an upload sends. @experimental */
export const readApiBytes = (
  path: string,
  read: (path: string | number) => Uint8Array<ArrayBuffer> = (from) => new Uint8Array(readFileSync(from)),
): Uint8Array<ArrayBuffer> => read(path === "-" ? 0 : path)

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

/** JSON writes NaN and Infinity as `null`: a bad `Number(…)` would reach the service as a cleared field. */
const finite = (key: string, value: unknown): unknown => {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new CliError(
      "validation_error",
      `${key === "" ? "the body" : key} is ${value}, which a request cannot carry; nothing was sent`,
      { sent: false },
    )
  return value
}

export const apiJson = (value: unknown): string => stringify(value, finite) ?? "null"

export const apiPlainJson = (value: unknown): unknown =>
  JSON.parse(
    stringify(value, (key, inner) =>
      isLosslessNumber(inner) && !isSafeNumber(inner.value) ? inner.toString() : finite(key, inner),
    ) ?? "null",
  )

/** A JSON object with no lossless number at its top: what a GraphQL body of variables must be. */
const isVariables = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !isLosslessNumber(value)

/**
 * A GraphQL operation's variables: the body's (`--body`, all of them as one object) with each flag over it, read by
 * the variable's schema. A name the operation does not declare, or a required one left out, is refused unsent.
 */
export const graphqlVariables = (
  operation: ManifestOperation,
  body: string | undefined,
  fields: Readonly<Record<string, string>>,
): Record<string, unknown> => {
  const { binding } = operation
  if (binding.kind !== "graphql")
    throw new CliError("configuration_error", `${operation.command} is not a GraphQL operation`)
  const given = body?.trim() ? parseApiJson(body) : {}
  if (!isVariables(given))
    throw new CliError("validation_error", `${operation.command} takes its variables as one JSON object`, {
      sent: false,
    })
  const variables: Record<string, unknown> = { ...given }
  for (const [name, raw] of Object.entries(fields)) {
    const schema = operation.parameters.find((one) => one.in === "body" && one.name === name)?.schema
    variables[name] = flagValue(operation, name, raw, schema?.type)
  }
  const unknown = Object.keys(variables).filter((name) => !(name in binding.variables))
  if (unknown.length > 0)
    throw new CliError("validation_error", `${operation.command} has no variable ${unknown.join(", ")}`, {
      sent: false,
    })
  const missing = Object.entries(binding.variables)
    .filter(([name, type]) => type.endsWith("!") && variables[name] == null)
    .map(([name]) => `--${apiFlagOf(name)}`)
  if (missing.length > 0)
    throw new CliError("validation_error", `${operation.command} needs ${missing.join(", ")}`, { sent: false })
  return variables
}

const DECIMAL = /^-?\d+(\.\d+)?$/

const flagValue = (operation: ManifestOperation, name: string, raw: string, type: string | undefined): unknown => {
  const flag = `--${apiFlagOf(name)} of ${operation.command}`
  if (type === "integer" || type === "number") {
    // Number() would take 0x10 and 1e1, and round a long id; the digits go as written.
    if (!(type === "integer" ? DIGITS : DECIMAL).test(raw.trim()))
      throw new CliError("validation_error", `${flag} takes ${type === "integer" ? "a whole number" : "a number"}`, {
        sent: false,
      })
    return new LosslessNumber(raw.trim())
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false")
      throw new CliError("validation_error", `${flag} takes true or false`, { sent: false })
    return raw === "true"
  }
  if (type === "object" || type === "array" || type === "unknown") return parseApiJson(raw)
  // An input object or a list given as JSON; an enum's value, behind a ref too, is a bare word.
  if (type === "ref" && /^\s*[{["]/.test(raw)) return parseApiJson(raw)
  return raw
}
