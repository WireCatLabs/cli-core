import type { Streams } from "@wirecat/cli-base"

/** A number a spreadsheet reads as a number; it cannot be a formula, so a leading minus stays. */
const NUMBER = /^-?\d+(\.\d+)?$/
/** What a spreadsheet reads as the start of a formula (OWASP's CSV injection list). */
const FORMULA = /^[=+\-@\t\r]/

/**
 * One cell as RFC 4180 writes it, safe to open in a spreadsheet: text that would start a formula gets a leading `'`,
 * since every cell may be what someone else typed into the CRM.
 */
export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  const text = String(value)
  const safe = FORMULA.test(text) && !NUMBER.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** A header and its rows as RFC 4180 records, without line ends; the header is guarded like any cell. */
export const csvRecords = (header: readonly string[], rows: readonly (readonly unknown[])[]): string[] =>
  [header, ...rows].map((row) => row.map(csvCell).join(","))

/** The table on stdout and nothing else, every record ending in CRLF. */
export const writeCsv = (
  streams: Pick<Streams, "data">,
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
): void => {
  // `data` adds the "\n" itself, so the last record's CRLF needs only its "\r".
  streams.data(`${csvRecords(header, rows).join("\r\n")}\r`)
}
