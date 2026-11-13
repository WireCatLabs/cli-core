import type { FieldSchema } from "./record-fields.js"
import { RECORD_TYPES, type RecordRoleSpec, type RecordTypeSpec } from "./record-types.js"
import {
  type EnvelopeOptions,
  type EnvelopeRecord,
  type EnvelopeSource,
  type IngestError,
  pointerOf,
  RECORDS_SCHEMA_VERSION,
  type RecordRelation,
  type RecordsEnvelope,
} from "./records.js"

/** The types a table can carry: an SMS and a call come from a phone's own export, never from a hand-made sheet. */
export const TABLE_RECORD_TYPES = Object.keys(RECORD_TYPES).filter(
  (type) => (RECORD_TYPES[type as keyof typeof RECORD_TYPES] as RecordTypeSpec).sheet !== false,
) as readonly string[]

export type ColumnShape = "text" | "decimal" | "day" | "instant" | "currency" | "integer" | "boolean" | "list"

export interface TableColumn {
  /** `external_id`, a field (`total`), a role (`counterparty`) or an item of a list (`lines.amount`). */
  name: string
  kind: "id" | "field" | "role" | "item"
  required: boolean
  shape: ColumnShape
  description: string
  values?: readonly string[]
  /** A role's target types: one names the target's external id, several take `<type>:<external id>`. */
  targets?: readonly string[]
  /** Several values in the cell, split by `|`. */
  many?: boolean
}

/** Where a pointer into the envelope came from in the sheet: its line from 1 (the header is 1), and the column. */
export interface TablePlace {
  line: number
  column?: string
}

export interface TableEnvelope {
  envelope: RecordsEnvelope
  /** The sheet's place of a receipt's or an error's pointer, by its longest known prefix. */
  placeOf(pointer: string): TablePlace | undefined
}

export class TableError extends Error {
  constructor(readonly errors: (IngestError & { place?: TablePlace })[]) {
    super(errors.map((e) => e.message).join("; "))
  }
}

const LIST_SEPARATOR = "|"
const BOM = "﻿"

const specOf = (type: string): RecordTypeSpec | undefined => (RECORD_TYPES as Record<string, RecordTypeSpec>)[type]

const typesOf = (schema: FieldSchema): string[] =>
  schema.type === undefined ? [] : typeof schema.type === "string" ? [schema.type] : [...schema.type]

const shapeOf = (schema: FieldSchema): ColumnShape => {
  const types = typesOf(schema)
  if (types.includes("integer")) return "integer"
  if (types.includes("boolean")) return "boolean"
  if (types.includes("array")) return "list"
  if (schema.pattern?.includes("T[0-9]{2}")) return "instant"
  if (schema.pattern?.startsWith("^[0-9]{4}-")) return "day"
  if (schema.pattern?.includes("[A-Za-z]{3}")) return "currency"
  if (schema.pattern?.includes("(\\.[0-9]")) return "decimal"
  return "text"
}

const valuesOf = (schema: FieldSchema) => schema.enum?.filter((v): v is string => v !== null)

const flat = (schema: FieldSchema) => {
  const types = typesOf(schema)
  return !types.includes("object") && !(types.includes("array") && schema.items?.type === "object")
}

const fieldColumn = (name: string, schema: FieldSchema, required: boolean, kind: "field" | "item"): TableColumn => {
  const values = valuesOf(schema)
  const shape = shapeOf(schema)
  return {
    name,
    kind,
    required,
    shape,
    description: schema.description ?? "",
    ...(values ? { values } : {}),
    ...(shape === "list" ? { many: true } : {}),
  }
}

const roleColumn = (name: string, role: RecordRoleSpec): TableColumn => ({
  name,
  kind: "role",
  required: role.required === true,
  shape: "text",
  description:
    role.targets.length === 1
      ? `The ${role.targets[0]}'s external id`
      : `<type>:<external id>, the type one of ${role.targets.join(", ")}`,
  targets: role.targets,
  ...(role.many ? { many: true } : {}),
})

/** A type's columns: the external id, its flat fields, one per role, then one per key of each list of items. */
export const recordColumns = (type: string): TableColumn[] => {
  const spec = specOf(type)
  if (!spec || spec.sheet === false) return []
  const fields = spec.fields.properties ?? {}
  const required = spec.fields.required ?? []
  const lists = Object.entries(fields).filter(([, schema]) => !flat(schema))
  return [
    { name: "external_id", kind: "id", required: true, shape: "text", description: "Its id in your system" },
    ...Object.entries(fields)
      .filter(([, schema]) => flat(schema))
      .map(([name, schema]) => fieldColumn(name, schema, required.includes(name), "field")),
    ...Object.entries(spec.roles)
      .filter(([, role]) => !role.linked)
      .map(([name, role]) => roleColumn(name, role)),
    ...lists.flatMap(([list, schema]) => {
      const item = schema.items ?? {}
      const own = item.required ?? []
      return Object.entries(item.properties ?? {}).map(([key, s]) =>
        fieldColumn(`${list}.${key}`, s, required.includes(list) && own.includes(key), "item"),
      )
    }),
  ]
}

