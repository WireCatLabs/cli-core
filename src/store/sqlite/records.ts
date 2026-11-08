import { CliError } from "@wirecat/cli-base"
import { IDENTITY_TYPES } from "../../domain/record-types.js"
import type { EnvelopeSource, IngestError } from "../../domain/records.js"
import { findAccountPk } from "./accounts.js"
import type { Author } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { codeOf, type Row, refusal } from "./record-projection.js"
import { isDerived } from "./record-relations.js"
import { recordRemapOver } from "./record-remap.js"
import { type RecordsRun, type RunItem, type RunOptions, recordRunOver } from "./record-run.js"
import { recordWritesOver } from "./record-writes.js"
import { read, rehearse, write } from "./transaction.js"

export type { FlaggedRecord, RecordsRun, RunItem, RunOptions, Unmatched } from "./record-run.js"
export { waitingPointer } from "./record-run.js"

export interface RecordKey {
  provider: string
  account: string
  type: string
  externalId: string
}

export interface SourceRecordRelation {
  role: string
  type: string
  /** `null` when the relation names a store entity by `ref`. */
  externalId: string | null
  ref: string | null
  as: string | null
  amount: string | null
  resolved: boolean
}

export interface SourceRecord extends RecordKey {
  fields: Record<string, unknown>
  revision: number | null
  fingerprint: string
  relations: SourceRecordRelation[]
  /** The entity made from it, matched to it or mapped to it by the owner; `null` while it waits or for `custom:`. */
  entity: string | null
  /** The import made its person, organization or project: no entity had its identifiers. */
  createdEntity: boolean
  /** The source changed or deleted it after its entity was made: the owner should look at the entity. */
  flagged: boolean
  batchId: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface MappedRecord extends SourceRecord {
  /** The entity the import had made for it, when nothing points at it any more: the owner's to delete or merge. */
  unused: string | null
  /** Proposals made for the records that waited on it. */
  proposed: string[]
  /** Records that waited on it whose entity was still refused. */
  errors: IngestError[]
}

export interface IncomingRelation {
  /** The live record whose relation points at the target. */
  record: RecordKey
  role: string
  as: string | null
  amount: string | null
}

export interface MatchRun {
  linked: number
  created: number
  unmatched: { key: RecordKey; reason: string; candidates: string[] }[]
  proposed: string[]
  errors: IngestError[]
  /** A list stopped at 1000 entries; the counts are exact. */
  truncated: boolean
}

export interface RecordStore {
  /**
   * Writes the records of one source, per chunk in one transaction, checking duplicates and collecting the receipt's
   * lists in the store as it goes. A dry run is one transaction, rolled back at the end, and refuses every other
   * read and write of the store handle while it lasts.
   */
  run(
    source: EnvelopeSource,
    items: AsyncIterable<RunItem> | Iterable<RunItem>,
    options?: RunOptions,
  ): Promise<RecordsRun>
  get(key: RecordKey): Promise<SourceRecord | undefined>
  list(filter: {
    provider: string
    account: string
    type?: string
    /** Only records whose entity waits for a reference. */
    waiting?: boolean
    /** Only persons, organizations and projects whose identifiers point at more than one entity. */
    unmatched?: boolean
    flagged?: boolean
    /** A ref such as `person:4`: the records mapped to that entity. */
    entity?: string
    batch?: string
    /** `true`: only deleted records; `false`: only live ones; left out, both. */
    deleted?: boolean
    /** 1–500, 100 by default. */
    limit?: number
  }): Promise<SourceRecord[]>
  /**
   * The relations of live records that point at a record of the account, or at an entity: by its ref, or through a
   * record mapped to it. An entity's are read across every account, and each names its own. Oldest relation first.
   */
  incoming(target: RecordKey | { entity: string }, options?: { limit?: number }): Promise<IncomingRelation[]>
  /**
   * The owner says which entity a record is: `person:4` for a payer a sheet names. Never done by name. Records that
   * waited for it get their entity, as proposals. A record whose entity the import made moves, with every record of
   * the account linked to that entity and whatever their records filled from them.
   */
  map(key: RecordKey, entity: string, by: Author): Promise<MappedRecord>
  /** Matches or makes the entity of every waiting person, organization and project of one account, as an import does. */
  match(account: { provider: string; account: string }): Promise<MatchRun>
}

const LIMIT = 1000

const iso = (value: unknown) => new Date(Number(value)).toISOString()

const checkLimit = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new CliError("validation_error", "a record list takes 1–500 items")
}

const IDENTITY_SQL = IDENTITY_TYPES.map((type) => `'${type}'`).join(", ")

