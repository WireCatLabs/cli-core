import { CliError } from "@wirecat/cli-base"
import {
  DECIDED_TABLES,
  type IdentityType,
  isIdentityType,
  isRecordType,
  RECORD_TYPES,
  type RecordType,
  type RecordTypeSpec,
} from "../../domain/record-types.js"
import {
  type EnvelopeOptions,
  type EnvelopeRecord,
  type EnvelopeSource,
  fieldReferences,
  type IngestError,
  pointerOf,
  type RecordRelation,
  recordFingerprint,
} from "../../domain/records.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { contractOperationsOver } from "./business-contracts.js"
import { crmRowsOver } from "./crm.js"
import { financeOperationsOver } from "./finance.js"
import type { Author } from "./memories.js"
import { transactionOperationsOver } from "./money-transactions.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { orderOperationsOver } from "./orders.js"
import { productOperationsOver } from "./products.js"
import {
  addIdentifiers,
  createEntity,
  type Identifiers,
  identifiersOf,
  matchOf,
  renameMade,
} from "./record-matching.js"
import {
  type Projection,
  type ProjectionTools,
  type RecordProjector,
  type Row,
  refusal,
  stringField,
} from "./record-projection.js"
import { RECORD_PROJECTORS } from "./record-projectors.js"
import { isDerived, recordRelationsOver, statementsOf } from "./record-relations.js"
import { recordRemapOver } from "./record-remap.js"
import { recordSettlingOver } from "./record-settling.js"
import { subscriptionOperationsOver } from "./subscriptions.js"
import { read, rehearse, write } from "./transaction.js"
import { walletOperationsOver } from "./wallets.js"

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
}

/** One line of a run: its place in the envelope or stream, the record, and why it was refused before the store. */
export interface RunItem {
  index: number
  record: EnvelopeRecord
  errors?: IngestError[]
}

export interface RunOptions {
  dryRun?: boolean
  /** Records per transaction, 1000 by default. */
  chunk?: number
  options?: EnvelopeOptions
  /** How many entries each list keeps, 1000 by default; counts stay exact. */
  limit?: number
  /** Every refusal as it happens, the ones past `limit` too. */
  onIssue?: (error: IngestError) => void
}

export interface Unmatched {
  index: number
  key: string
  reason: string
  /** The entities its identifiers point at: the owner says which one it is with `records link`. */
  candidates: string[]
}

export interface RecordsRun {
  created: number
  updated: number
  unchanged: number
  deleted: number
  refused: number
  errors: IngestError[]
  /** Proposals this run made or changed, also for records of earlier imports it completed. */
  proposed: string[]
  /** Kept, with no entity yet: the roles whose target is not imported or has no entity. */
  waiting: { index: number; key: string; missing: string[] }[]
  /** A person, organization or project whose identifiers point at more than one entity. */
  unmatched: Unmatched[]
  /** Changed or deleted at the source after its entity was made. */
  flagged: { index: number; key: string; entity: string }[]
  /** A list stopped at `limit`. */
  truncated: boolean
}

export interface MatchRun {
  linked: number
  created: number
  unmatched: { key: RecordKey; reason: string; candidates: string[] }[]
  proposed: string[]
  errors: IngestError[]
}

export interface RecordStore {
  /**
   * Writes the records of one source, per chunk in one transaction, checking duplicates and collecting the receipt's
   * lists in the store as it goes, so a stream of any length holds one chunk in memory. A dry run is one
   * transaction, rolled back at the end.
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
    /** 1–500, 100 by default. */
    limit?: number
  }): Promise<SourceRecord[]>
  /**
   * The owner says which entity a record is: `person:4` for a payer a sheet names. Never done by name. Records that
   * waited for it get their entity, as proposals. A record whose entity the import made is repointed, with whatever
   * this account's records filled from it.
   */
  map(key: RecordKey, entity: string, by: Author): Promise<MappedRecord>
  /** Matches or makes the entity of every waiting person, organization and project of one account, as an import does. */
  match(account: { provider: string; account: string }): Promise<MatchRun>
}

