import { isRecordType, type RecordRoleSpec, type RecordType, roleOf } from "../../domain/record-types.js"
import type { RecordRelation } from "../../domain/records.js"
import type { CacheDatabase } from "../driver.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { refusal, type Share } from "./record-projection.js"
import { referenceOfThing, storedThing } from "./things.js"

/** Prepared once per store: a run writes thousands of records through the same few statements. */
export const statementsOf = (database: CacheDatabase) => {
  const statements = new Map<string, ReturnType<CacheDatabase["prepare"]>>()
  return (text: string) => {
    let statement = statements.get(text)
    if (!statement) {
      statement = database.prepare(text)
      statements.set(text, statement)
    }
    return statement
  }
}

/** A reference a record's fields make (`fields.pipeline`, `fields.lines.product`): no role a source sends has a dot. */
export const isDerived = (role: string) => role.startsWith("fields.")

/** A record's relations in `record_relations`: as sent, a typed ref with the target type ref, and those its fields make. */
export const recordRelationsOver = ({ database }: StoreContext, sql: ReturnType<typeof statementsOf>) => {
  const entityRef = (type: unknown, id: unknown): string | null =>
    type == null ? null : (referenceOfThing(database, storedThing(type, id)) ?? `${String(type)}:${String(id)}`)

  const refOfThing = (ref: string): string => {
    const thing = requiredThing(database, ref)
    return entityRef(thing.type, thing.id) as string
  }

  /** A pipeline CRM sync wrote for this account has no record, yet a deal of the account stands in it. */
  const syncedPipeline = (recordId: number, row: Record<string, unknown>) =>
    row.target_type === "pipeline" &&
    sql(
      "SELECT 1 FROM pipelines p JOIN records r ON r.account_id = p.account_id WHERE r.id = ? AND p.external_id = ? " +
        "AND p.deleted_at IS NULL",
    ).get(recordId, String(row.target_external_id)) !== undefined

  /** What a projection needs from a record's relations: entities by role, the roles still without one, the shares. */
  const relatedOf = (recordId: number, type: RecordType) => {
    const rows = sql(
      "SELECT rr.role, rr.amount, rr.as_role, rr.target_type, rr.target_external_id, t.entity_type, t.entity_id " +
        "FROM record_relations rr LEFT JOIN records t ON t.id = rr.target_id AND t.deleted_at IS NULL " +
        "WHERE rr.record_id = ? ORDER BY rr.id",
    ).all(recordId)
    const related = new Map<string, string[]>()
    const as = new Map<string, (string | null)[]>()
    const products = new Map<string, string>()
    const shares: Share[] = []
    const missing = new Set<string>()
    for (const row of rows) {
      const role = String(row.role)
      if (isDerived(role)) {
        const ref = entityRef(row.entity_type, row.entity_id)
        if (ref === null) {
          if (!syncedPipeline(recordId, row)) missing.add(role)
        } else if (role.endsWith(".product")) products.set(String(row.target_external_id), ref)
        continue
      }
      const spec: RecordRoleSpec | undefined = roleOf(type, role)
      if (spec === undefined || spec.kept) continue
      const ref =
        row.target_type === "ref"
          ? refOfThing(String(row.target_external_id))
          : entityRef(row.entity_type, row.entity_id)
      if (ref === null) {
        missing.add(role)
        continue
      }
      related.set(role, [...(related.get(role) ?? []), ref])
      as.set(role, [...(as.get(role) ?? []), row.as_role == null ? null : String(row.as_role)])
      if (role === "settles") shares.push({ invoice: ref, amount: row.amount == null ? null : String(row.amount) })
    }
    for (const [role, refs] of related)
      if (refs.length > 1 && !roleOf(type, role)?.many) refusal(`a record has one ${role}`, "record.relation-ambiguous")
    return { related, as, shares, products, missing: [...missing] }
  }

  /** The relations as sent, without the references taken from fields: what a fingerprint was made of. */
  const storedRelations = (recordId: number): RecordRelation[] =>
    sql("SELECT role, target_type, target_external_id, as_role, amount FROM record_relations WHERE record_id = ?")
      .all(recordId)
      .filter((row) => !isDerived(String(row.role)))
      .map((row) => ({
        role: String(row.role),
        ...(row.target_type === "ref"
          ? { ref: String(row.target_external_id) }
          : { type: String(row.target_type), external_id: String(row.target_external_id) }),
        ...(row.as_role == null ? {} : { as: String(row.as_role) }),
        ...(row.amount == null ? {} : { amount: String(row.amount) }),
      }))

  const relate = (
    recordId: number,
    accountId: number,
    relations: (RecordRelation | { role: string; type: string; external_id: string })[],
    at: number,
  ) => {
    sql("DELETE FROM record_relations WHERE record_id = ?").run(recordId)
    for (const relation of relations) {
      const { ref, as, amount } = relation as RecordRelation
      const type = ref === undefined ? String(relation.type) : "ref"
      const external = ref ?? String(relation.external_id)
      sql(
        "INSERT OR IGNORE INTO record_relations (record_id, role, target_type, target_external_id, target_id, " +
          "created_at, amount, as_role) VALUES (?, ?, ?, ?, (SELECT id FROM records WHERE account_id = ? AND type = ? " +
          "AND external_id = ?), ?, ?, ?)",
      ).run(recordId, relation.role, type, external, accountId, type, external, at, amount ?? null, as ?? null)
    }
  }

  const missingOf = (id: number): string[] | null => {
    const row = sql("SELECT type, entity_id, deleted_at FROM records WHERE id = ?").get(id)
    if (!row || row.entity_id != null || row.deleted_at != null || !isRecordType(String(row.type))) return null
    const { missing } = relatedOf(id, row.type as RecordType)
    return missing.length > 0 ? missing : null
  }

  return { entityRef, relatedOf, storedRelations, relate, missingOf }
}
