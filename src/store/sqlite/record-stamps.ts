import { createHash } from "node:crypto"
import { nestedOf, RECORD_TYPES, type RecordType } from "../../domain/record-types.js"
import type { StoreContext } from "./open.js"
import type { Row } from "./record-projection.js"

const VOLATILE = new Set(["id", "created_at", "updated_at", "metadata"])

const content = (row: Row | undefined) =>
  row === undefined ? null : Object.fromEntries(Object.entries(row).filter(([column]) => !VOLATILE.has(column)))

/**
 * What the import last wrote of a proposal it may re-propose: a digest of the row and its parts, kept in the row's
 * metadata. An owner may edit a proposal (its lines, its splits) without deciding it, and his edit is never
 * overwritten: the import changes the proposal only while the digest still matches.
 */
export const importStampsOver = ({ database }: StoreContext) => {
  const stateOf = (type: RecordType, id: number): string => {
    const { table } = RECORD_TYPES[type]
    const parts = nestedOf(type).map(([, nested]) =>
      database
        .prepare(`SELECT * FROM ${nested.table} WHERE ${nested.parent} = ? ORDER BY id`)
        .all(id)
        .map((row) => content(row)),
    )
    const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
    return createHash("sha256")
      .update(JSON.stringify([content(row), parts]))
      .digest("hex")
  }

  const stamp = (type: RecordType, id: number) =>
    database
      .prepare(
        `UPDATE ${RECORD_TYPES[type].table} SET metadata = json_set(coalesce(metadata, '{}'), '$.imported', ?) ` +
          "WHERE id = ?",
      )
      .run(stateOf(type, id), id)

  const untouched = (type: RecordType, id: number): boolean =>
    database
      .prepare(`SELECT json_extract(metadata, '$.imported') AS stamp FROM ${RECORD_TYPES[type].table} WHERE id = ?`)
      .get(id)?.stamp === stateOf(type, id)

  return { stamp, untouched }
}
