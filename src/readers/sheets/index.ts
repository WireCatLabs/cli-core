import { basename } from "node:path"
import { delimitedSpans } from "../../attachments/csv-spans.js"
import { sheetText } from "../../attachments/sheets.js"
import { extensionOf } from "../engine.js"
import { isPlain, readPlain } from "../plain/index.js"
import type { FileHint, Reader } from "../types.js"

const DELIMITED: Record<string, string> = {
  ".csv": ",",
  ".tsv": "\t",
  "text/csv": ",",
  "text/tab-separated-values": "\t",
}
const MAX_DELIMITED_CELLS = 200_000
const unquoted = (field: string) => {
  const trimmed = field.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : field
}

const delimiterOf = (hint: FileHint) =>
  DELIMITED[extensionOf(hint)] ?? DELIMITED[hint.mime?.split(";")[0]?.trim() ?? ""]

export const sheets: Reader = {
  id: "sheets",
  version: "v1",
  accepts: (hint) => Boolean(isPlain(hint)) && delimiterOf(hint) !== undefined,
  read: async (bytes, hint) => {
    const result = readPlain(bytes)
    const delimiter = delimiterOf(hint)
    if (result.status !== "extracted" || !delimiter) return result
    const extractor = `sheet:v1:${delimiter === "," ? "csv" : "tsv"}`
    try {
      const spans = delimitedSpans(result.text, delimiter, MAX_DELIMITED_CELLS)
      const cells = spans.cells.map(({ row, column, start, end }) => ({
        row,
        column,
        value: unquoted(result.text.slice(start, end)),
      }))
      const name = basename(hint.name ?? hint.path, extensionOf(hint)) || "Sheet"
      const { text, truncated } = sheetText([{ name, cells }])
      return text === ""
        ? { status: "needs-agent", extractor }
        : { status: "extracted", text, extractor, ...(truncated || spans.truncated ? { truncated: true } : {}) }
    } catch {
      return { status: "unreadable", extractor, error: "malformed_delimited_text" }
    }
  },
}
