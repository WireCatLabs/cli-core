import { createHash } from "node:crypto"
import { holdsCredential, secretNamed } from "../runs/secrets.js"
import { PHONE_COUNTRIES } from "./phones.js"
import { DECIMAL_PATTERN, fieldError, isObject } from "./record-fields.js"
import {
  AMOUNT_ROLES,
  article,
  isRecordType,
  nestedOf,
  RECORD_ENTITY_TYPES,
  RECORD_TYPES,
  type RecordType,
  referencesOf,
  roleOf,
  rolesOf,
  TYPE_PATTERN,
  TYPE_RULE,
  WORD_BODY,
} from "./record-types.js"

export { RECORD_ENTITY_TYPES, type RecordEntityType } from "./record-types.js"

export const RECORDS_SCHEMA_VERSION = 1
export const RECORD_OPERATIONS = ["upsert", "delete"] as const
export type RecordOperation = (typeof RECORD_OPERATIONS)[number]

export interface RecordRelation {
  /** What the target is to this record: `counterparty`, `payer`, `settles`, or a source's own word. */
  role: string
  /** With `external_id`: another record of this account. Left out when `ref` names a store entity instead. */
  type?: string
  external_id?: string
  /** A store entity, such as `organization:12`, in place of `type` and `external_id`. */
  ref?: string
  /** On a relationship role: the part the target plays, such as `decision-maker` or `customer`. */
  as?: string
  /** A `settles` relation's share of the payment, as a decimal in its currency; without one, as far as both allow. */
  amount?: string
}

/** How an envelope's lines read `product`: `text` keeps an invoice line's product as data, as v1 did. */
export const LINE_OPTIONS = ["text", "products"] as const
export interface EnvelopeOptions {
  lines?: (typeof LINE_OPTIONS)[number]
  /**
   * The country a phone number without `+` is read in, such as `es`. Without it such a number is an identifier only
   * when exactly one country of the store's `phone_countries` setting reads it as valid.
   */
  phone_region?: string
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
  options?: EnvelopeOptions
  records: EnvelopeRecord[]
}

/** A refusal: `pointer` is an RFC 6901 JSON pointer into the envelope, `code` a stable word callers may branch on. */
export interface IngestError {
  pointer: string
  code: string
  message: string
  key?: string
  /** The record an entry is about when it is not in this envelope: one of an earlier batch. */
  record?: { type: string; externalId: string }
}

const WORD = `^${WORD_BODY}$`
const MAX_ID = 512
const MAX_FIELDS_BYTES = 65_536
const MAX_RELATIONS = 100
const DECIMAL = DECIMAL_PATTERN
const REF = "^[a-z]+:[^\\s]{1,500}$"

const fieldsDef = (type: RecordType) => `fields-${type}`

/** The v1 envelope as JSON Schema (Draft 2020-12); `schemas/records-envelope.v1.schema.json` is this, written out. */
export const RECORDS_ENVELOPE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "WireCat records envelope, version 1",
  description:
    "Records one source sends to the store. JSONL is the same model: the first line holds schema_version, source " +
    "and options, each further line one record.",
  type: "object",
  required: ["schema_version", "source", "records"],
  additionalProperties: false,
  properties: {
    schema_version: { const: RECORDS_SCHEMA_VERSION },
    source: { $ref: "#/$defs/source" },
    options: { $ref: "#/$defs/options" },
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
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        lines: {
          enum: [...LINE_OPTIONS],
          description:
            "products: an invoice line's product (an external id) names its product; text, the default, keeps it " +
            "as data. Order lines always read it, and product_ref (a product: ref) is read on every line.",
        },
        phone_region: {
          type: "string",
          pattern: "^[A-Za-z]{2}$",
          description:
            "The country a person's phone without + is read in. Without it such a number is an identifier only when " +
            "exactly one country of the store's phone_countries setting reads it as valid",
        },
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
      allOf: RECORD_ENTITY_TYPES.map((type) => ({
        if: { properties: { type: { const: type } }, required: ["type"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's own if/then keyword, never awaited.
        then: { properties: { fields: { $ref: `#/$defs/${fieldsDef(type)}` } } },
      })),
    },
    relation: {
      type: "object",
      required: ["role"],
      additionalProperties: false,
      oneOf: [{ required: ["type", "external_id"] }, { required: ["ref"] }],
      properties: {
        role: { type: "string", pattern: WORD },
        type: { type: "string", pattern: TYPE_PATTERN },
        external_id: { type: "string", minLength: 1, maxLength: MAX_ID },
        ref: { type: "string", pattern: REF, description: "A store entity, such as organization:12" },
        as: {
          type: "string",
          pattern: WORD,
          description: "On a relationship role: the part the target plays, such as decision-maker",
        },
        amount: {
          type: "string",
          pattern: DECIMAL,
          description: "A settles relation's share of the payment, a decimal in its currency",
        },
      },
    },
    ...Object.fromEntries(RECORD_ENTITY_TYPES.map((type) => [fieldsDef(type), RECORD_TYPES[type].fields])),
  },
} as const

