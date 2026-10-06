import Table from "cli-table3"
import pc from "picocolors"
import { visibleControls } from "./sanitize.js"

export interface PrettyOptions {
  color: boolean
}

/**
 * Three shapes and a fallback, not a renderer per endpoint. A list of like objects becomes a
 * table, a single object becomes labelled lines, everything else is printed as JSON — which is
 * honest about the fact that we do not know what it is.
 */
export const renderPretty = (value: unknown, options: PrettyOptions): string => {
  const paint = palette(options.color)

  if (Array.isArray(value)) {
    if (value.length === 0) return paint.dim("(nothing)")
    return isRowLike(value) ? renderTable(value as Row[], paint) : renderJson(value)
  }

  if (isPlainObject(value)) {
    const listKey = Object.keys(value).find((key) => Array.isArray(value[key]) && isRowLike(value[key] as unknown[]))
    if (listKey) {
      const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== listKey))
      const table = renderTable(value[listKey] as Row[], paint)
      return Object.keys(rest).length > 0 ? `${table}\n\n${renderFields(rest, paint)}` : table
    }
    return renderFields(value, paint)
  }

  return renderJson(value)
}

/** Shifts every line right; an empty line stays empty, so no trailing spaces reach the terminal. */
export const indent = (text: string, spaces: number): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(spaces)}${line}`))
    .join("\n")

type Row = Record<string, unknown>

const palette = (color: boolean) => ({
  dim: (text: string) => (color ? pc.dim(text) : text),
  bold: (text: string) => (color ? pc.bold(text) : text),
  label: (text: string) => (color ? pc.cyan(text) : text),
})

const isPlainObject = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isRowLike = (value: unknown[]): boolean =>
  value.length > 0 && value.every((item) => isPlainObject(item)) && value.length <= 500

const renderTable = (rows: Row[], paint: ReturnType<typeof palette>): string => {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const table = new Table({
    head: columns.map((column) => paint.bold(visibleControls(column))),
    // `chars: {}` is not enough — cli-table3 falls back to its own defaults for anything unset.
    style: { head: [], border: [], "padding-left": 0, "padding-right": 2 },
    chars: BORDERLESS,
  })

  for (const row of rows) table.push(columns.map((column) => cell(row[column])))
  return table.toString()
}

const renderFields = (fields: Row, paint: ReturnType<typeof palette>): string => {
  const rows = Object.entries(fields).map(([key, value]) => ({ label: visibleControls(key), value }))
  const width = Math.max(...rows.map((row) => row.label.length))
  return rows.map((row) => `${paint.label(row.label.padEnd(width))}  ${cell(row.value)}`).join("\n")
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  // Sanitised before the table measures it, so an escaped sequence widens the column it is in
  // rather than silently overflowing it.
  if (typeof value === "object") return visibleControls(JSON.stringify(value))
  return visibleControls(String(value))
}

const renderJson = (value: unknown): string => JSON.stringify(value, null, 2)

const BORDERLESS = {
  top: "",
  "top-mid": "",
  "top-left": "",
  "top-right": "",
  bottom: "",
  "bottom-mid": "",
  "bottom-left": "",
  "bottom-right": "",
  left: "",
  "left-mid": "",
  mid: "",
  "mid-mid": "",
  right: "",
  "right-mid": "",
  middle: "",
}
