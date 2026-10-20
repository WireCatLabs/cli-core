import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase, SqlValue } from "../../driver.js"

export class SnapshotBudget {
  records = 0
  bytes = 0

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024)
      throw new CliError("validation_error", "snapshot maxReadBytes takes 1–4194304 bytes")
  }

  reserve(records: number, bytes: number) {
    if (
      !Number.isSafeInteger(records) ||
      records < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.records + records > 1000 ||
      this.bytes + bytes > this.maxBytes
    )
      throw new CliError("validation_error", "project annotation snapshot exceeds its record or input byte budget")
    this.records += records
    this.bytes += bytes
  }

  rows(database: CacheDatabase, from: string, fields: string[], parameters: SqlValue[]) {
    const bytes = fields.map((field) => `coalesce(length(CAST(${field} AS BLOB)),0)`).join("+")
    const sized = database.prepare(`SELECT ${bytes} AS bytes ${from} LIMIT 1001`).all(...parameters)
    this.reserve(
      sized.length,
      sized.reduce((sum, row) => sum + Number(row.bytes) + 128, 0),
    )
  }
}
