import { createHash } from "node:crypto"
import { holdsCredential, secretNamed } from "../runs/secrets.js"
import { AMOUNT_ROLES, TYPE_PATTERN, TYPE_RULE, WORD_BODY } from "./record-types.js"

export { RECORD_ENTITY_TYPES, type RecordEntityType } from "./record-types.js"

export const RECORDS_SCHEMA_VERSION = 1
export const RECORD_OPERATIONS = ["upsert", "delete"] as const
export type RecordOperation = (typeof RECORD_OPERATIONS)[number]

export interface RecordRelation {
  /** What the target is to this record: `counterparty`, `payer`, `settles`, or a source's own word. */
  role: string
  type: string
  external_id: string
  /** A `settles` relation's share of the payment, as a decimal in its currency; without one, as far as both allow. */
  amount?: string
}

export interface EnvelopeRecord {
  /** The caller's name for this line, unique in the envelope; the receipt cites it. */
  key: string
  type: string
  external_id: string
  operation: RecordOperation
  fields?: Record<string, unknown>
  /** Goes up with each change at the source; a lower one than the store holds is refused. */
  revision?: number
  relations?: RecordRelation[]
}

export interface EnvelopeSource {
  provider: string
  account: string
  batch_id: string
}

export interface RecordsEnvelope {
  schema_version: 1
  source: EnvelopeSource
  records: EnvelopeRecord[]
}

/** A refusal: `pointer` is an RFC 6901 JSON pointer into the envelope, `code` a stable word callers may branch on. */
export interface IngestError {
  pointer: string
  code: string
  message: string
  key?: string
}

const WORD = `^${WORD_BODY}$`
const MAX_ID = 512
const MAX_FIELDS_BYTES = 65_536
const MAX_RELATIONS = 100
const DECIMAL = "^[0-9]{1,16}(\\.[0-9]{1,6})?$"

/** The v1 envelope as JSON Schema (Draft 2020-12); `schemas/records-envelope.v1.schema.json` is this, written out. */
export const RECORDS_ENVELOPE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "WireCat records envelope, version 1",
  description:
    "Records one source sends to the store. JSONL is the same model: the first line holds schema_version and " +
    "source, each further line one record.",
  type: "object",
  required: ["schema_version", "source", "records"],
  additionalProperties: false,
  properties: {
    schema_version: { const: RECORDS_SCHEMA_VERSION },
    source: { $ref: "#/$defs/source" },
    records: { type: "array", items: { $ref: "#/$defs/record" } },
  },
  $defs: {
    source: {
      type: "object",
      required: ["provider", "account", "batch_id"],
      additionalProperties: false,
      properties: {
        provider: { type: "string", pattern: WORD, description: "The system the records come from" },
        account: { type: "string", minLength: 1, maxLength: MAX_ID, description: "The account in that system" },
        batch_id: { type: "string", minLength: 1, maxLength: MAX_ID, description: "This import, for the receipt" },
      },
    },
    record: {
      type: "object",
      required: ["key", "type", "external_id", "operation"],
      additionalProperties: false,
      properties: {
        key: { type: "string", minLength: 1, maxLength: MAX_ID },
        type: { type: "string", pattern: TYPE_PATTERN },
        external_id: { type: "string", minLength: 1, maxLength: MAX_ID },
        operation: { enum: [...RECORD_OPERATIONS] },
        fields: {
          type: "object",
          description: "What the source says, as data: never secrets, never instructions",
        },
        revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        relations: { type: "array", maxItems: MAX_RELATIONS, items: { $ref: "#/$defs/relation" } },
      },
    },
    relation: {
      type: "object",
      required: ["role", "type", "external_id"],
      additionalProperties: false,
      properties: {
        role: { type: "string", pattern: WORD },
        type: { type: "string", pattern: TYPE_PATTERN },
        external_id: { type: "string", minLength: 1, maxLength: MAX_ID },
        amount: {
          type: "string",
          pattern: DECIMAL,
          description: "A settles relation's share of the payment, a decimal in its currency",
        },
      },
    },
  },
} as const