const csvCell = (value: string, separator: string) =>
  /["\r\n]/.test(value) || value.includes(separator) ? `"${value.replaceAll('"', '""')}"` : value

const example = (column: TableColumn): unknown => {
  if (column.values?.[0]) return column.values[0]
  switch (column.shape) {
    case "decimal":
      return "100.00"
    case "day":
      return "2026-01-31"
    case "instant":
      return "2026-01-31T09:00:00Z"
    case "currency":
      return "EUR"
    case "integer":
      return 1
    case "boolean":
      return true
    case "list":
      return ["…"]
    default:
      return column.description || "…"
  }
}

const exampleRef = (column: TableColumn) => ({
  role: column.name,
  type: column.targets?.[0] ?? "",
  external_id: `${column.targets?.[0] ?? "record"}-1`,
})

/**
 * A file to fill for a type. CSV is the header row alone, with a byte-order mark so Excel reads it as UTF-8; JSON is
 * an envelope of one example record that names every field and role.
 */
export const recordTemplate = (
  type: string,
  format: "csv" | "json",
  { source, separator = "," }: { source?: Partial<EnvelopeSource>; separator?: string } = {},
): string => {
  const columns = recordColumns(type)
  if (columns.length === 0) throw new TableError([unknownType(type)])
  if (format === "csv") return `${BOM}${columns.map((c) => csvCell(c.name, separator)).join(separator)}\r\n`
  const fields: Record<string, unknown> = {}
  for (const c of columns.filter((c) => c.kind === "field")) fields[c.name] = example(c)
  for (const c of columns.filter((c) => c.kind === "item")) {
    const [list = "", key = ""] = c.name.split(".")
    fields[list] ??= [{}]
    const [first] = fields[list] as Record<string, unknown>[]
    if (first) first[key] = example(c)
  }
  const envelope: RecordsEnvelope = {
    schema_version: RECORDS_SCHEMA_VERSION,
    source: {
      // An import-only type is refused under a sheet's provider: `import` is the one any folder or export may use.
      provider: source?.provider ?? (specOf(type)?.importOnly ? "import" : "sheet"),
      account: source?.account ?? "main",
      batch_id: source?.batch_id ?? "first-import",
    },
    records: [
      {
        key: `${type}-1`,
        type,
        external_id: `${type}-1`,
        operation: "upsert",
        fields,
        relations: columns.filter((c) => c.kind === "role").map(exampleRef),
      },
    ],
  }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

/** RFC 4180 rows; a separator inside quotes, a doubled quote and a line break inside quotes are part of the cell. */
export const csvRows = (text: string, separator: string): { cells: string[]; line: number }[] => {
  const rows: { cells: string[]; line: number }[] = []
  let cells: string[] = []
  let cell = ""
  let quoted = false
  let line = 1
  let start = 1
  const end = () => {
    cells.push(cell)
    cell = ""
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else {
        if (c === "\n") line++
        cell += c
      }
    } else if (c === '"' && cell === "") quoted = true
    else if (c === separator) end()
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      end()
      rows.push({ cells, line: start })
      cells = []
      line++
      start = line
    } else cell += c
  }
  if (cell !== "" || cells.length > 0) {
    end()
    rows.push({ cells, line: start })
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""))
}

/** The header's separator: Excel saves `;` where the decimal mark is a comma, as in Russian or Spanish. */
export const csvSeparator = (header: string): string => {
  const count = (s: string) => header.split(s).length - 1
  return [";", "\t", ","].reduce((best, s) => (count(s) > count(best) ? s : best), ",")
}

const DAY_DOTTED = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/

/** What a spreadsheet writes, as the envelope reads it; anything it cannot read is left for the envelope to refuse. */
const normalized = (column: TableColumn, raw: string): unknown => {
  const value = raw.trim()
  switch (column.shape) {
    case "decimal": {
      const plain = value.replace(/[\s  ]/g, "")
      return /^\d+,\d+$/.test(plain) ? plain.replace(",", ".") : plain
    }
    case "day": {
      const dotted = DAY_DOTTED.exec(value)
      return dotted ? `${dotted[3]}-${dotted[2]?.padStart(2, "0")}-${dotted[1]?.padStart(2, "0")}` : value
    }
    case "currency":
      return value.toUpperCase()
    case "integer":
      return /^-?\d+$/.test(value) ? Number(value) : value
    case "boolean":
      return /^(true|yes|1|да|sí|si)$/i.test(value) ? true : /^(false|no|0|нет)$/i.test(value) ? false : value
    case "list":
      return value
        .split(LIST_SEPARATOR)
        .map((v) => v.trim())
        .filter(Boolean)
    default:
      return column.many
        ? value
            .split(LIST_SEPARATOR)
            .map((v) => v.trim())
            .filter(Boolean)
        : value
  }
}

const unknownType = (type: string): IngestError => ({
  pointer: "",
  code: "record.type",
  message: `no table for ${type}: use one of ${TABLE_RECORD_TYPES.join(", ")}`,
})

