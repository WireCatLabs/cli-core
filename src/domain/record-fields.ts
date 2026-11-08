/**
 * The JSON Schema 2020-12 subset the records envelope uses for a type's `fields`, and a check that gives the verdict a
 * standard validator gives (`record-fields.test.ts` holds the two to the same fixtures) plus the place and a reason.
 */
type JsonType = "string" | "integer" | "boolean" | "array" | "object" | "null"

export interface FieldSchema {
  type?: JsonType | readonly JsonType[]
  description?: string
  enum?: readonly (string | null)[]
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
export const enumOf = (values: readonly string[], description?: string): FieldSchema => ({
  type: "string",
  enum: values,
  ...(description ? { description } : {}),
})
export const currency: FieldSchema = { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 4217 code" }

/** A key a source may also send as `null`, as v1 read a missing value. */
const nullable = (schema: FieldSchema): FieldSchema => {
  if (schema.type === undefined) return schema
  const types = typeof schema.type === "string" ? [schema.type] : [...schema.type]
  return {
    ...schema,
    type: types.includes("null") ? types : [...types, "null"],
    ...(schema.enum ? { enum: [...schema.enum, null] } : {}),
  }
}

/** An object whose known keys are typed, each but the required ones also `null`; any other key is kept as sent. */
export const objectOf = (
  properties: Record<string, FieldSchema>,
  { required, description }: { required?: readonly string[]; description?: string } = {},
): FieldSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties: Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, required?.includes(key) ? schema : nullable(schema)]),
  ),
  ...(required?.length ? { required } : {}),
  additionalProperties: true,
})

export const arrayOf = (item: FieldSchema, maxItems: number, description: string): FieldSchema => ({
  type: "array",
  items: item,
  maxItems,
  description,
})

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const typeOf = (value: unknown): JsonType | "number" | "other" => {
  if (Array.isArray(value)) return "array"
  if (value === null) return "null"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "boolean"
  return typeof value === "object" ? "object" : "other"
}

const WHAT: Record<JsonType, string> = {
  string: "text",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  null: "null",
}

/** The first place `value` breaks `schema`, as path segments below the checked value, and why; nothing when it fits. */
export const fieldError = (
  schema: FieldSchema,
  value: unknown,
  at: (string | number)[] = [],
): { at: (string | number)[]; message: string } | undefined => {
  const name = at.length ? `fields.${at.join(".")}` : "fields"
  if (schema.type !== undefined) {
    const allowed: readonly JsonType[] = typeof schema.type === "string" ? [schema.type] : schema.type
    if (!allowed.includes(typeOf(value) as JsonType))
      return { at, message: `${name} is ${allowed.map((one) => WHAT[one]).join(" or ")}` }
  }
  if (schema.enum && !schema.enum.includes(value as string | null))
    return { at, message: `${name} is one of ${schema.enum.filter((one) => one !== null).join(", ")}` }
  if (typeof value === "string") {
    // JSON Schema counts code points, not UTF-16 units, and never trims.
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength)
      return { at, message: `${name} takes at least ${schema.minLength} characters` }
    if (schema.maxLength !== undefined && length > schema.maxLength)
      return { at, message: `${name} takes at most ${schema.maxLength} characters` }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
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
      if (!Object.hasOwn(value, key)) return { at: [...at, key], message: `${name}.${key} is required` }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue
      const found = fieldError(property, value[key], [...at, key])
      if (found) return found
    }
  }
  return undefined
}