const wordPattern = new RegExp(WORD)
const typePattern = new RegExp(TYPE_PATTERN)
const decimalPattern = new RegExp(DECIMAL)
const refPattern = new RegExp(REF)

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

/** The type a relation points at: its own `type`, or the prefix of its `ref`. */
export const targetTypeOf = (relation: RecordRelation): string =>
  relation.ref === undefined ? String(relation.type) : relation.ref.slice(0, relation.ref.indexOf(":"))

const relationErrors = (relations: unknown, at: (string | number)[]): IngestError[] => {
  if (relations === undefined) return []
  if (!Array.isArray(relations) || relations.length > MAX_RELATIONS)
    return [invalid(at, `relations is a list of at most ${MAX_RELATIONS}`)]
  return relations.flatMap((relation, index) => {
    const here = [...at, index]
    if (!isObject(relation)) return [invalid(here, "a relation is an object")]
    const extra = extraKeys(relation, ["role", "type", "external_id", "ref", "as", "amount"])
    if (extra.length > 0)
      return [invalid([...here, extra[0] as string], "a relation holds role, type, external_id, ref, as and amount")]
    if (typeof relation.role !== "string" || !wordPattern.test(relation.role))
      return [invalid([...here, "role"], "a role is lowercase letters, digits, - and _")]
    if (relation.ref !== undefined) {
      if (relation.type !== undefined || relation.external_id !== undefined)
        return [invalid([...here, "ref"], "a relation names its target by ref, or by type and external_id")]
      if (typeof relation.ref !== "string" || !refPattern.test(relation.ref))
        return [invalid([...here, "ref"], "a ref is a store reference, such as organization:12")]
    } else {
      if (typeof relation.type !== "string" || !typePattern.test(relation.type))
        return [invalid([...here, "type"], TYPE_RULE)]
      if (!idText(relation.external_id))
        return [invalid([...here, "external_id"], `an external id takes 1–${MAX_ID} characters`)]
    }
    if (relation.as !== undefined && (typeof relation.as !== "string" || !wordPattern.test(relation.as)))
      return [invalid([...here, "as"], "as is lowercase letters, digits, - and _")]
    if (relation.amount !== undefined && (typeof relation.amount !== "string" || !decimalPattern.test(relation.amount)))
      return [invalid([...here, "amount"], 'an amount is a decimal string, such as "13000.00"')]
    if (relation.amount !== undefined && !AMOUNT_ROLES.includes(relation.role))
      return [invalid([...here, "amount"], `only a ${AMOUNT_ROLES.join(" or ")} relation carries an amount`)]
    return []
  })
}

/** What the type's registry entry says about its fields and roles: run once the record's shape is right. */
const typeErrors = (record: EnvelopeRecord, at: (string | number)[]): IngestError[] => {
  if (record.operation !== "upsert" || !isRecordType(record.type)) return []
  const { type } = record
  const wrong = fieldError(RECORD_TYPES[type].fields, record.fields)
  if (wrong) return [invalid([...at, "fields", ...wrong.at], wrong.message)]
  const relations = record.relations ?? []
  for (const [index, relation] of relations.entries()) {
    const here = [...at, "relations", index]
    const role = roleOf(type, relation.role)
    if (relation.as !== undefined && !role?.relationship)
      return [
        invalid([...here, "as"], `${article(type)} ${type}'s ${relation.role} is not a relationship: it takes no as`),
      ]
    if (role === undefined || role.v1) continue
    const target = targetTypeOf(relation)
    if (!role.targets.includes(target))
      return [
        invalid(
          here,
          `${article(type)} ${type}'s ${relation.role} is ${role.targets.map((one) => `${article(one)} ${one}`).join(" or ")}`,
        ),
      ]
    if (!role.many && relations.some((other, before) => before < index && other.role === relation.role))
      return [invalid(here, `${article(type)} ${type} has one ${relation.role}`, "record.relation-ambiguous")]
  }
  for (const [name, role] of rolesOf(type))
    if (role.required && !relations.some((relation) => relation.role === name))
      return [invalid([...at, "relations"], `${article(type)} ${type} names its ${name} in relations`)]
  return []
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
  const relations = relationErrors(record.relations, [...at, "relations"])
  return withKey(relations.length > 0 ? relations : typeErrors(record as unknown as EnvelopeRecord, at))
}

/** The envelope's own errors (not its records'): when there is one, no record is taken. */
export const envelopeErrors = (envelope: unknown, account: string): IngestError[] => {
  const header = headerErrors(envelope, account, ["records"])
  if (header.length > 0) return header
  if (!Array.isArray((envelope as Record<string, unknown>).records))
    return [invalid(["records"], "records is a list", "envelope.invalid")]
  return []
}