const relationsOf = (column: TableColumn, raw: string): RecordRelation[] | IngestError => {
  const targets = column.targets ?? []
  const values = column.many ? raw.split(LIST_SEPARATOR) : [raw]
  const out: RecordRelation[] = []
  for (const value of values.map((v) => v.trim()).filter(Boolean)) {
    const at = value.indexOf(":")
    const named = at > 0 ? value.slice(0, at) : ""
    if (targets.length === 1 && !targets.includes(named)) {
      out.push({ role: column.name, type: targets[0] as string, external_id: value })
      continue
    }
    if (!targets.includes(named) || at === value.length - 1)
      return {
        pointer: "",
        code: "record.invalid",
        message: `${column.name} takes <type>:<external id>, the type one of ${targets.join(", ")}: not ${value}`,
      }
    out.push({ role: column.name, type: named, external_id: value.slice(at + 1) })
  }
  return out
}

/**
 * Reads a sheet of one type as an envelope. A row whose `external_id` an earlier row had continues that record: its
 * item columns (`lines.amount`) add one item to the list, as an invoice exported a line a row does.
 */
export const envelopeOfCsv = (
  text: string,
  { type, source, options }: { type: string; source: EnvelopeSource; options?: EnvelopeOptions },
): TableEnvelope => {
  const columns = recordColumns(type)
  if (columns.length === 0) throw new TableError([unknownType(type)])
  const body = text.startsWith(BOM) ? text.slice(1) : text
  const separator = csvSeparator(body.slice(0, body.search(/\r?\n|$/)))
  const [head, ...rows] = csvRows(body, separator)
  if (!head) throw new TableError([{ pointer: "", code: "envelope.invalid", message: "the file has no header row" }])
  const byName = new Map(columns.map((c) => [c.name, c]))
  const header = head.cells.map((name) => name.trim())
  const unknown = header.filter((name) => name !== "" && !byName.has(name))
  if (unknown.length > 0)
    throw new TableError([
      {
        pointer: "",
        code: "envelope.invalid",
        message: `columns ${type} has no field for: ${unknown.join(", ")}. Download the ${type} template for the list`,
        place: { line: 1, column: unknown[0] },
      },
    ])
  if (!header.includes("external_id"))
    throw new TableError([
      { pointer: "", code: "envelope.invalid", message: "the header has no external_id column", place: { line: 1 } },
    ])

  const records: EnvelopeRecord[] = []
  const indexById = new Map<string, number>()
  const places = new Map<string, TablePlace>()
  const errors: (IngestError & { place?: TablePlace })[] = []

  for (const row of rows) {
    const cell = (name: string) => row.cells[header.indexOf(name)] ?? ""
    const id = cell("external_id").trim()
    if (!id) {
      errors.push({
        pointer: "",
        code: "record.invalid",
        message: "a row has no external_id",
        place: { line: row.line, column: "external_id" },
      })
      continue
    }
    const known = indexById.get(id)
    const index = known ?? records.length
    const record: EnvelopeRecord = records[index] ?? {
      key: `${type}:${id}`,
      type,
      external_id: id,
      operation: "upsert",
      fields: {},
      relations: [],
    }
    if (known === undefined) {
      records.push(record)
      indexById.set(id, index)
      places.set(pointerOf("records", index), { line: row.line })
    }
    const fields = record.fields as Record<string, unknown>
    const item: Record<string, unknown> = {}
    let list = ""
    header.forEach((name, i) => {
      const column = byName.get(name)
      const raw = row.cells[i] ?? ""
      if (!column || column.kind === "id" || raw.trim() === "") return
      const at = { line: row.line, column: name }
      if (column.kind === "field") {
        fields[name] = normalized(column, raw)
        places.set(pointerOf("records", index, "fields", name), at)
      } else if (column.kind === "role") {
        const relations = relationsOf(column, raw)
        if (!Array.isArray(relations)) {
          errors.push({ ...relations, pointer: pointerOf("records", index, "relations"), key: record.key, place: at })
          return
        }
        record.relations = [...(record.relations ?? []).filter((r) => r.role !== name), ...relations]
        places.set(pointerOf("records", index, "relations"), at)
      } else {
        const [of = "", key = ""] = name.split(".")
        list = of
        item[key] = normalized(column, raw)
      }
    })
    if (list) {
      fields[list] ??= []
      const items = fields[list] as Record<string, unknown>[]
      places.set(pointerOf("records", index, "fields", list, items.length), { line: row.line })
      items.push(item)
    }
  }
  if (errors.length > 0) throw new TableError(errors)

  const envelope: RecordsEnvelope = {
    schema_version: RECORDS_SCHEMA_VERSION,
    source,
    ...(options ? { options } : {}),
    records,
  }
  return {
    envelope,
    placeOf(pointer) {
      const item = /^\/records\/\d+\/fields\/([^/]+)\/\d+\/([^/]+)/.exec(pointer)
      for (let at = pointer; at !== ""; at = at.slice(0, at.lastIndexOf("/"))) {
        const place = places.get(at)
        if (place) return item && !place.column ? { ...place, column: `${item[1]}.${item[2]}` } : place
      }
      return undefined
    },
  }
}