export const recordStoreOver = (context: StoreContext): RecordStore => {
  const { database } = context
  const sql = (text: string) => database.prepare(text)
  const writes = recordWritesOver(context)
  const { entityRef, project, completeDependents } = writes
  const run = recordRunOver(context, writes)
  const { pointedAt, remap } = recordRemapOver(context)

  const sourceRecordOf = (row: Row): SourceRecord => ({
    provider: String(row.provider),
    account: String(row.account),
    type: String(row.type),
    externalId: String(row.external_id),
    fields: JSON.parse(String(row.fields)) as Record<string, unknown>,
    revision: row.revision == null ? null : Number(row.revision),
    fingerprint: String(row.fingerprint),
    relations: sql(
      "SELECT role, target_type, target_external_id, target_id, amount, as_role FROM record_relations " +
        "WHERE record_id = ? ORDER BY id",
    )
      .all(Number(row.id))
      .filter((relation) => !isDerived(String(relation.role)))
      .map((relation) => {
        const byRef = relation.target_type === "ref"
        const target = String(relation.target_external_id)
        return {
          role: String(relation.role),
          type: byRef ? target.slice(0, target.indexOf(":")) : String(relation.target_type),
          externalId: byRef ? null : target,
          ref: byRef ? target : null,
          as: relation.as_role == null ? null : String(relation.as_role),
          amount: relation.amount == null ? null : String(relation.amount),
          resolved: byRef || relation.target_id != null,
        }
      }),
    entity: entityRef(row.entity_type, row.entity_id),
    createdEntity: Number(row.created_entity) === 1,
    flagged: row.entity_id != null && (row.deleted_at != null || row.projected_fingerprint !== row.fingerprint),
    batchId: String(row.batch_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at == null ? null : iso(row.deleted_at),
  })

  const SELECT =
    "SELECT r.*, a.provider, a.external_id AS account FROM records r JOIN accounts a ON a.id = r.account_id "

  const rowOf = (key: RecordKey) =>
    sql(`${SELECT}WHERE a.provider = ? AND a.external_id = ? AND r.type = ? AND r.external_id = ?`).get(
      key.provider,
      key.account,
      key.type,
      key.externalId,
    )

  /** Keeps the first `LIMIT` entries of a list, and says when it dropped one. */
  const capped = <T>(flag: () => void) => {
    const list: T[] = []
    const push = (item: T) => {
      if (list.length < LIMIT) list.push(item)
      else flag()
    }
    return { list, push }
  }

  return {
    run: async (source, items, options = {}) =>
      options.dryRun
        ? rehearse({ database, client: (context.orm as unknown as { $client?: unknown }).$client }, () =>
            run(source, items, options),
          )
        : run(source, items, options),
    get: async (key) =>
      read(database, () => {
        const row = rowOf(key)
        return row ? sourceRecordOf(row) : undefined
      }),
    list: async ({ provider, account, type, waiting, unmatched, flagged, entity, batch, deleted, limit = 100 }) => {
      checkLimit(limit)
      return read(database, () => {
        const accountId = findAccountPk(context, { provider, account })
        if (accountId === undefined) return []
        const where = ["r.account_id = ?"]
        const params: (string | number)[] = [accountId]
        const and = (condition: string, ...values: (string | number)[]) => {
          where.push(condition)
          for (const value of values) params.push(value)
        }
        if (type !== undefined) and("r.type = ?", type)
        if (waiting)
          and(
            "r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type NOT LIKE 'custom:%' " +
              `AND r.type NOT IN (${IDENTITY_SQL})`,
          )
        if (unmatched) and(`r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type IN (${IDENTITY_SQL})`)
        if (flagged)
          and("r.entity_id IS NOT NULL AND (r.deleted_at IS NOT NULL OR r.projected_fingerprint IS NOT r.fingerprint)")
        if (entity !== undefined) {
          const thing = requiredThing(database, entity, "the entity")
          and("r.entity_type = ? AND r.entity_id = ?", thing.type, thing.id)
        }
        if (batch !== undefined) and("r.batch_id = ?", batch)
        if (deleted !== undefined) and(`r.deleted_at IS ${deleted ? "NOT " : ""}NULL`)
        return database
          .prepare(`${SELECT}WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`)
          .all(...params, limit)
          .map(sourceRecordOf)
      })
    },
    incoming: async (target, { limit = 100 } = {}) => {
      checkLimit(limit)
      return read(database, () => {
        let pointing: { sql: string; params: (string | number)[] }
        if ("externalId" in target) {
          const row = rowOf(target)
          if (!row) return []
          pointing = { sql: "SELECT id FROM record_relations WHERE target_id = ?", params: [Number(row.id)] }
        } else {
          const thing = requiredThing(database, target.entity, "the entity")
          pointing = {
            sql:
              "SELECT id FROM record_relations WHERE target_type = 'ref' AND target_external_id = ? UNION " +
              "SELECT rr.id FROM record_relations rr JOIN records t ON t.id = rr.target_id " +
              "WHERE t.entity_type = ? AND t.entity_id = ?",
            params: [`${thing.type}:${thing.id}`, thing.type, thing.id],
          }
        }
        return database
          .prepare(
            "SELECT rr.role, rr.as_role, rr.amount, r.type, r.external_id, a.provider, a.external_id AS account " +
              "FROM record_relations rr JOIN records r ON r.id = rr.record_id JOIN accounts a ON a.id = r.account_id " +
              `WHERE rr.id IN (${pointing.sql}) AND r.deleted_at IS NULL AND rr.role NOT LIKE 'fields.%' ` +
              "ORDER BY rr.id LIMIT ?",
          )
          .all(...pointing.params, limit)
          .map((row) => ({
            record: {
              provider: String(row.provider),
              account: String(row.account),
              type: String(row.type),
              externalId: String(row.external_id),
            },
            role: String(row.role),
            as: row.as_role == null ? null : String(row.as_role),
            amount: row.amount == null ? null : String(row.amount),
          }))
      })
    },
    map: async (key, entity, by) => {
      if (by !== "owner")
        throw new CliError("permission_error", "only the owner says which entity a record is", {
          reason: "record.map-owner-only",
        })
      let unused: string | null = null
      const proposed = new Set<string>()
      const errors: IngestError[] = []
      write(database, () => {
        const row = rowOf(key)
        if (!row || row.deleted_at != null)
          throw new CliError("not_found", `no ${key.type} ${key.externalId} from ${key.provider} ${key.account}`)
        const thing = requiredThing(database, entity, "the entity")
        if (thing.type !== key.type)
          refusal(`a ${key.type} record maps to a ${key.type}:, not ${entity}`, "record.map-type")
        const same = row.entity_type === thing.type && Number(row.entity_id) === thing.id
        const from =
          row.entity_id != null && !same ? { type: String(row.entity_type), id: Number(row.entity_id) } : null
        if (from !== null) {
          if (Number(row.created_entity) !== 1)
            refusal(
              `${key.type} ${key.externalId} is already ${entityRef(row.entity_type, row.entity_id)}`,
              "record.mapped",
            )
          remap(row, from, thing)
          if (!pointedAt(from.type, from.id)) unused = entityRef(from.type, from.id)
        } else
          sql(
            "UPDATE records SET entity_type = ?, entity_id = ?, created_entity = 0, " +
              "projected_fingerprint = fingerprint WHERE id = ?",
          ).run(thing.type, thing.id, Number(row.id))
        const source = { provider: key.provider, account: key.account, batch_id: String(row.batch_id) }
        completeDependents(
          Number(row.id),
          source,
          (ref) => proposed.add(ref),
          (error) => errors.push(error),
        )
      })
      return read(database, () => ({
        ...sourceRecordOf(rowOf(key) as Row),
        unused,
        proposed: [...proposed],
        errors,
      }))
    },
    match: async ({ provider, account }) => {
      let truncated = false
      const flag = () => {
        truncated = true
      }
      const unmatched = capped<MatchRun["unmatched"][number]>(flag)
      const errors = capped<IngestError>(flag)
      const proposed = new Set<string>()
      const counts = { linked: 0, created: 0 }
      write(database, () => {
        const accountId = findAccountPk(context, { provider, account })
        if (accountId === undefined) return
        const rows = database
          .prepare(
            "SELECT * FROM records WHERE account_id = ? AND entity_id IS NULL AND deleted_at IS NULL " +
              `AND type IN (${IDENTITY_SQL}) ORDER BY id`,
          )
          .all(accountId)
        for (const row of rows) {
          const source = { provider, account, batch_id: String(row.batch_id) }
          const recordKey = { provider, account, type: String(row.type), externalId: String(row.external_id) }
          try {
            const done = write(database, () => project(row, source))
            if (done.unmatched) unmatched.push({ key: recordKey, ...done.unmatched })
            if (!done.made) continue
            const created = sql("SELECT created_entity FROM records WHERE id = ?").get(Number(row.id))?.created_entity
            counts[Number(created) === 1 ? "created" : "linked"] += 1
            completeDependents(
              Number(row.id),
              source,
              (ref) => {
                if (proposed.size < LIMIT) proposed.add(ref)
                else if (!proposed.has(ref)) flag()
              },
              errors.push,
            )
          } catch (error) {
            if (!(error instanceof CliError)) throw error
            errors.push({
              pointer: "",
              code: codeOf(error),
              message: `${recordKey.type} ${recordKey.externalId}: ${error.message}`,
            })
          }
        }
      })
      return { ...counts, unmatched: unmatched.list, proposed: [...proposed], errors: errors.list, truncated }
    },
  }
}
