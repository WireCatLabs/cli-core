import {
  DECIDED_TABLES,
  isRecordType,
  RECORD_TYPES,
  type RecordType,
  type RecordTypeSpec,
  roleOf,
  rolesOf,
} from "../../domain/record-types.js"
import { type IngestError, pointerOf } from "../../domain/records.js"
import { isSymmetric, type RelationKind, rolesOf as relationRolesOf, roleListOf } from "../../domain/relations.js"
import type { CacheStatement } from "../driver.js"
import type { AccountKey } from "../types.js"
import type { StoreContext } from "./open.js"
import { IMPORTER, type Row } from "./record-projection.js"
import { extraRolesOf } from "./relation-roles.js"
import { type ReportedOutcome, type ReportedRelation, type ReportedSync, syncReportedIn } from "./reported-relations.js"
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

/**
 * Something a report says about one record's relationship: an `issue` (the store did not take it) or a `notice` (it
 * took it, but not as the source put it: a word off the role list). `key` is the same for the same thing twice.
 */
export interface RelationshipNote {
  severity: "issue" | "notice"
  code: string
  message: string
  record: number | null
  key: string
}

/** Which entities a report covers: the entities of `records`, those of the records that point at `changed`, and these. */
export interface ReportedRecords {
  records: number[]
  /** Records whose entity came, went or moved: what points at them is reported again. */
  changed?: number[]
  /** Entities no record of the account may map to any more, a remap's old one: what it reported from them withdraws. */
  entities?: Thing[]
}

export interface ReportHooks {
  onNote?: (note: RelationshipNote) => void
  onOutcome?: (key: string, outcome: ReportedOutcome) => void
}

/** Where a note points: the record's place in this run, or the record itself when it came in an earlier batch. */
export interface NotePlace {
  index?: number
  key?: string
  type: string
  externalId: string
}

/** One note as a receipt entry, for a run and for the owner's `map` and `match` alike. */
export const noteError = (note: RelationshipNote, place: NotePlace | undefined): IngestError => {
  if (place?.index !== undefined)
    return {
      pointer: pointerOf("records", place.index, "relations"),
      code: note.code,
      message: note.message,
      ...(place.key === undefined ? {} : { key: place.key }),
    }
  return {
    pointer: "",
    code: note.code,
    message: place ? `${place.type} ${place.externalId}: ${note.message}` : note.message,
    ...(place ? { record: { type: place.type, externalId: place.externalId } } : {}),
  }
}

const kindsOf = (type: RecordType): RelationKind[] => [
  ...new Set(rolesOf(type).flatMap(([, role]) => (role.relationship ? [role.relationship] : []))),
]

const symmetricRolesOf = (type: RecordType): string[] =>
  rolesOf(type).flatMap(([name, role]) => (role.relationship && isSymmetric(role.relationship) ? [name] : []))

const relationshipOf = (type: unknown, role: unknown): RelationKind | undefined =>
  roleOf(String(type), String(role))?.relationship

const POSITION_MAX = 200

/** A person's job title as the source gives it, never read as the role. */
const positionOf = (fields: unknown): string | undefined => {
  const value = (JSON.parse(String(fields)) as Row).position
  const text = typeof value === "string" ? value.trim() : ""
  return text && text.length <= POSITION_MAX ? text : undefined
}

const sourceRolesOf = (relation: ReportedRelation): string[] =>
  (relation.metadata?.source_role as string[] | undefined) ?? []

/** Two records saying the same relationship: every word either used is kept, the first one's position wins. */
const merged = (held: ReportedRelation, more: ReportedRelation): ReportedRelation => {
  const words = [...new Set([...sourceRolesOf(held), ...sourceRolesOf(more)])]
  if (words.length === sourceRolesOf(held).length) return held
  return { ...held, metadata: { ...held.metadata, source_role: words } }
}

/**
 * The relationships an import's records report, through `relations.syncReported` under the import's account. An
 * entity's set is what every live record of the account mapped to it says, so a second record of the same person, or
 * a delete, never withdraws what another record still reports. An entity the owner rejected, or that is deleted,
 * reports none.
 */