const wordPattern = new RegExp(WORD)
const typePattern = new RegExp(TYPE_PATTERN)
const decimalPattern = new RegExp(DECIMAL)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const escapePointer = (segment: string | number) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
export const pointerOf = (...segments: (string | number)[]) => segments.map((s) => `/${escapePointer(s)}`).join("")

const idText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID && !value.includes("\0")

const extraKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).filter((key) => !allowed.includes(key))

/** The first secret in `fields`, as a pointer below it: a secret-named key, or a value in a known credential shape. */
const secretIn = (value: unknown, at: (string | number)[]): (string | number)[] | undefined => {
  if (typeof value === "string") return holdsCredential(value) ? at : undefined
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretIn(item, [...at, index])
      if (found) return found
    }
    return undefined
  }
  if (!isObject(value)) return undefined
  for (const [key, item] of Object.entries(value)) {
    if (secretNamed(key)) return [...at, key]
    const found = secretIn(item, [...at, key])
    if (found) return found
  }
  return undefined
}

const relationErrors = (relations: unknown, at: (string | number)[]): IngestError[] => {
  if (relations === undefined) return []
  if (!Array.isArray(relations) || relations.length > MAX_RELATIONS)
    return [invalid(at, `relations is a list of at most ${MAX_RELATIONS}`)]
  return relations.flatMap((relation, index) => {
    const here = [...at, index]
    if (!isObject(relation)) return [invalid(here, "a relation is an object")]
    const extra = extraKeys(relation, ["role", "type", "external_id", "amount"])
    if (extra.length > 0)
      return [invalid([...here, extra[0] as string], "a relation holds role, type, external_id and amount")]
    if (typeof relation.role !== "string" || !wordPattern.test(relation.role))
      return [invalid([...here, "role"], "a role is lowercase letters, digits, - and _")]
    if (typeof relation.type !== "string" || !typePattern.test(relation.type))
      return [invalid([...here, "type"], TYPE_RULE)]
    if (!idText(relation.external_id))
      return [invalid([...here, "external_id"], `an external id takes 1–${MAX_ID} characters`)]
    if (relation.amount !== undefined && (typeof relation.amount !== "string" || !decimalPattern.test(relation.amount)))
      return [invalid([...here, "amount"], 'an amount is a decimal string, such as "13000.00"')]
    if (relation.amount !== undefined && !AMOUNT_ROLES.includes(relation.role))
      return [invalid([...here, "amount"], `only a ${AMOUNT_ROLES.join(" or ")} relation carries an amount`)]
    return []
  })
}

const invalid = (at: (string | number)[], message: string, code = "record.invalid"): IngestError => ({
  pointer: pointerOf(...at),
  code,
  message,
})

/** Why one record cannot be taken, or nothing; `index` is its place in `records`. */
export const recordErrors = (record: unknown, index: number): IngestError[] => {
  const at = ["records", index]
  if (!isObject(record)) return [invalid(at, "a record is an object")]
  const key = typeof record.key === "string" ? record.key : undefined
  const withKey = (errors: IngestError[]) => errors.map((error) => (key === undefined ? error : { ...error, key }))
  const extra = extraKeys(record, ["key", "type", "external_id", "operation", "fields", "revision", "relations"])
  if (extra.length > 0) return withKey([invalid([...at, extra[0] as string], `a record has no ${extra[0]}`)])
  if (!idText(record.key)) return [invalid([...at, "key"], `a key takes 1–${MAX_ID} characters`)]
  if (typeof record.type !== "string" || !typePattern.test(record.type))
    return withKey([invalid([...at, "type"], TYPE_RULE, "record.type")])
  if (!idText(record.external_id))
    return withKey([invalid([...at, "external_id"], `an external id takes 1–${MAX_ID} characters`)])
  if (!RECORD_OPERATIONS.includes(record.operation as RecordOperation))
    return withKey([invalid([...at, "operation"], "an operation is upsert or delete")])
  if (
    record.revision !== undefined &&
    (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0)
  )
    return withKey([invalid([...at, "revision"], "a revision is a whole number, 0 or more")])
  if (record.operation === "upsert" && !isObject(record.fields))
    return withKey([invalid([...at, "fields"], "an upsert carries its fields as an object")])
  if (record.fields !== undefined && !isObject(record.fields))
    return withKey([invalid([...at, "fields"], "fields is an object")])
  if (record.fields !== undefined && Buffer.byteLength(JSON.stringify(record.fields)) > MAX_FIELDS_BYTES)
    return withKey([invalid([...at, "fields"], `fields take at most ${MAX_FIELDS_BYTES} bytes`, "record.too-large")])
  const secret = record.fields === undefined ? undefined : secretIn(record.fields, [...at, "fields"])
  if (secret)
    return withKey([
      invalid(secret, "a secret never goes into the store: drop this field at the source", "record.secret-field"),
    ])
  return withKey(relationErrors(record.relations, [...at, "relations"]))
}

