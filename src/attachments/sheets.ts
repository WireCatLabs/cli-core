import { MAX_TEXT_CHARS } from "./limits.js"

export interface SheetCell {
  /** From 1, as the spreadsheet numbers it. */
  row: number
  /** From 1: A is 1. */
  column: number
  /** As displayed; empty means no value. */
  value: string
}

export interface Sheet {
  name: string
  cells: readonly SheetCell[]
}

export const columnName = (column: number): string => {
  let name = ""
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26))
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  return name
}

const NUMBER_LIKE = /^[-+]?[\d\s.,]+%?$|^\d{4}-\d{2}-\d{2}/

/**
 * The first non-empty row names the columns when every value in it is text, no two alike, and rows
 * follow it; otherwise columns go by their letters.
 */
const headerOf = (rows: [number, Map<number, string>][]): Map<number, string> | undefined => {
  const [first, ...rest] = rows
  if (!first || rest.length === 0) return undefined
  const values = [...first[1].values()]
  if (values.some((value) => NUMBER_LIKE.test(value)) || new Set(values).size !== values.length) return undefined
  return first[1]
}

const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").trim()

/**
 * Sheets as text a search snippet can stand on: each row repeats its column names, so a row found on
 * its own still says what its values are.
 *
 * ```
 * # Budget
 * Row 2: Item: Rent; Amount: 1200
 * ```
 *
 * Empty cells are left out. Stops at `maxChars`, at a row boundary, and says so with `truncated`.
 */
export const sheetText = (
  sheets: readonly Sheet[],
  maxChars: number = MAX_TEXT_CHARS,
): { text: string; truncated: boolean } => {
  const parts: string[] = []
  let length = 0
  const add = (line: string) => {
    if (length + line.length > maxChars) return false
    parts.push(line)
    length += line.length
    return true
  }
  for (const sheet of sheets) {
    const byRow = new Map<number, Map<number, string>>()
    for (const { row, column, value } of sheet.cells) {
      const shown = oneLine(value)
      if (shown === "") continue
      const cells = byRow.get(row) ?? new Map<number, string>()
      cells.set(column, shown)
      byRow.set(row, cells)
    }
    const rows = [...byRow.entries()]
      .sort(([a], [b]) => a - b)
      .map(
        ([row, cells]) =>
          [row, new Map([...cells.entries()].sort(([a], [b]) => a - b))] as [number, Map<number, string>],
      )
    if (rows.length === 0) continue
    const header = headerOf(rows)
    if (!add(`${parts.length ? "\n" : ""}# ${oneLine(sheet.name)}\n`))
      return { text: parts.join("").trim(), truncated: true }
    for (const [row, cells] of header ? rows.slice(1) : rows) {
      const fields = [...cells.entries()].map(
        ([column, value]) => `${header?.get(column) ?? columnName(column)}: ${value}`,
      )
      if (!add(`Row ${row}: ${fields.join("; ")}\n`)) return { text: parts.join("").trim(), truncated: true }
    }
  }
  return { text: parts.join("").trim(), truncated: false }
}