export const recordRelationshipsOver = (context: StoreContext) => {
  const { database } = context
  const statements = new Map<string, CacheStatement>()
  const sql = (text: string): CacheStatement => {
    let statement = statements.get(text)
    if (!statement) {
      statement = database.prepare(text)
      statements.set(text, statement)
    }
    return statement
  }
  const refOf = (thing: Thing) => referenceOfThing(database, thing) ?? `${thing.type}:${thing.id}`

  const reportable = (type: unknown, id: unknown): Thing | undefined =>
    id != null && isRecordType(String(type)) && kindsOf(String(type) as RecordType).length > 0
      ? storedThing(type, id)
      : undefined

  /** The owner rejected the entity, or it is gone: whatever its records say, it reports nothing. */
  const silent = (entity: Thing): boolean => {
    const spec = RECORD_TYPES[entity.type as RecordType] as RecordTypeSpec
    const reviewed = Object.hasOwn(DECIDED_TABLES, entity.type)
    if (!reviewed && !spec.tombstone) return false
    const row = sql(
      `SELECT ${reviewed ? "review" : "NULL"} AS review, ${spec.tombstone ? "deleted_at" : "NULL"} AS deleted_at ` +
        `FROM ${spec.table} WHERE id = ?`,
    ).get(entity.id)
    return !row || row.review === "rejected" || row.deleted_at != null
  }

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
   * A role only from its list, the owner's own roles included. Any other word, and any word on a relationship with no
   * list, is kept as `metadata.source_role` on a link without a role; a word a list does not hold is also a notice.
   */
  const shapeOf = (kind: RelationKind, from: Thing, toType: string, as: unknown, note: (word: string) => void) => {
    const word = as == null ? null : String(as)
    if (word === null) return { role: null, metadata: {} as Record<string, unknown> }
    const list = relationRolesOf(kind, from.type, toType)
    if (list?.concat(extraRolesOf(database, kind, from.type, toType)).includes(word))
      return { role: word, metadata: {} as Record<string, unknown> }
    if (list) note(word)
    return { role: null, metadata: { source_role: [word] } as Record<string, unknown> }
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
    onNote: (note: RelationshipNote) => void,
  ) => {
    if (silent(entity)) return
    const ref = refOf(entity)
    const unlisted = (kind: RelationKind, from: Thing, toType: string, to: string, record: number) => (word: string) =>
      onNote({
        severity: "notice",
        code: "relationship.role-unlisted",
        message:
          `${word} is not one of the ${roleListOf(kind, from.type, toType)} roles: the ${kind} link has no role ` +
          "and keeps the word as source_role",
        record,
        key: ["notice", record, kind, to, word].join("\0"),
      })
    // The most recently changed record first: its position is the one a person's link carries.
    const outgoing = sql(
      "SELECT r.id AS record_id, r.type, r.fields, rr.role, rr.as_role, rr.target_type, rr.target_external_id, " +
        "t.entity_type AS target_entity_type, t.entity_id AS target_entity_id FROM records r " +
        "JOIN record_relations rr ON rr.record_id = r.id LEFT JOIN records t ON t.id = rr.target_id " +
        "AND t.deleted_at IS NULL WHERE r.account_id = ? AND r.entity_type = ? AND r.entity_id = ? " +
        "AND r.deleted_at IS NULL ORDER BY r.updated_at DESC, r.id DESC, rr.id",
    ).all(accountId, entity.type, entity.id)
    for (const row of outgoing) {
      const kind = relationshipOf(row.type, row.role)
      const target = kind && targetOf(row)
      if (!kind || !target) continue
      const record = Number(row.record_id)
      const { role, metadata } = shapeOf(
        kind,
        entity,
        target.type,
        row.as_role,
        unlisted(kind, entity, target.type, target.ref, record),
      )
      const position = kind === "member-of" && entity.type === "person" ? positionOf(row.fields) : undefined
      if (position) metadata.position = position
      add({ from: ref, to: target.ref, kind, role, ...(Object.keys(metadata).length ? { metadata } : {}) }, record)
    }
    const symmetric = symmetricRolesOf(entity.type as RecordType)
    if (symmetric.length === 0) return
    // Two branches, not an OR, so each one reads an index of record_relations instead of every record of the account.
    const incoming = sql(
      "SELECT r.id AS record_id, r.type, r.entity_type, r.entity_id, rr.role, rr.as_role, rr.id AS relation_id " +
        "FROM records t JOIN record_relations rr ON rr.target_id = t.id JOIN records r ON r.id = rr.record_id " +
        "WHERE t.entity_type = ? AND t.entity_id = ? AND t.deleted_at IS NULL AND r.account_id = ? " +
        "AND r.deleted_at IS NULL AND r.entity_id IS NOT NULL AND rr.role IN (SELECT value FROM json_each(?)) " +
        "UNION ALL SELECT r.id, r.type, r.entity_type, r.entity_id, rr.role, rr.as_role, rr.id FROM record_relations rr " +
        "JOIN records r ON r.id = rr.record_id WHERE rr.target_type = 'ref' AND rr.target_external_id = ? " +
        "AND r.account_id = ? AND r.deleted_at IS NULL AND r.entity_id IS NOT NULL " +
        "AND rr.role IN (SELECT value FROM json_each(?)) ORDER BY 1, 7",
    ).all(entity.type, entity.id, accountId, JSON.stringify(symmetric), ref, accountId, JSON.stringify(symmetric))
    for (const row of incoming) {
      const kind = relationshipOf(row.type, row.role)
      if (!kind) continue
      const other = storedThing(row.entity_type, row.entity_id)
      if (silent(other)) continue
      const record = Number(row.record_id)
      const { role, metadata } = shapeOf(
        kind,
        other,
        entity.type,
        row.as_role,
        unlisted(kind, other, entity.type, ref, record),
      )
      add({ from: refOf(other), to: ref, kind, role, ...(Object.keys(metadata).length ? { metadata } : {}) }, record)
    }
  }

  /**
   * Reports every relationship of the covered entities, one `syncReported` call per entity type so that a type's kinds
   * never withdraw what another type's entity holds. Inside the caller's transaction: a dry run rolls it back.
   */
  const report = (
    key: AccountKey,
    accountId: number,
    { records, changed = [], entities = [] }: ReportedRecords,
    { onNote = () => {}, onOutcome }: ReportHooks = {},
  ): RelationshipCounts => {
    const counts = noRelationships()
    const byType = new Map<RecordType, Map<string, Thing>>()
    for (const thing of [...entitiesOf(records), ...dependentsOf(changed), ...entities]) {
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
        reportedFrom(
          accountId,
          entity,
          (relation, record) => {
            const ends = isSymmetric(relation.kind) ? [relation.from, relation.to].sort() : [relation.from, relation.to]
            const same = [relation.kind, ...ends, relation.role ?? ""].join("\0")
            const held = relationships.get(same)
            relationships.set(same, held ? merged(held, relation) : relation)
            const pair = [relation.kind, relation.from, relation.to].join("\0")
            if (!recordOf.has(pair)) recordOf.set(pair, record)
          },
          onNote,
        )
      const { issues, ...tally } = syncReportedIn(
        context,
        key,
        [...relationships.values()],
        { from: [...things.values()].map(refOf), kinds: kindsOf(type) },
        { by: IMPORTER, ...(onOutcome ? { onOutcome } : {}) },
      )
      for (const name of Object.keys(counts) as (keyof RelationshipCounts)[]) counts[name] += tally[name]
      for (const issue of issues) {
        const record = recordOf.get([issue.kind, issue.from, issue.to].join("\0")) ?? null
        onNote({
          severity: "issue",
          code: issue.reason,
          message: issue.message,
          record,
          key: ["issue", record, issue.kind, issue.from, issue.to, issue.reason].join("\0"),
        })
      }
    }
    return counts
  }

  /** Where a note's record is, for one that is not in a run. */
  const placeOf = (record: number | null): NotePlace | undefined => {
    if (record === null) return undefined
    const row = sql("SELECT type, external_id FROM records WHERE id = ?").get(record)
    return row ? { type: String(row.type), externalId: String(row.external_id) } : undefined
  }

  /**
   * The owner rejected `entity`: every account whose records stand for it withdraws what it reported from it, at once,
   * in the rejection's transaction.
   */
  const withdrawFrom = (entity: Thing) => {
    if (!reportable(entity.type, entity.id)) return
    const accounts = sql(
      "SELECT DISTINCT a.id, a.provider, a.external_id FROM records r JOIN accounts a ON a.id = r.account_id " +
        "WHERE r.entity_type = ? AND r.entity_id = ?",
    ).all(entity.type, entity.id)
    for (const account of accounts)
      report({ provider: String(account.provider), account: String(account.external_id) }, Number(account.id), {
        records: [],
        entities: [entity],
      })
  }

  return { report, placeOf, withdrawFrom }
}
