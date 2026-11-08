import { isRecordType, type RecordType, roleOf, rolesOf } from "../../domain/record-types.js"
import { isSymmetric, type RelationKind, rolesOf as relationRolesOf } from "../../domain/relations.js"
import type { AccountKey } from "../types.js"
import type { StoreContext } from "./open.js"
import { IMPORTER, type Row } from "./record-projection.js"
import { extraRolesOf } from "./relation-roles.js"
import { type ReportedIssue, type ReportedRelation, type ReportedSync, syncReportedIn } from "./reported-relations.js"
import { referenceOfThing, storedThing, type Thing } from "./things.js"

export type RelationshipCounts = Omit<ReportedSync, "issues">

export const noRelationships = (): RelationshipCounts => ({
  added: 0,
  kept: 0,
  restored: 0,
  withdrawn: 0,
  proposed: 0,
  skippedOwnerRejected: 0,
})

export const addCounts = (into: RelationshipCounts, done: RelationshipCounts) => {
  for (const name of Object.keys(into) as (keyof RelationshipCounts)[]) into[name] += done[name]
}

/** Which entities a report covers: the entities of `records`, and those of the records that point at `changed`. */
export interface ReportedRecords {
  records: number[]
  /** Records whose entity came, went or moved: what points at them is reported again. */
  changed?: number[]
  /** Entities no record maps to any more, a remap's old one: what the account reported from them is withdrawn. */
  withdrawn?: Thing[]
}

const kindsOf = (type: RecordType): RelationKind[] => [
  ...new Set(rolesOf(type).flatMap(([, role]) => (role.relationship ? [role.relationship] : []))),
]

const relationshipOf = (type: unknown, role: unknown): RelationKind | undefined =>
  roleOf(String(type), String(role))?.relationship

const POSITION_MAX = 200

/** A person's job title as the source gives it, never read as the role. */
const positionOf = (fields: unknown): string | undefined => {
  const value = (JSON.parse(String(fields)) as Row).position
  const text = typeof value === "string" ? value.trim() : ""
  return text && text.length <= POSITION_MAX ? text : undefined
}

/**
 * The relationships an import's records report, through `relations.syncReported` under the import's account. An
 * entity's set is what every live record of the account mapped to it says, so a second record of the same person, or
 * a delete, never withdraws what another record still reports.
 */
