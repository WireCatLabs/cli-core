import type { ApiModel, ApiSchema, SchemaNode } from "./model.js"
import { CodegenError } from "./pipeline.js"

type ObjectNode = Extract<SchemaNode, { type: "object" }>

const pascal = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("")

export const identifier = (id: string): string => {
  const name = pascal(id)
  return /^[A-Za-z]/.test(name) ? name : `Schema${name}`
}

/** `getMyInfo` → `get-my-info`. */
export const kebab = (id: string): string =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()

export interface NamedSchema {
  name: string
  schema: ApiSchema
}

/**
 * The schema index generators share: named components, inline request and response bodies given a
 * name of their own, and which subtype each discriminator value selects.
 */
export class SchemaTree {
  readonly named: NamedSchema[]
  readonly #byId: Map<string, ApiSchema>
  readonly #literals = new Map<string, { property: string; value: string }>()
  readonly #requests = new Map<string, string>()
  readonly #responses = new Map<string, string>()

  constructor(model: ApiModel) {
    this.#byId = new Map(model.schemas.map((schema) => [schema.id, schema]))
    this.named = model.schemas.map((schema) => ({ name: identifier(schema.id), schema }))

    const taken = new Set(this.named.map((entry) => entry.name))
    const nameInline = (operationId: string, suffix: string, node: SchemaNode | undefined): string | undefined => {
      if (!node) return undefined
      if (node.type === "ref") return identifier(node.ref)
      const name = identifier(`${operationId} ${suffix}`)
      if (taken.has(name))
        throw new CodegenError([`inline ${suffix.toLowerCase()} of "${operationId}" collides with ${name}`])
      taken.add(name)
      this.named.push({ name, schema: { id: name, schema: node } })
      return name
    }
    for (const operation of model.operations) {
      const request = nameInline(operation.id, "Request", operation.requestBody?.schema)
      const response = nameInline(operation.id, "Response", operation.response?.schema)
      if (request) this.#requests.set(operation.id, request)
      if (response) this.#responses.set(operation.id, response)
    }

    for (const schema of model.schemas) {
      for (const [value, target] of Object.entries(schema.discriminator?.mapping ?? {})) {
        if (this.#literals.has(target)) {
          throw new CodegenError([`schema "${target}" is a subtype of two discriminated schemas`])
        }
        this.#literals.set(target, { property: schema.discriminator?.property ?? "", value })
      }
    }
  }

  schema(id: string): ApiSchema {
    const schema = this.#byId.get(id)
    if (!schema) throw new CodegenError([`unknown schema "${id}"`])
    return schema
  }

  requestName(operationId: string): string | undefined {
    return this.#requests.get(operationId)
  }

  responseName(operationId: string): string | undefined {
    return this.#responses.get(operationId)
  }

  /** The value a subtype's discriminator property must hold, if the schema is a subtype. */
  literalFor(id: string): { property: string; value: string } | undefined {
    return this.#literals.get(id)
  }

  /** Merges inheritance into one object. A member that is not an object stops generation. */
  flatten(node: SchemaNode, where: string): ObjectNode {
    if (node.type === "object") return node
    if (node.type === "ref") return this.flatten(this.schema(node.ref).schema, `${where} → ${node.ref}`)
    if (node.type !== "allOf") {
      throw new CodegenError([`${where}: allOf member of type "${node.type}" cannot be merged into an object`])
    }
    const merged: { properties: Record<string, SchemaNode>; required: string[]; additionalProperties?: SchemaNode } = {
      properties: {},
      required: [],
    }
    for (const member of node.of) {
      const part = this.flatten(member, where)
      Object.assign(merged.properties, part.properties)
      for (const name of part.required) if (!merged.required.includes(name)) merged.required.push(name)
      if (part.additionalProperties) merged.additionalProperties = part.additionalProperties
    }
    return { type: "object", description: node.description, nullable: node.nullable, ...merged }
  }
}
