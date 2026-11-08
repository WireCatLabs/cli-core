/**
 * The JSON Schema subset the records envelope uses for a type's `fields`, and its check. Kept small on purpose: the
 * schema file is generated from the same objects, so what the store checks and what a source reads cannot drift.
 */
export interface FieldSchema {
  type?: "string" | "integer" | "boolean" | "array" | "object" | readonly ("string" | "array")[]
  description?: string
  enum?: readonly string[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  maxItems?: number
  items?: FieldSchema
  properties?: Record<string, FieldSchema>
  required?: readonly string[]
  additionalProperties?: boolean
}

export const DECIMAL_PATTERN = "^[0-9]{1,16}(\\.[0-9]{1,6})?$"
const SIGNED_DECIMAL = "^-?[0-9]{1,16}(\\.[0-9]{1,6})?$"
const DAY = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

export const text = (description?: string, maxLength = 2000): FieldSchema => ({
  type: "string",
  minLength: 1,
  maxLength,
  ...(description ? { description } : {}),
})
export const decimal = (description: string): FieldSchema => ({ type: "string", pattern: DECIMAL_PATTERN, description })
export const signedDecimal = (description: string): FieldSchema => ({
  type: "string",
  pattern: SIGNED_DECIMAL,
  description,
})
export const day = (description: string): FieldSchema => ({ type: "string", pattern: DAY, description })
export const oneOf = (values: readonly string[], description?: string): FieldSchema => ({
  type: "string",
  enum: values,
  ...(description ? { description } : {}),
})
export const currency: FieldSchema = { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 4217 code" }
/** An object whose known keys are typed; any other key is kept as the source sent it. */
export const objectOf = (
  properties: Record<string, FieldSchema>,
  { required, description }: { required?: readonly string[]; description?: string } = {},
): FieldSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  ...(required?.length ? { required } : {}),
  additionalProperties: true,
})

export const listOf = (item: FieldSchema, maxItems: number, description: string): FieldSchema => ({
  type: "array",
  items: item,
  maxItems,
  description,
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const typeOf = (value: unknown): string => {
  if (Array.isArray(value)) return "array"
  if (value === null) return "null"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

const WHAT: Record<string, string> = {
  string: "text",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
}

/** The first place `value` breaks `schema`, as path segments below the checked value, and why; nothing when it fits. */
export const fieldError = (
  schema: FieldSchema,
  value: unknown,
  at: (string | number)[] = [],
): { at: (string | number)[]; message: string } | undefined => {
  const name = at.length ? `fields.${at.join(".")}` : "fields"
  if (schema.type !== undefined) {
    const allowed = typeof schema.type === "string" ? [schema.type] : schema.type
    if (!allowed.includes(typeOf(value) as never))
      return { at, message: `${name} is ${allowed.map((one) => WHAT[one]).join(" or ")}` }
  }
  if (typeof value === "string") {
    if (schema.enum && !schema.enum.includes(value))
      return { at, message: `${name} is one of ${schema.enum.join(", ")}` }
    if (schema.minLength !== undefined && value.trim().length < schema.minLength)
      return { at, message: `${name} is not empty` }
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return { at, message: `${name} takes at most ${schema.maxLength} characters` }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      return { at, message: `${name} does not have the form ${schema.description ?? schema.pattern}` }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      return { at, message: `${name} is ${schema.minimum} or more` }
    if (schema.maximum !== undefined && value > schema.maximum)
      return { at, message: `${name} is ${schema.maximum} or less` }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return { at, message: `${name} holds at most ${schema.maxItems} items` }
    if (schema.items)
      for (const [index, item] of value.entries()) {
        const found = fieldError(schema.items, item, [...at, index])
        if (found) return found
      }
  }
  if (isObject(value)) {
    for (const key of schema.required ?? [])
      if (value[key] === undefined || value[key] === null)
        return { at: [...at, key], message: `${name}.${key} is required` }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined || value[key] === null) continue
      const found = fieldError(property, value[key], [...at, key])
      if (found) return found
    }
  }
  return undefined
}