export const recordRelationshipsOver = (context: StoreContext) => {
  const { database } = context
  const sql = (text: string) => database.prepare(text)
  const refOf = (thing: Thing) => referenceOfThing(database, thing) ?? `${thing.type}:${thing.id}`

  const reportable = (type: unknown, id: unknown): Thing | undefined =>
    id != null && isRecordType(String(type)) && kindsOf(String(type) as RecordType).length > 0
      ? storedThing(type, id)
      : undefined

  const entitiesOf = (records: number[]): Thing[] =>
    sql("SELECT entity_type, entity_id FROM records WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(records))
      .flatMap((row) => reportable(row.entity_type, row.entity_id) ?? [])

  const dependentsOf = (changed: number[]): Thing[] =>
    sql(
      "SELECT DISTINCT r.type, r.entity_type, r.entity_id, rr.role FROM record_relations rr " +
        "JOIN records r ON r.id = rr.record_id WHERE rr.target_id IN (SELECT value FROM json_each(?)) " +
        "AND r.entity_id IS NOT NULL AND r.deleted_at IS NULL",
    )
      .all(JSON.stringify(changed))
      .flatMap((row) => (relationshipOf(row.type, row.role) ? (reportable(row.entity_type, row.entity_id) ?? []) : []))

  /**
   * A member's role only from the list, the owner's own roles included: any other word the source used, and the role
   * of a relationship with no list, is kept as `metadata.source_role`. A contract's or a deal's word is its role, so
   * one off the list is an issue the owner settles by adding it.
   */
  const shapeOf = (
    kind: RelationKind,
    from: Thing,
    toType: string,
    as: unknown,
  ): { role: string | null; metadata: Record<string, unknown> } => {
    const word = as == null ? null : String(as)
    if (word === null) return { role: null, metadata: {} }
    const list = relationRolesOf(kind, from.type, toType)
    if (list && kind !== "member-of") return { role: word, metadata: {} }
    const listed = list?.concat(extraRolesOf(database, kind, from.type, toType)).includes(word)
    return listed ? { role: word, metadata: {} } : { role: null, metadata: { source_role: word } }
  }

  const targetOf = (row: Row): { ref: string; type: string } | undefined => {
    if (row.target_type === "ref") {
      const ref = String(row.target_external_id)
      return { ref, type: ref.slice(0, ref.indexOf(":")) }
    }
    if (row.target_entity_id == null) return undefined
    return {
      ref: refOf(storedThing(row.target_entity_type, row.target_entity_id)),
      type: String(row.target_entity_type),
    }
  }

  /** Every relationship the account's live records report from `entity`, and a symmetric one reported to it. */
  const reportedFrom = (
    accountId: number,
    entity: Thing,
    add: (relation: ReportedRelation, record: number) => void,
  ) => {
    const ref = refOf(entity)
    const outgoing = sql(
      "SELECT r.id AS record_id, r.type, r.fields, rr.role, rr.as_role, rr.target_type, rr.target_external_id, " +
        "t.entity_type AS target_entity_type, t.entity_id AS target_entity_id FROM records r " +
        "JOIN record_relations rr ON rr.record_id = r.id LEFT JOIN records t ON t.id = rr.target_id " +
        "AND t.deleted_at IS NULL WHERE r.account_id = ? AND r.entity_type = ? AND r.entity_id = ? " +
        "AND r.deleted_at IS NULL ORDER BY r.id, rr.id",
    ).all(accountId, entity.type, entity.id)
    for (const row of outgoing) {
      const kind = relationshipOf(row.type, row.role)
      const target = kind && targetOf(row)
      if (!kind || !target) continue
      const { role, metadata } = shapeOf(kind, entity, target.type, row.as_role)
      const position = kind === "member-of" && entity.type === "person" ? positionOf(row.fields) : undefined
      if (position) metadata.position = position
      add(
        { from: ref, to: target.ref, kind, role, ...(Object.keys(metadata).length ? { metadata } : {}) },
        Number(row.record_id),
      )
    }
    const symmetric = rolesOf(entity.type as RecordType).flatMap(([name, role]) =>
      role.relationship && isSymmetric(role.relationship) ? [name] : [],
    )
    if (symmetric.length === 0) return
    const incoming = sql(
      "SELECT r.id AS record_id, r.type, r.entity_type, r.entity_id, rr.role, rr.as_role FROM record_relations rr " +
        "JOIN records r ON r.id = rr.record_id LEFT JOIN records t ON t.id = rr.target_id AND t.deleted_at IS NULL " +
        "WHERE r.account_id = ? AND r.deleted_at IS NULL AND r.entity_id IS NOT NULL " +
        "AND rr.role IN (SELECT value FROM json_each(?)) AND ((t.entity_type = ? AND t.entity_id = ?) " +
        "OR (rr.target_type = 'ref' AND rr.target_external_id = ?)) ORDER BY r.id, rr.id",
    ).all(accountId, JSON.stringify(symmetric), entity.type, entity.id, ref)
    for (const row of incoming) {
      const kind = relationshipOf(row.type, row.role)
      if (!kind) continue
      const other = storedThing(row.entity_type, row.entity_id)
      const { role, metadata } = shapeOf(kind, other, entity.type, row.as_role)
      add(
        { from: refOf(other), to: ref, kind, role, ...(Object.keys(metadata).length ? { metadata } : {}) },
        Number(row.record_id),
      )
    }
  }

  /**
   * Reports every relationship of the covered entities, one `syncReported` call per entity type so that a type's kinds
   * never withdraw what another type's entity holds. Inside the caller's transaction: a dry run rolls it back.
   */
  const report = (
    key: AccountKey,
    accountId: number,
    { records, changed = [], withdrawn = [] }: ReportedRecords,
    onIssue: (issue: ReportedIssue, record: number | null) => void,
  ): RelationshipCounts => {
    const counts = noRelationships()
    const byType = new Map<RecordType, Map<string, Thing>>()
    for (const thing of [...entitiesOf(records), ...dependentsOf(changed), ...withdrawn]) {
      if (!reportable(thing.type, thing.id)) continue
      const type = thing.type as RecordType
      const things = byType.get(type) ?? new Map<string, Thing>()
      things.set(`${thing.type}:${thing.id}`, thing)
      byType.set(type, things)
    }
    for (const [type, things] of byType) {
      const relationships = new Map<string, ReportedRelation>()
      const recordOf = new Map<string, number>()
      for (const entity of things.values())
        reportedFrom(accountId, entity, (relation, record) => {
          const ends = isSymmetric(relation.kind) ? [relation.from, relation.to].sort() : [relation.from, relation.to]
          const same = [relation.kind, ...ends, relation.role ?? ""].join("\0")
          if (!relationships.has(same)) relationships.set(same, relation)
          const pair = [relation.kind, relation.from, relation.to].join("\0")
          if (!recordOf.has(pair)) recordOf.set(pair, record)
        })
      const done = syncReportedIn(
        context,
        key,
        [...relationships.values()],
        { from: [...things.values()].map(refOf), kinds: kindsOf(type) },
        { by: IMPORTER },
      )
      const { issues, ...tally } = done
      addCounts(counts, tally)
      for (const issue of issues) onIssue(issue, recordOf.get([issue.kind, issue.from, issue.to].join("\0")) ?? null)
    }
    return counts
  }

  return { report }
}
