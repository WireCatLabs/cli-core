import { CliError } from "@wirecat/cli-base"
import { identifier, type ManifestOperation, type SchemaNode } from "@wirecat/cli-base/codegen"
import { isLosslessNumber, LosslessNumber } from "lossless-json"
import type { ApiCommandInput } from "./api.js"
import { apiJson, parseApiJson } from "./api-input.js"

type Definitions = Readonly<Record<string, SchemaNode>>
type ObjectValue = Record<string, unknown>

export interface RpcApiBody {
  text?: string
  value: ObjectValue
  files: { field: string; path: string }[]
  secrets: string[]
}

const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !isLosslessNumber(value)

const resolved = (node: SchemaNode, definitions: Definitions): SchemaNode => {
  const seen = new Set<string>()
  let nullable = node.nullable
  let sensitive = node.sensitive
  while (node.type === "ref") {
    if (seen.has(node.ref))
      throw new CliError("configuration_error", "a generated API reference cycle cannot be resolved")
    seen.add(node.ref)
    const next = definitions[identifier(node.ref)]
    if (!next) throw new CliError("configuration_error", `the generated API has no schema ${node.ref}`)
    nullable ||= next.nullable
    sensitive ||= next.sensitive
    node = next
  }
  return { ...node, ...(nullable ? { nullable } : {}), ...(sensitive ? { sensitive } : {}) }
}

const matches = (value: unknown, original: SchemaNode, definitions: Definitions, depth = 0): boolean => {
  if (depth > 128) throw new CliError("validation_error", "the API body is nested too deeply")
  const node = resolved(original, definitions)
  if (value === null && node.nullable) return true
  switch (node.type) {
    case "union":
      return node.of.some((member) => matches(value, member, definitions, depth + 1))
    case "allOf":
      return node.of.every((member) => matches(value, member, definitions, depth + 1))
    case "string":
      return typeof value === "string" && (!node.enum || node.enum.includes(value))
    case "integer":
      return isLosslessNumber(value)
        ? /^-?\d+$/.test(value.value)
        : typeof value === "number" && Number.isSafeInteger(value)
    case "number":
      return typeof value === "number" || isLosslessNumber(value)
    case "boolean":
      return typeof value === "boolean" && (!node.enum || node.enum.includes(value))
    case "array":
      return Array.isArray(value) && value.every((item) => matches(item, node.items, definitions, depth + 1))
    case "object":
      return (
        object(value) &&
        node.required.every((name) => value[name] !== undefined) &&
        Object.entries(node.properties).every(
          ([name, field]) => value[name] === undefined || matches(value[name], field, definitions, depth + 1),
        )
      )
    case "unknown":
      return true
    case "ref":
      return false
  }
}

const flagValue = (raw: string, original: SchemaNode, definitions: Definitions): unknown => {
  const node = resolved(original, definitions)
  switch (node.type) {
    case "string":
      return raw
    case "boolean":
      if (raw === "true" || raw === "false") return raw === "true"
      break
    case "integer":
      if (/^-?\d+$/.test(raw)) return new LosslessNumber(raw)
      break
    case "number": {
      const value = parseApiJson(raw)
      if (typeof value === "number" || isLosslessNumber(value)) return value
      break
    }
    case "union":
      for (const member of node.of) {
        try {
          const value = flagValue(raw, member, definitions)
          if (matches(value, member, definitions)) return value
        } catch (error) {
          if ((error as { code?: string }).code === "configuration_error") throw error
        }
      }
      break
    case "object":
    case "array":
    case "allOf":
    case "unknown":
      return parseApiJson(raw)
    case "ref":
      break
  }
  throw new CliError("validation_error", "an API parameter does not match its declared type")
}

export const prepareRpcApiBody = (
  operation: ManifestOperation,
  input: ApiCommandInput,
  definitions: Definitions,
): RpcApiBody => {
  const parsed = input.body?.trim() ? parseApiJson(input.body) : {}
  if (!object(parsed)) throw new CliError("validation_error", "an RPC API body must be a JSON object")
  const value = { ...parsed }
  for (const parameter of operation.parameters) {
    const raw = input.fields[parameter.name]
    if (raw === undefined) continue
    if (parameter.sensitive)
      throw new CliError("validation_error", "secret API fields must be read from stdin or a JSON file")
    if (Object.hasOwn(value, parameter.name))
      throw new CliError("validation_error", `${parameter.name} was given in both the body and a flag`)
    value[parameter.name] = flagValue(raw, parameter.schema, definitions)
  }
  const files: RpcApiBody["files"] = []
  const secrets: string[] = []
  const references = new Set<string>()
  let depth = 0
  const walk = (current: unknown, original: SchemaNode): unknown => {
    if (++depth > 128) throw new CliError("validation_error", "the API body is nested too deeply")
    try {
      const node = resolved(original, definitions)
      if (node.sensitive && typeof current === "string" && current !== "") secrets.push(current)
      if (node.type === "union") {
        const member = node.of.find((candidate) => matches(current, candidate, definitions))
        return member ? walk(current, member) : current
      }
      if (node.type === "allOf") return node.of.reduce((part, member) => walk(part, member), current)
      if (node.type === "array" && Array.isArray(current)) return current.map((item) => walk(item, node.items))
      if (node.type === "object" && object(current))
        return Object.fromEntries(
          Object.entries(current).map(([name, field]) => {
            const schema = node.properties[name] ?? node.additionalProperties
            return [name, schema ? walk(field, schema) : field]
          }),
        )
      if (node.type === "string" && node.format && typeof current === "string") {
        if (current.startsWith("@")) {
          const path = current.slice(1)
          if (!path) throw new CliError("validation_error", "an API file reference needs a path after @")
          let field = `_api_file_${files.length}`
          while (Object.hasOwn(value, field) || files.some((file) => file.field === field)) field += "_"
          files.push({ field, path })
          return `attach://${field}`
        }
        if (current.startsWith("attach://")) references.add(current.slice(9))
      }
      return current
    } finally {
      depth--
    }
  }
  const schema = operation.request?.schema ? definitions[operation.request.schema] : undefined
  if (operation.request?.schema && !schema)
    throw new CliError("configuration_error", "the generated API request schema is missing")
  const prepared = schema ? walk(value, schema) : value
  if (secrets.length > 0 && input.bodySource === "argument")
    throw new CliError("validation_error", "secret API fields must be read from stdin or a JSON file")
  for (const field of references)
    if (!files.some((file) => file.field === field))
      throw new CliError("validation_error", "an API multipart reference has no corresponding file; use @path")
  return {
    value: prepared as ObjectValue,
    ...(operation.request || Object.keys(value).length ? { text: apiJson(prepared) } : {}),
    files,
    secrets,
  }
}
