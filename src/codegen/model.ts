/**
 * The model every generator reads, whatever the source was: an OpenAPI file, a Postman collection,
 * a scraped reference page. A source adapter lives in the consumer and produces this; nothing here
 * parses a file format.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"

/** How much the source promises. A Postman example is not a contract and must never become one. */
export type Confidence = "contract" | "example" | "inferred" | "override"

/**
 * `undefined` in an adapter's output means "the source did not say". Generation refuses to run
 * until an override classifies it — a write mistaken for a read is the expensive mistake.
 */
export type Effect = "read" | "write" | "destructive"

export interface HttpBinding {
  kind: "http"
  method: HttpMethod
  path: string
}

/** Every call is the same HTTP shape and only the name differs, as in the Telegram Bot API. */
export interface RpcBinding {
  kind: "rpc"
  name: string
}

export type Binding = HttpBinding | RpcBinding

interface SchemaCommon {
  description?: string
  nullable?: boolean
  deprecated?: boolean
  default?: unknown
}

export type SchemaNode = SchemaCommon &
  (
    | { type: "ref"; ref: string }
    | {
        type: "string"
        format?: "binary" | "file-reference"
        enum?: readonly string[]
        minLength?: number
        maxLength?: number
        pattern?: string
      }
    | { type: "integer"; format?: "int32" | "int64"; minimum?: number; maximum?: number; enum?: readonly number[] }
    | { type: "number"; minimum?: number; maximum?: number }
    | { type: "boolean"; enum?: readonly boolean[] }
    | { type: "array"; items: SchemaNode; minItems?: number; maxItems?: number; uniqueItems?: boolean }
    | {
        type: "object"
        properties: Readonly<Record<string, SchemaNode>>
        required: readonly string[]
        additionalProperties?: SchemaNode
      }
    | { type: "union"; of: readonly SchemaNode[] }
    /** Inheritance: every member must resolve to an object, and the fields are merged. */
    | { type: "allOf"; of: readonly SchemaNode[] }
    /** Only where the source itself says "anything". An adapter never falls back to this. */
    | { type: "unknown" }
  )

/**
 * A base type with subtypes chosen by one property, OpenAPI's `discriminator`. Referenced from
 * inside an `allOf` it means the base's own fields; referenced anywhere else, one of the subtypes.
 */
export interface Discriminator {
  property: string
  mapping: Readonly<Record<string, string>>
}

export interface ApiSchema {
  id: string
  schema: SchemaNode
  discriminator?: Discriminator
}

export interface ApiParameter {
  name: string
  in: "path" | "query" | "header" | "body"
  required: boolean
  description?: string
  schema: SchemaNode
}

export interface ApiBody {
  confidence: Confidence
  required: boolean
  schema?: SchemaNode
  example?: unknown
}

export interface SourceReference {
  /** Where in the source this came from, for a reviewer: a JSON pointer, a folder path. */
  location: string
}

export interface ApiOperation {
  /** The source's own id where it has one. Never re-derived when it does. */
  id: string
  binding: Binding
  summary?: string
  description?: string
  tags: readonly string[]
  parameters: readonly ApiParameter[]
  requestBody?: ApiBody
  response?: ApiBody
  effect?: Effect
  deprecated?: boolean
  source: SourceReference
}

export interface SourceInfo {
  kind: "openapi" | "postman" | "other"
  version?: string
  sourceUrl?: string
  sourceRevision?: string
}

export interface ApiModel {
  source: SourceInfo
  operations: readonly ApiOperation[]
  schemas: readonly ApiSchema[]
}

export interface Override {
  effect?: Effect
  /** Required: an override nobody can explain is one nobody dares remove. */
  reason: string
}

export interface GeneratedArtifact {
  path: string
  content: string
}

export type CodeGenerator = (model: ApiModel) => GeneratedArtifact[]
