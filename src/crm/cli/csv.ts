import { CliError } from "@wirecat/cli-base"
import { annotateOption } from "@wirecat/cli-base/commands"
import { type Command, Option } from "commander"
import { compactOf, environmentOf, inCommandRun, outputFor } from "../../cli/context.js"
import { writeCsv } from "../../cli/csv.js"
import { fieldsOf } from "../../cli/result-fields.js"
import type { CrmField } from "../../domain/crm.js"

/**
 * `--format csv`: `--format` is the vocabulary's output choice, so no CLI's command lint needs a new word. Off MCP: a
 * table carries no `untrusted` marker for an agent.
 */
export const csvFormatOption = () =>
  annotateOption(
    new Option(
      "--format <format>",
      "csv: this page as a table for a spreadsheet; --json=a,b picks its columns",
    ).choices(["csv"]),
    { mcp: false },
  )

/** A CRM's own field as the table needs it: `fields list`'s code, label and type. */
export type CsvField = Pick<CrmField, "code" | "label" | "type">

/** What a page of CRM rows gives the table: its rows as `--json` answers them, and the CRM's own fields. */
export interface CsvPage {
  items: readonly Record<string, unknown>[]
  fields: readonly CsvField[]
  page: number
  hasMore: boolean
}

interface Column {
  header: string
  cell: (item: Record<string, unknown>) => unknown
}

/** A deal's or a lead's columns when `--json=a,b` names none. */
export const DEAL_CSV_COLUMNS: readonly string[] = [
  "ref",
  "title",
  "status",
  "pipeline",
  "pipeline_name",
  "stage",
  "amount",
  "currency",
  "organization",
  "contact_name",
  "company_name",
  "people",
  "close_date",
  "closed_date",
  "closed_reason",
  "assignee",
  "external_id",
  "created_at",
  "updated_at",
  "provider_metadata",
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const at = (item: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), item)

/**
 * One cell's text: a phone or an e-mail by its value, a party by its name, a list joined, so no cell holds JSON a
 * spreadsheet cannot read.
 */
const flat = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(flat).join("; ")
  if (isRecord(value)) return value.value ?? value.name ?? value.ref ?? JSON.stringify(value)
  return value
}

const MONEY = /^(-?\d+(?:\.\d+)?)\|([A-Za-z]{3})$/

/** A CRM's own field: headed by its label as `fields list` shows it; money as an amount and a currency column. */
const customColumns = (field: CsvField, header: string): Column[] => {
  const value = (item: Record<string, unknown>) => at(item, ["provider_metadata", field.code, "value"])
  if (field.type !== "money") return [{ header, cell: (item) => flat(value(item)) }]
  const part = (index: 1 | 2) => (item: Record<string, unknown>) => {
    const raw = value(item)
    const money = typeof raw === "string" ? MONEY.exec(raw) : null
    return money ? money[index] : index === 1 ? flat(raw) : null
  }
  return [
    { header: `${header} amount`, cell: part(1) },
    { header: `${header} currency`, cell: part(2) },
  ]
}

/** Every custom field the CRM lists, then any a row holds that the list does not, each header told apart by code. */
const customFieldsOf = (page: CsvPage): CsvField[] => {
  const listed = new Set(page.fields.map((field) => field.code))
  const extra = new Map<string, CsvField>()
  for (const item of page.items) {
    const metadata = item.provider_metadata
    if (!isRecord(metadata)) continue
    for (const [code, value] of Object.entries(metadata))
      if (!listed.has(code) && !extra.has(code)) {
        const label = isRecord(value) && typeof value.label === "string" ? value.label : null
        extra.set(code, { code, label, type: "string" })
      }
  }
  return [...page.fields, ...extra.values()]
}

const columnsOf = (page: CsvPage, paths: readonly string[]): Column[] => {
  const custom = customFieldsOf(page)
  const taken = new Set(paths.filter((path) => !path.startsWith("provider_metadata")))
  const labels = new Map<string, number>()
  for (const field of custom) labels.set(field.label ?? field.code, (labels.get(field.label ?? field.code) ?? 0) + 1)
  const headerOf = (field: CsvField) => {
    const label = field.label ?? field.code
    return (labels.get(label) ?? 0) > 1 || taken.has(label) ? `${label} (${field.code})` : label
  }
  return paths.flatMap((path) => {
    const parts = path.split(".")
    if (parts[0] !== "provider_metadata") return [{ header: path, cell: (item) => flat(at(item, parts)) }]
    const chosen = parts[1] === undefined ? custom : custom.filter((field) => field.code === parts[1])
    return chosen.flatMap((field) => customColumns(field, headerOf(field)))
  })
}

/**
 * `--json=a,b` beside `--format csv` names its columns, `items.` or not, as `--json` would keep them; without it, the
 * caller's own. `provider_metadata` among them stands for every custom field.
 */
export const csvColumnPaths = (command: Command, defaults: readonly string[] = DEAL_CSV_COLUMNS): string[] => {
  const fields = command.optsWithGlobals<{ fields?: string }>().fields
  if (fields === undefined) return [...defaults]
  return fieldsOf(fields).map((path) => (path.startsWith("items.") ? path.slice("items.".length) : path))
}

const refuse = (message: string) => {
  throw new CliError("validation_error", message, { reason: "output.conflict", param: "--format" })
}

/**
 * A table is for a person's spreadsheet: JSON, JSON lines, compact rows and an agent's run each ask for another.
 * Called before the CRM is read.
 */
export const refuseCsvConflict = (command: Command): void => {
  const globals = command.optsWithGlobals<{ json?: boolean; jsonl?: boolean; fields?: string }>()
  if (environmentOf(command).agent) refuse("--format csv is a table for a spreadsheet; an agent reads the JSON answer")
  if (globals.jsonl) refuse("--format csv and --jsonl ask for different output — pick one")
  if (compactOf(command)) refuse("--format csv and --compact ask for different output — pick one")
  if (globals.json && globals.fields === undefined)
    refuse("--format csv and --json ask for different output — --json=a,b picks the table's columns")
}

/** stdout carries the table and nothing else; the way to the next page goes to stderr. */
export const printCsv = (command: Command, page: CsvPage, paths: readonly string[]): void => {
  const columns = columnsOf(page, paths)
  const { streams, renderer } = outputFor(command)
  writeCsv(
    streams,
    columns.map((column) => column.header),
    page.items.map((item) => columns.map((column) => column.cell(item))),
  )
  if (page.hasMore) renderer.note(`→ more rows: run it again with --page ${page.page + 1}`)
}

/** Reads a page in the profile's run and closes it before the table is printed. */
export const renderCsv = <R extends { close?: () => Promise<void> }>(
  command: Command,
  open: (command: Command, access: { readOnly: boolean }) => Promise<R>,
  read: (run: R) => Promise<CsvPage>,
): Promise<void> => {
  refuseCsvConflict(command)
  return inCommandRun(command, async () => {
    const run = await open(command, { readOnly: true })
    let page: CsvPage
    try {
      page = await read(run)
    } finally {
      await run.close?.()
    }
    printCsv(command, page, csvColumnPaths(command))
  })
}