/** The envelope's own errors (not its records'): when there is one, no record is taken. */
export const envelopeErrors = (envelope: unknown, account: string): IngestError[] => {
  if (!isObject(envelope)) return [invalid([], "an envelope is an object", "envelope.invalid")]
  const extra = extraKeys(envelope, ["schema_version", "source", "records"])
  if (extra.length > 0) return [invalid([extra[0] as string], `an envelope has no ${extra[0]}`, "envelope.invalid")]
  if (envelope.schema_version !== RECORDS_SCHEMA_VERSION)
    return [
      invalid(
        ["schema_version"],
        `this build reads schema_version ${RECORDS_SCHEMA_VERSION}, not ${JSON.stringify(envelope.schema_version)}`,
        "envelope.schema-version",
      ),
    ]
  const { source } = envelope
  if (!isObject(source)) return [invalid(["source"], "source is an object", "envelope.invalid")]
  const sourceExtra = extraKeys(source, ["provider", "account", "batch_id"])
  if (sourceExtra.length > 0)
    return [
      invalid(["source", sourceExtra[0] as string], "source holds provider, account and batch_id", "envelope.invalid"),
    ]
  if (typeof source.provider !== "string" || !wordPattern.test(source.provider))
    return [invalid(["source", "provider"], "a provider is lowercase letters, digits, - and _", "envelope.invalid")]
  if (!idText(source.account))
    return [invalid(["source", "account"], `an account takes 1–${MAX_ID} characters`, "envelope.invalid")]
  if (!idText(source.batch_id))
    return [invalid(["source", "batch_id"], `a batch id takes 1–${MAX_ID} characters`, "envelope.invalid")]
  if (source.account !== account)
    return [
      invalid(
        ["source", "account"],
        `the envelope is for account ${JSON.stringify(source.account)}, the import for ${JSON.stringify(account)}`,
        "envelope.account-mismatch",
      ),
    ]
  if (!Array.isArray(envelope.records)) return [invalid(["records"], "records is a list", "envelope.invalid")]
  return []
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}

/** The same fields and relations in any key or relation order give the same fingerprint. */
export const recordFingerprint = (fields: Record<string, unknown>, relations: RecordRelation[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          fields,
          relations: relations
            // A relation without an amount keeps the fingerprint it had before amounts existed.
            .map((relation) => [
              relation.role,
              relation.type,
              relation.external_id,
              ...(relation.amount === undefined ? [] : [relation.amount]),
            ])
            .sort((a, b) => a.join("\0").localeCompare(b.join("\0"))),
        }),
      ),
    )
    .digest("hex")

/**
 * A JSONL import as the envelope it stands for: the first line holds `schema_version` and `source`, each further
 * non-empty line one record. A line that is not JSON comes back as a record the envelope check refuses, at its index.
 */
export const envelopeOfJsonl = (text: string): unknown => {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() !== "")
  if (first < 0) return {}
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line)
    } catch {
      return line
    }
  }
  const header = parse(lines[first] as string)
  const records: unknown[] = []
  for (let at = first + 1; at < lines.length; at++) {
    const line = lines[at] as string
    if (line.trim() !== "") records.push(parse(line))
  }
  return isObject(header) ? { ...header, records } : header
}