const PROJECTORS = RECORD_PROJECTORS

/** v1's single roles a record may also name in `fields.<role>`: a v1 invoice whose `fields.payer` is not text is refused. */
const FIELD_REFERENCE_ROLES = ["issuer", "counterparty", "project", "payer", "payee"]

const codeOf = (error: CliError): string => {
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  if (typeof reason === "string") return reason
  return error.code === "not_found" ? "record.reference-not-found" : "record.entity"
}

/** A record's fingerprint without its settles relations: what an import may not change on a payment it proposed. */
const unsettled = (fields: Row, relations: RecordRelation[]) =>
  recordFingerprint(
    fields,
    relations.filter((relation) => relation.role !== "settles"),
  )

const iso = (value: unknown) => new Date(Number(value)).toISOString()

const specOf = (type: RecordType) => RECORD_TYPES[type] as RecordTypeSpec

let runs = 0

export const recordStoreOver = (context: StoreContext): RecordStore => {
  const { database, now } = context
  const sql = statementsOf(database)
  const finance = financeOperationsOver(context)
  const { entityRef, relatedOf, storedRelations, relate, missingOf } = recordRelationsOver(context, sql)
  const { settle, resettle, checkShares } = recordSettlingOver(
    context,
    finance,
    (id) => relatedOf(id, "payment").shares,
  )
  const { pointedAt, repoint } = recordRemapOver(context)
  let tools: ProjectionTools | undefined
  const toolsOf = (): ProjectionTools => {
    tools ??= {
      context,
      finance,
      orders: orderOperationsOver(context),
      contracts: contractOperationsOver(context),
      subscriptions: subscriptionOperationsOver(context),
      transactions: transactionOperationsOver(context),
      products: productOperationsOver(context),
      wallets: walletOperationsOver(context),
      crm: crmRowsOver(context),
      settle,
    }
    return tools
  }

  const projectionOf = (row: Row, source: EnvelopeSource, related: ReturnType<typeof relatedOf>): Projection => ({
    externalId: String(row.external_id),
    accountId: Number(row.account_id),
    source,
    fields: JSON.parse(String(row.fields)) as Row,
    related: related.related,
    as: related.as,
    shares: related.shares,
    products: related.products,
  })

  const isProposed = (type: RecordType, id: number) => {
    const table = (DECIDED_TABLES as Record<string, string>)[type]
    return table !== undefined && sql(`SELECT review FROM ${table} WHERE id = ?`).get(id)?.review === "proposed"
  }

  const setEntity = (recordId: number, ref: string, created: boolean) => {
    const entity = requiredThing(database, ref)
    sql(
      "UPDATE records SET entity_type = ?, entity_id = ?, created_entity = ?, projected_fingerprint = fingerprint " +
        "WHERE id = ?",
    ).run(entity.type, entity.id, created ? 1 : 0, recordId)
    return entity
  }

  interface Projected {
    /** The entity it now has. */
    made?: string
    /** Made as a proposal. */
    proposed?: string
    missing: string[]
    unmatched?: { reason: string; candidates: string[] }
  }

  /** A person, organization or project: linked by a strong identifier, or made when none matches. */
  const identify = (row: Row, type: IdentityType, source: EnvelopeSource): Projected => {
    const fields = JSON.parse(String(row.fields)) as Row
    const ids = identifiersOf(database, type, fields, source, String(row.external_id))
    const match = matchOf(database, type, ids)
    if (match.outcome === "ambiguous")
      return {
        missing: [],
        unmatched: { reason: match.reason, candidates: match.ids.map((id) => entityRef(type, id) as string) },
      }
    if (match.outcome === "one") {
      const ref = entityRef(type, match.id) as string
      setEntity(Number(row.id), ref, false)
      return { made: ref, missing: [] }
    }
    const related = relatedOf(Number(row.id), type)
    if (related.missing.length > 0) return { missing: related.missing }
    const organization = related.related.get("organization")?.[0]
    const id = createEntity(
      context,
      type,
      fields,
      ids,
      { organization: organization === undefined ? null : requiredThing(database, organization).id },
      source,
      String(row.external_id),
    )
    const ref = entityRef(type, id) as string
    setEntity(Number(row.id), ref, true)
    return { made: ref, missing: [] }
  }

  /** Gives a record its entity once every reference it names has one: a proposal, a direct row, or a match. */
  const project = (row: Row, source: EnvelopeSource): Projected => {
    const type = row.type as RecordType
    if (isIdentityType(type)) return identify(row, type, source)
    const projector = PROJECTORS[type] as RecordProjector
    const related = relatedOf(Number(row.id), type)
    if (related.missing.length > 0) return { missing: related.missing }
    const projection = projectionOf(row, source, related)
    if (type === "invoice" || type === "payment")
      for (const name of FIELD_REFERENCE_ROLES) stringField(projection.fields, name)
    const ref = projector.create(projection, toolsOf())
    const entity = setEntity(Number(row.id), ref, false)
    return { made: ref, missing: [], ...(isProposed(type, entity.id) ? { proposed: ref } : {}) }
  }

  /** Records that waited on `target` and may now have their entity, and theirs in turn. */
  const completeDependents = (
    target: number,
    source: EnvelopeSource,
    proposed: (ref: string) => void,
    laterError: (error: IngestError) => void,
  ) => {
    const queue = [target]
    while (queue.length > 0) {
      const rows = sql(
        "SELECT DISTINCT r.* FROM record_relations rr JOIN records r ON r.id = rr.record_id WHERE rr.target_id = ? " +
          "AND r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type NOT LIKE 'custom:%'",
      ).all(queue.shift() as number)
      for (const row of rows) {
        try {
          const done = write(database, () => project(row, source))
          if (done.proposed) proposed(done.proposed)
          if (done.made) queue.push(Number(row.id))
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          laterError({
            pointer: "",
            code: codeOf(error),
            message: `${String(row.type)} ${String(row.external_id)} waits: ${error.message}`,
          })
        }
      }
    }
  }

  /** Whether a deleted record's entity still counts: a rejected proposal does not. */
  const liveEntity = (stored: Row): boolean => {
    if (stored.entity_id == null) return false
    const table = (DECIDED_TABLES as Record<string, string>)[String(stored.entity_type)]
    return (
      table === undefined ||
      sql(`SELECT review FROM ${table} WHERE id = ?`).get(Number(stored.entity_id))?.review !== "rejected"
    )
  }

  interface Written {
    status: "created" | "updated" | "unchanged" | "deleted"
    id: number
    flagged?: boolean
    complete?: boolean
    unmatched?: { reason: string; candidates: string[] }
  }

  /** Takes a changed record into the entity it already has, as its type's registry entry says. */
  const updateEntity = (stored: Row, id: number, source: EnvelopeSource, proposed: (ref: string) => void): boolean => {
    const type = stored.type as RecordType
    const ref = entityRef(stored.entity_type, stored.entity_id) as string
    const row = sql("SELECT * FROM records WHERE id = ?").get(id) as Row
    const fields = JSON.parse(String(row.fields)) as Row
    if (isIdentityType(type)) {
      if (Number(stored.created_entity) !== 1) return false
      const before = (JSON.parse(String(stored.fields)) as Row).name
      renameMade(context, type, Number(stored.entity_id), fields.name, before)
      const ids: Identifiers = identifiersOf(database, type, fields, source, String(row.external_id))
      addIdentifiers(
        context,
        type,
        Number(stored.entity_id),
        ids,
        typeof fields.name === "string" ? fields.name : null,
        source,
      )
      return true
    }
    const projector = PROJECTORS[type]
    if (!projector?.update || specOf(type).update === "flag") return false
    const related = relatedOf(id, type)
    if (related.missing.length > 0) return false
    if (!projector.update(ref, projectionOf(row, source, related), toolsOf())) return false
    if (isProposed(type, Number(stored.entity_id))) proposed(ref)
    return true
  }

  const writeOne = (
    accountId: number,
    source: EnvelopeSource,
    record: EnvelopeRecord,
    options: EnvelopeOptions,
    proposed: (ref: string) => void,
  ): Written => {
    const stored = sql("SELECT * FROM records WHERE account_id = ? AND type = ? AND external_id = ?").get(
      accountId,
      record.type,
      record.external_id,
    )
    const relations = record.relations ?? []
    const fingerprint = record.operation === "upsert" ? recordFingerprint(record.fields ?? {}, relations) : null
    const stale = (why: string) => refusal(why, "record.stale-revision", "revision")
    if (stored && stored.revision != null) {
      const held = Number(stored.revision)
      if (record.revision === undefined) stale(`the store holds revision ${held}: send the record's revision`)
      else if (record.revision < held) stale(`revision ${record.revision} is older than the stored ${held}`)
      else if (record.revision === held && fingerprint !== null && fingerprint !== stored.fingerprint)
        stale(`revision ${held} is stored with other content: a change needs a higher revision`)
    }
    const time = now()
    const revision = record.revision ?? (stored?.revision == null ? null : Number(stored.revision))
    if (record.operation === "delete") {
      if (!stored)
        return refusal(`no ${record.type} ${record.external_id} to delete`, "record.not-found", "external_id")
      if (stored.deleted_at != null) return { status: "unchanged", id: Number(stored.id) }
      sql("UPDATE records SET deleted_at = ?, updated_at = ?, revision = ?, batch_id = ? WHERE id = ?").run(
        time,
        time,
        revision,
        source.batch_id,
        Number(stored.id),
      )
      return { status: "deleted", id: Number(stored.id), flagged: liveEntity(stored) }
    }
    const fields = JSON.stringify(record.fields)
    const typed = isRecordType(record.type)
    if (stored && stored.fingerprint === fingerprint && stored.deleted_at == null) {
      // A person, organization or project an earlier version left waiting for the owner is matched or made now.
      if (stored.entity_id == null && isIdentityType(record.type)) {
        const done = project(stored, source)
        return {
          status: "unchanged",
          id: Number(stored.id),
          complete: done.made !== undefined,
          unmatched: done.unmatched,
        }
      }
      return { status: "unchanged", id: Number(stored.id) }
    }
    checkShares(record)
    // Whether the payment the record stands for differs in more than whom it settles, against the stored version.
    const beyondSettles =
      stored?.entity_id != null &&
      (stored.projected_fingerprint !== stored.fingerprint ||
        unsettled(JSON.parse(String(stored.fields)) as Row, storedRelations(Number(stored.id))) !==
          unsettled(record.fields ?? {}, relations))
    const id = stored
      ? Number(stored.id)
      : Number(
          sql(
            "INSERT INTO records (account_id, type, external_id, fields, revision, fingerprint, batch_id, created_at, " +
              "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          ).get(accountId, record.type, record.external_id, fields, revision, fingerprint, source.batch_id, time, time)
            ?.id,
        )
    if (stored)
      sql(
        "UPDATE records SET fields = ?, revision = ?, fingerprint = ?, batch_id = ?, updated_at = ?, deleted_at = NULL " +
          "WHERE id = ?",
      ).run(fields, revision, fingerprint, source.batch_id, time, id)
    else
      sql(
        "UPDATE record_relations SET target_id = ? WHERE target_id IS NULL AND target_type = ? AND target_external_id = ? " +
          "AND record_id IN (SELECT id FROM records WHERE account_id = ?)",
      ).run(id, record.type, record.external_id, accountId)
    relate(id, accountId, [...relations, ...fieldReferences(record, options)], time)
    let made = false
    let unmatched: Written["unmatched"]
    let flagged = stored?.entity_id != null && stored.projected_fingerprint !== fingerprint
    if (typed && stored?.entity_id == null) {
      const done = project({ ...(sql("SELECT * FROM records WHERE id = ?").get(id) as Row) }, source)
      if (done.proposed) proposed(done.proposed)
      made = done.made !== undefined
      unmatched = done.unmatched
    } else if (record.type === "payment" && stored?.entity_type === "payment" && stored.deleted_at == null) {
      const ref = `payment:${Number(stored.entity_id)}`
      if (resettle(id, ref)) {
        proposed(ref)
        if (!beyondSettles) {
          sql("UPDATE records SET projected_fingerprint = fingerprint WHERE id = ?").run(id)
          flagged = false
        }
      }
    } else if (typed && stored?.entity_id != null && stored.deleted_at == null && flagged) {
      if (updateEntity(stored, id, source, proposed)) {
        sql("UPDATE records SET projected_fingerprint = fingerprint WHERE id = ?").run(id)
        flagged = false
      }
    }
    return {
      status: stored ? "updated" : "created",
      id,
      flagged,
      unmatched,
      // Records waiting on this one move only when it has an entity: made now, or back from a delete.
      complete: made || (stored?.deleted_at != null && stored.entity_id != null),
    }
  }

  /** The receipt's lists, as far as `limit`: counts are kept exactly beside them. */
  const capped = <T>(limit: number, flag: () => void) => {
    const list: T[] = []
    return {
      list,
      push: (item: T) => {
        if (list.length < limit) list.push(item)
        else flag()
      },
    }
  }

  const runOver = async (
    source: EnvelopeSource,
    items: AsyncIterable<RunItem> | Iterable<RunItem>,
    { chunk = 1000, options = {}, limit = 1000, onIssue }: RunOptions,
  ): Promise<RecordsRun> => {
    runs += 1
    const table = `temp.records_run_${runs}`
    const proposedTable = `temp.records_run_${runs}_proposed`
    database.exec(
      `CREATE TEMP TABLE ${table.slice(5)} (idx INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, ` +
        "identity TEXT NOT NULL UNIQUE, record_id INTEGER, flagged INTEGER NOT NULL DEFAULT 0, unmatched TEXT)",
    )
    database.exec(`CREATE TEMP TABLE ${proposedTable.slice(5)} (ref TEXT PRIMARY KEY)`)
    try {
      let truncated = false
      const flag = () => {
        truncated = true
      }
      const errors = capped<IngestError>(limit, flag)
      const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 }
      const issue = (error: IngestError) => {
        errors.push(error)
        onIssue?.(error)
      }
      const proposed = (ref: string) => {
        database.prepare(`INSERT OR IGNORE INTO ${proposedTable} (ref) VALUES (?)`).run(ref)
      }
      const takeChunk = (batch: RunItem[]) =>
        write(database, () => {
          const accountId = accountPkOf(source)
          const complete: number[] = []
          for (const item of batch) {
            const { index, record } = item
            const refused = (error: IngestError) => {
              counts.refused += 1
              issue(error)
            }
            if (item.errors?.length) {
              counts.refused += 1
              for (const error of item.errors) issue(error)
              continue
            }
            const identity = `${record.type}\0${record.external_id}`
            if (database.prepare(`SELECT 1 FROM ${table} WHERE key = ?`).get(record.key)) {
              refused({
                pointer: pointerOf("records", index, "key"),
                code: "record.duplicate-key",
                message: "another record of this envelope has this key",
                key: record.key,
              })
              continue
            }
            if (database.prepare(`SELECT 1 FROM ${table} WHERE identity = ?`).get(identity)) {
              refused({
                pointer: pointerOf("records", index, "external_id"),
                code: "record.duplicate",
                message: `another record of this envelope is ${record.type} ${record.external_id}`,
                key: record.key,
              })
              continue
            }
            database
              .prepare(`INSERT INTO ${table} (idx, key, identity) VALUES (?, ?, ?)`)
              .run(index, record.key, identity)
            try {
              const done = write(database, () => writeOne(accountId, source, record, options, proposed))
              counts[done.status] += 1
              database
                .prepare(`UPDATE ${table} SET record_id = ?, flagged = ?, unmatched = ? WHERE key = ?`)
                .run(
                  done.id,
                  done.flagged ? 1 : 0,
                  done.unmatched === undefined ? null : JSON.stringify(done.unmatched),
                  record.key,
                )
              if (done.complete) complete.push(done.id)
            } catch (error) {
              if (!(error instanceof CliError)) throw error
              const at = (error.details as { at?: string | (string | number)[] } | undefined)?.at ?? "fields"
              refused({
                pointer: pointerOf("records", index, ...[at].flat()),
                code: codeOf(error),
                message: error.message,
                key: record.key,
              })
            }
          }
          for (const id of complete) completeDependents(id, source, proposed, issue)
        })
      let batch: RunItem[] = []
      for await (const item of items) {
        batch.push(item)
        if (batch.length >= chunk) {
          takeChunk(batch)
          batch = []
        }
      }
      if (batch.length > 0) takeChunk(batch)
      return read(database, () => {
        const listed = <T>(rows: Iterable<Row>, of: (row: Row) => T | null): T[] => {
          const kept: T[] = []
          for (const row of rows) {
            const item = of(row)
            if (item === null) continue
            if (kept.length === limit) {
              flag()
              break
            }
            kept.push(item)
          }
          return kept
        }
        const waiting = listed(
          database
            .prepare(
              `SELECT run.idx, run.key, run.record_id FROM ${table} run JOIN records r ON r.id = run.record_id ` +
                "WHERE r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type NOT LIKE 'custom:%' " +
                "AND run.unmatched IS NULL ORDER BY run.idx",
            )
            .all(),
          (row) => {
            const missing = missingOf(Number(row.record_id))
            return missing === null ? null : { index: Number(row.idx), key: String(row.key), missing }
          },
        )
        const unmatched = listed(
          database
            .prepare(
              `SELECT run.idx, run.key, run.unmatched FROM ${table} run JOIN records r ON r.id = run.record_id ` +
                "WHERE run.unmatched IS NOT NULL AND r.entity_id IS NULL ORDER BY run.idx",
            )
            .all(),
          (row) => ({
            index: Number(row.idx),
            key: String(row.key),
            ...(JSON.parse(String(row.unmatched)) as { reason: string; candidates: string[] }),
          }),
        )
        const flagged = listed(
          database
            .prepare(
              `SELECT run.idx, run.key, r.entity_type, r.entity_id FROM ${table} run JOIN records r ` +
                "ON r.id = run.record_id WHERE run.flagged = 1 ORDER BY run.idx",
            )
            .all(),
          (row) => ({
            index: Number(row.idx),
            key: String(row.key),
            entity: entityRef(row.entity_type, row.entity_id) as string,
          }),
        )
        const proposedRows = database
          .prepare(`SELECT ref FROM ${proposedTable} ORDER BY rowid LIMIT ?`)
          .all(limit + 1)
          .map((row) => String(row.ref))
        if (proposedRows.length > limit) flag()
        return {
          ...counts,
          errors: errors.list.sort((a, b) => a.pointer.localeCompare(b.pointer, "en", { numeric: true })),
          proposed: proposedRows.slice(0, limit),
          waiting,
          unmatched,
          flagged,
          truncated,
        }
      })
    } finally {
      database.exec(`DROP TABLE IF EXISTS ${table}`)
      database.exec(`DROP TABLE IF EXISTS ${proposedTable}`)
    }
  }

  const accountPkOf = (source: EnvelopeSource) =>
    accountPk(context, { provider: source.provider, account: source.account })

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

  return {
    run: async (source, items, options = {}) =>
      options.dryRun ? rehearse(database, () => runOver(source, items, options)) : runOver(source, items, options),
    get: async (key) =>
      read(database, () => {
        const row = rowOf(key)
        return row ? sourceRecordOf(row) : undefined
      }),
    list: async ({ provider, account, type, waiting, unmatched, flagged, limit = 100 }) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new CliError("validation_error", "a record list takes 1–500 items")
      return read(database, () => {
        if (findAccountPk(context, { provider, account }) === undefined) return []
        const rows = database
          .prepare(
            `${SELECT}WHERE a.provider = ? AND a.external_id = ? AND (? IS NULL OR r.type = ?) ` +
              "AND (? IS NULL OR (r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type NOT LIKE 'custom:%' " +
              "AND r.type NOT IN ('person', 'organization', 'project'))) " +
              "AND (? IS NULL OR (r.entity_id IS NULL AND r.deleted_at IS NULL " +
              "AND r.type IN ('person', 'organization', 'project'))) " +
              "AND (? IS NULL OR (r.entity_id IS NOT NULL AND (r.deleted_at IS NOT NULL " +
              "OR r.projected_fingerprint IS NOT r.fingerprint))) ORDER BY r.updated_at DESC, r.id DESC LIMIT ?",
          )
          .all(
            provider,
            account,
            type ?? null,
            type ?? null,
            waiting ? 1 : null,
            unmatched ? 1 : null,
            flagged ? 1 : null,
            limit,
          )
        return rows.map(sourceRecordOf)
      })
    },
    map: async (key, entity, by) => {
      if (by !== "owner")
        throw new CliError("permission_error", "only the owner says which entity a record is", {
          reason: "record.map-owner-only",
        })
      let unused: string | null = null
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
          repoint(row, from, thing)
        }
        sql(
          "UPDATE records SET entity_type = ?, entity_id = ?, created_entity = 0, projected_fingerprint = fingerprint " +
            "WHERE id = ?",
        ).run(thing.type, thing.id, Number(row.id))
        if (from !== null && !pointedAt(from.type, from.id)) unused = entityRef(from.type, from.id)
        const source = { provider: key.provider, account: key.account, batch_id: String(row.batch_id) }
        completeDependents(
          Number(row.id),
          source,
          () => undefined,
          () => undefined,
        )
      })
      return read(database, () => ({ ...sourceRecordOf(rowOf(key) as Row), unused }))
    },
    match: async ({ provider, account }) => {
      const result: MatchRun = { linked: 0, created: 0, unmatched: [], proposed: [], errors: [] }
      write(database, () => {
        const accountId = findAccountPk(context, { provider, account })
        if (accountId === undefined) return
        const rows = database
          .prepare(
            "SELECT * FROM records WHERE account_id = ? AND entity_id IS NULL AND deleted_at IS NULL " +
              "AND type IN ('person', 'organization', 'project') ORDER BY id",
          )
          .all(accountId)
        for (const row of rows) {
          const source = { provider, account, batch_id: String(row.batch_id) }
          const recordKey = { provider, account, type: String(row.type), externalId: String(row.external_id) }
          try {
            const done = write(database, () => project(row, source))
            if (done.unmatched) result.unmatched.push({ key: recordKey, ...done.unmatched })
            if (!done.made) continue
            const created = Number(
              sql("SELECT created_entity FROM records WHERE id = ?").get(Number(row.id))?.created_entity,
            )
            if (created === 1) result.created += 1
            else result.linked += 1
            completeDependents(
              Number(row.id),
              source,
              (ref) => result.proposed.push(ref),
              (error) => result.errors.push(error),
            )
          } catch (error) {
            if (!(error instanceof CliError)) throw error
            result.errors.push({
              pointer: "",
              code: codeOf(error),
              message: `${recordKey.type} ${recordKey.externalId}: ${error.message}`,
            })
          }
        }
      })
      result.proposed = [...new Set(result.proposed)]
      return result
    },
  }
}