/** A JSONL stream's first line, or an envelope without its records: `schema_version`, `source` and `options`. */
export const headerErrors = (envelope: unknown, account: string, more: string[] = []): IngestError[] => {
  if (!isObject(envelope)) return [invalid([], "an envelope is an object", "envelope.invalid")]
  const extra = extraKeys(envelope, ["schema_version", "source", "options", ...more])
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
  const { options } = envelope
  if (options !== undefined) {
    if (!isObject(options)) return [invalid(["options"], "options is an object", "envelope.invalid")]
    const unknown = extraKeys(options, ["lines", "phone_region"])
    if (unknown.length > 0)
      return [invalid(["options", unknown[0] as string], "options holds lines and phone_region", "envelope.invalid")]
    if (
      options.phone_region !== undefined &&
      (typeof options.phone_region !== "string" ||
        !(PHONE_COUNTRIES as readonly string[]).includes(options.phone_region.toLowerCase()))
    )
      return [
        invalid(
          ["options", "phone_region"],
          `options.phone_region is one of ${PHONE_COUNTRIES.join(", ")}`,
          "envelope.invalid",
        ),
      ]
    if (options.lines !== undefined && !LINE_OPTIONS.includes(options.lines as never))
      return [invalid(["options", "lines"], `options.lines is ${LINE_OPTIONS.join(" or ")}`, "envelope.invalid")]
  }
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
            // What a relation did not carry adds nothing, so every fingerprint stored before amounts, refs and
            // `as` existed stays the same. `ref=` and `as=` cannot be taken for an amount, which is a bare decimal.
            .map((relation) => [
              relation.role,
              ...(relation.ref === undefined ? [relation.type, relation.external_id] : [`ref=${relation.ref}`]),
              ...(relation.amount === undefined ? [] : [relation.amount]),
              ...(relation.as === undefined ? [] : [`as=${relation.as}`]),
            ])
            .sort((a, b) => a.join("\0").localeCompare(b.join("\0"))),
        }),
      ),
    )
    .digest("hex")

const BOM = "\uFEFF"

/** A file's text without the byte-order mark a spreadsheet export puts before it. */
export const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text)

/** One JSONL line as JSON; a line that is not JSON comes back as the text, for the record check to refuse at its index. */
export const jsonLine = (line: string): unknown => {
  try {
    return JSON.parse(withoutBom(line))
  } catch {
    return line
  }
}

/**
 * A JSONL import as the envelope it stands for: the first line holds `schema_version`, `source` and `options`, each
 * further non-empty line one record.
 */
export const envelopeOfJsonl = (text: string): unknown => {
  const lines = withoutBom(text).split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() !== "")
  if (first < 0) return {}
  const header = jsonLine(lines[first] as string)
  const records: unknown[] = []
  for (let at = first + 1; at < lines.length; at++) {
    const line = lines[at] as string
    if (line.trim() !== "") records.push(jsonLine(line))
  }
  return isObject(header) ? { ...header, records } : header
}

/**
 * A file's text as the envelope it stands for: one JSON envelope, or JSONL, told apart by the first non-empty line;
 * a JSON object holding `records` is a whole envelope.
 */
export const envelopeOfText = (text: string): unknown => {
  const clean = withoutBom(text)
  const first = clean.split(/\r?\n/).find((line) => line.trim() !== "")
  const head = first === undefined ? undefined : jsonLine(first)
  if (isObject(head) && !Object.hasOwn(head, "records")) return envelopeOfJsonl(clean)
  return jsonLine(clean)
}

/** A reference a record's fields make to another record of the account, kept so the record waits for it. */
export interface FieldReference {
  /** `fields.<key>` or `fields.<list>.<key>`: a dot keeps it apart from any role a source can send. */
  role: string
  type: string
  external_id: string
}

/**
 * What a record's fields name by external id: a deal's pipeline, a line's product. An invoice's line products only
 * with `options.lines: products`, since v1 kept them as data.
 */
export const fieldReferences = (record: EnvelopeRecord, options: EnvelopeOptions = {}): FieldReference[] => {
  if (record.operation !== "upsert" || !isRecordType(record.type)) return []
  const fields = record.fields ?? {}
  const found: FieldReference[] = []
  for (const [key, type] of referencesOf(record.type))
    if (typeof fields[key] === "string") found.push({ role: `fields.${key}`, type, external_id: fields[key] as string })
  if (record.type === "invoice" && options.lines !== "products") return found
  for (const [list, spec] of nestedOf(record.type)) {
    const items = fields[list]
    if (!Array.isArray(items)) continue
    for (const item of items)
      for (const [key, type] of Object.entries(spec.references ?? {}))
        if (isObject(item) && typeof item[key] === "string")
          found.push({ role: `fields.${list}.${key}`, type, external_id: item[key] as string })
  }
  return found
}
