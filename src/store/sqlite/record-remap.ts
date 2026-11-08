import { isRecordType, RECORD_TYPES, roleOf } from "../../domain/record-types.js"
import { pointerPairs } from "./entity-types.js"
import type { StoreContext } from "./open.js"
import type { Row } from "./record-projection.js"

interface Thing {
  type: string
  id: number
}

/** The owner's remap of a record whose entity the import made: what this account's records filled from it follows. */
export const recordRemapOver = ({ database, now }: StoreContext) => {
  /** Whether any row points at the entity: a pointer pair, a foreign key or a record; its own identities do not count. */
  const pointedAt = (type: string, id: number): boolean => {
    for (const { table, pointer } of pointerPairs(database))
      if (
        database.prepare(`SELECT 1 FROM ${table} WHERE ${pointer}_type = ? AND ${pointer}_id = ? LIMIT 1`).get(type, id)
      )
        return true
    if (!isRecordType(type)) return false
    const target = RECORD_TYPES[type].table
    const OWN = new Set(["identity_links", "identity_link_events", "organization_identities"])
    for (const { name } of database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]) {
      if (OWN.has(name)) continue
      for (const key of database
        .prepare(`SELECT "from" AS column FROM pragma_foreign_key_list(?) WHERE "table" = ?`)
        .all(name, target))
        if (database.prepare(`SELECT 1 FROM "${name}" WHERE "${String(key.column)}" = ? LIMIT 1`).get(id)) return true
    }
    return false
  }

  /** Repoints the entity columns and a deal's people that `record`'s dependents in its account filled from it. */
  const repointDependents = (record: Row, from: Thing, to: Thing, at: number) => {
    const dependents = database
      .prepare(
        "SELECT rr.role, r.type, r.entity_type, r.entity_id FROM record_relations rr JOIN records r ON r.id = rr.record_id " +
          "WHERE rr.target_id = ? AND r.account_id = ? AND r.entity_id IS NOT NULL",
      )
      .all(Number(record.id), Number(record.account_id))
    for (const row of dependents) {
      const role = roleOf(String(row.type), String(row.role))
      const type = String(row.entity_type)
      if (role === undefined || !isRecordType(type)) continue
      const { table } = RECORD_TYPES[type]
      const entityId = Number(row.entity_id)
      if (role.column !== undefined && !role.pair)
        database
          .prepare(`UPDATE ${table} SET ${role.column} = ?, updated_at = ? WHERE id = ? AND ${role.column} = ?`)
          .run(to.id, at, entityId, from.id)
      else if (role.column !== undefined)
        database
          .prepare(
            `UPDATE ${table} SET ${role.column}_type = ?, ${role.column}_id = ?, updated_at = ? WHERE id = ? ` +
              `AND ${role.column}_type = ? AND ${role.column}_id = ?`,
          )
          .run(to.type, to.id, at, entityId, from.type, from.id)
      if (role.relationship && !role.kept)
        database
          .prepare(
            "UPDATE OR IGNORE links SET to_id = ?, updated_at = ? WHERE from_type = ? AND from_id = ? " +
              "AND to_type = ? AND to_id = ? AND source = 'crm'",
          )
          .run(to.id, at, type, entityId, from.type, from.id)
    }
  }

  /**
   * Moves `record` from the entity the import made to `to`, with every record of the account linked to that entity by
   * the same identifiers, what their dependents filled from them, and the identities the import gave it.
   */
  const remap = (record: Row, from: Thing, to: Thing) => {
    const at = now()
    const moved = database
      .prepare("SELECT * FROM records WHERE account_id = ? AND entity_type = ? AND entity_id = ?")
      .all(Number(record.account_id), from.type, from.id)
    for (const row of moved) {
      repointDependents(row, from, to, at)
      database
        .prepare(
          "UPDATE records SET entity_type = ?, entity_id = ?, created_entity = 0, projected_fingerprint = fingerprint " +
            "WHERE id = ?",
        )
        .run(to.type, to.id, Number(row.id))
    }
    if (from.type === "person")
      for (const link of database
        .prepare("SELECT identity_id FROM identity_links WHERE person_id = ? AND method = 'import'")
        .all(from.id)) {
        database
          .prepare("UPDATE identity_links SET person_id = ?, updated_at = ? WHERE identity_id = ?")
          .run(to.id, at, Number(link.identity_id))
        database
          .prepare(
            "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
              "VALUES (?, ?, ?, 'owner', ?, 'owner')",
          )
          .run(Number(link.identity_id), from.id, to.id, at)
      }
    if (from.type === "organization")
      database
        .prepare(
          "UPDATE OR IGNORE organization_identities SET organization_id = ?, updated_at = ? " +
            "WHERE organization_id = ? AND method = 'import'",
        )
        .run(to.id, at, from.id)
  }

  return { pointedAt, remap }
}
