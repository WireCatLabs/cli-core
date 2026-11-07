import { CliError } from "@wirecat/cli-base"
import { formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import { rolesOf } from "../../domain/record-types.js"
import {
  type EnvelopeRecord,
  type EnvelopeSource,
  type IngestError,
  pointerOf,
  type RecordRelation,
  recordFingerprint,
} from "../../domain/records.js"
import type { CacheDatabase } from "../driver.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { financeOperationsOver, type PaymentDetail } from "./finance.js"
import type { Author } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import {
  FIELD_REFERENCE_ROLES,
  IMPORTER,
  isProjected,
  PROJECTED_TYPES,
  type ProjectedType,
  RECORD_PROJECTORS,
  type Row,
  refusal,
  type Share,
  stringField,
} from "./record-projectors.js"
import { netPaidSql } from "./refunds.js"
import { referenceOfThing, storedThing } from "./things.js"
import { read, write } from "./transaction.js"

export interface RecordKey {
  provider: string
  account: string
  type: string
  externalId: string
}

export interface SourceRecord extends RecordKey {
  fields: Record<string, unknown>
  revision: number | null
  fingerprint: string
  relations: { role: string; type: string; externalId: string; amount: string | null; resolved: boolean }[]
  /** The entity made from it or mapped to it by the owner; `null` while it waits or for a type without a table. */
  entity: string | null
  /** The source changed or deleted it after its entity was made: the owner should look at the entity. */
  flagged: boolean
  batchId: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface RecordOutcome {
  /** The record's place in the envelope's `records`. */
  index: number
  key: string
  status: "created" | "updated" | "unchanged" | "deleted" | "refused"
  error?: IngestError
}

export interface RecordsWritten {
  outcomes: RecordOutcome[]
  /** `invoice:` and `payment:` refs this import proposed, also for records of earlier imports it completed. */
  proposed: string[]
  /** Kept, with no entity yet: the roles whose target is not imported or has no entity. */
  waiting: { index: number; key: string; missing: string[] }[]
  /** Changed or deleted at the source after its entity was made. */
  flagged: { index: number; key: string; entity: string }[]
  /** A record of an earlier import this one completed, whose entity was still refused. */
  laterErrors: IngestError[]
}

export interface RecordStore {
  /** Writes validated records of one source, per chunk in one transaction; a dry run rolls everything back. */
  write(
    source: EnvelopeSource,
    records: { index: number; record: EnvelopeRecord }[],
    options?: { dryRun?: boolean; chunk?: number },
  ): Promise<RecordsWritten>
  get(key: RecordKey): Promise<SourceRecord | undefined>
  list(filter: {
    provider: string
    account: string
    type?: string
    /** Only records whose entity waits for a reference. */
    waiting?: boolean
    flagged?: boolean
    /** 1–500, 100 by default. */
    limit?: number
  }): Promise<SourceRecord[]>
  /**
   * The owner says which entity a record is: `person:4` for a payer a sheet names. Never done by name. Records that
   * waited for it get their entity, as proposals.
   */
  map(key: RecordKey, entity: string, by: Author): Promise<SourceRecord>
}

const PROJECTED_TYPES_SQL = PROJECTED_TYPES.map((type) => `'${type}'`).join(", ")

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

export const recordStoreOver = (context: StoreContext): RecordStore => {
  const { database, now } = context
  const finance = financeOperationsOver(context)
  const statements = new Map<string, ReturnType<CacheDatabase["prepare"]>>()
  const sql = (text: string) => {
    let statement = statements.get(text)
    if (!statement) {
      statement = database.prepare(text)
      statements.set(text, statement)
    }
    return statement
  }

  const entityRef = (type: unknown, id: unknown): string | null =>
    type == null ? null : (referenceOfThing(database, storedThing(type, id)) ?? `${String(type)}:${String(id)}`)

  /** Roles a projection needs whose target has no entity yet, the entities of the rest, and what each invoice gets. */
  const relatedOf = (recordId: number, type: ProjectedType) => {
    const roles = rolesOf(type)
    const known = roles.map(([name]) => name)
    const many = roles.flatMap(([name, role]) => (role.many ? [name] : []))
    const rows = sql(
      "SELECT rr.role, rr.amount, t.entity_type, t.entity_id FROM record_relations rr " +
        "LEFT JOIN records t ON t.id = rr.target_id AND t.deleted_at IS NULL WHERE rr.record_id = ? ORDER BY rr.id",
    ).all(recordId)
    const related = new Map<string, string[]>()
    const shares: Share[] = []
    const missing = new Set<string>()
    for (const row of rows) {
      const role = String(row.role)
      if (!known.includes(role)) continue
      const ref = entityRef(row.entity_type, row.entity_id)
      if (ref === null) missing.add(role)
      else related.set(role, [...(related.get(role) ?? []), ref])
      if (ref !== null && role === "settles")
        shares.push({ invoice: ref, amount: row.amount == null ? null : String(row.amount) })
    }
    for (const [role, refs] of related)
      if (refs.length > 1 && !many.includes(role)) refusal(`a record has one ${role}`, "record.relation-ambiguous")
    return { related, shares, missing: [...missing] }
  }

  /** Makes the proposal a waiting record stands for, once every reference it names has an entity. */
  const project = (row: Row, source: EnvelopeSource): { proposed?: string; missing: string[] } => {
    const type = row.type as ProjectedType
    const { related, shares, missing } = relatedOf(Number(row.id), type)
    if (missing.length > 0) return { missing }
    const fields = JSON.parse(String(row.fields)) as Row
    for (const name of FIELD_REFERENCE_ROLES) stringField(fields, name)
    const ref = RECORD_PROJECTORS[type](fields, { related, shares }, source, { finance, settle })
    const entity = requiredThing(database, ref)
    sql("UPDATE records SET entity_type = ?, entity_id = ?, projected_fingerprint = fingerprint WHERE id = ?").run(
      entity.type,
      entity.id,
      Number(row.id),
    )
    return { proposed: ref, missing: [] }
  }

  /**
   * What other payments leave open on an invoice. Proposed ones count too: the owner confirms them later, so payments
   * of one batch would otherwise each take the whole invoice.
   */
  const freeOn = (invoice: string, payment: string): number => {
    const [target, own] = [requiredThing(database, invoice), requiredThing(database, payment)]
    const row = sql(
      `SELECT i.total - ${netPaidSql("i.id", { counted: "pending", excluding: "?" })} AS free FROM invoices i WHERE i.id = ?`,
    ).get(own.id, target.id)
    return Number(row?.free ?? 0)
  }

  /** A payment settles each invoice it names by the amount the source gives, then the rest as far as both allow. */
  const settle = (made: PaymentDetail, shares: Share[]): string => {
    const units = (amount: string) => minorUnits(amount, made.currency)
    let left = units(made.unallocated)
    const given = shares.filter((one) => one.amount !== null)
    for (const { invoice, amount } of [...given, ...shares.filter((one) => one.amount === null)]) {
      const share = amount === null ? Math.min(left, freeOn(invoice, made.ref)) : units(amount)
      if (share <= 0) continue
      finance.allocate({
        payment: made.ref,
        invoice,
        amount: formatDecimal(share, scaleOf(made.currency)),
        by: IMPORTER,
      })
      left -= share
    }
    return made.ref
  }

  /** A payment the import proposed and the owner has not decided yet takes its record's settles relations again. */
  const resettle = (recordId: number, ref: string): boolean => {
    const payment = finance.payment(ref)
    if (payment.review !== "proposed" || payment.author.type !== "bot" || payment.author.name !== IMPORTER.bot)
      return false
    for (const { invoice } of payment.allocations) finance.unallocate({ payment: ref, invoice, by: IMPORTER })
    settle(finance.payment(ref), relatedOf(recordId, "payment").shares)
    return true
  }

  /** The settles amounts a payment record gives, refused at the first one that is not money or goes past the payment. */
  const checkShares = (record: EnvelopeRecord) => {
    const relations = record.relations ?? []
    if (record.type !== "payment" || !relations.some((relation) => relation.amount !== undefined)) return
    const fields = record.fields ?? {}
    if (typeof fields.currency !== "string") return
    const currency = fields.currency
    let left: number
    try {
      left = minorUnits(fields.amount, currency)
    } catch {
      return
    }
    for (const [index, { amount }] of relations.entries()) {
      if (amount === undefined) continue
      const at = ["relations", index, "amount"]
      let units = 0
      try {
        units = minorUnits(amount, currency, "a settles amount")
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        refusal(error.message, codeOf(error), at)
      }
      if (units <= 0) refusal("a settles amount is more than 0", "money.amount", at)
      left -= units
      if (left < 0)
        refusal(
          `the settles amounts add up to more than the payment's ${String(fields.amount)} ${currency}`,
          "record.over-payment",
          at,
        )
    }
  }

  /** Records that waited on `target` and may now have their entity, and theirs in turn. */
  const completeDependents = (
    target: number,
    source: EnvelopeSource,
    proposed: string[],
    laterErrors: IngestError[],
  ) => {
    const queue = [target]
    while (queue.length > 0) {
      const rows = sql(
        "SELECT DISTINCT r.* FROM record_relations rr JOIN records r ON r.id = rr.record_id WHERE rr.target_id = ? " +
          `AND r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type IN (${PROJECTED_TYPES_SQL})`,
      ).all(queue.shift() as number)
      for (const row of rows) {
        try {
          const done = write(database, () => project(row, source))
          if (done.proposed) {
            proposed.push(done.proposed)
            queue.push(Number(row.id))
          }
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          laterErrors.push({
            pointer: "",
            code: codeOf(error),
            message: `${String(row.type)} ${String(row.external_id)} waits: ${error.message}`,
          })
        }
      }
    }
  }

  const storedRelations = (recordId: number): RecordRelation[] =>
    sql("SELECT role, target_type, target_external_id FROM record_relations WHERE record_id = ?")
      .all(recordId)
      .map((row) => ({
        role: String(row.role),
        type: String(row.target_type),
        external_id: String(row.target_external_id),
      }))

  const relate = (recordId: number, accountId: number, relations: RecordRelation[], at: number) => {
    sql("DELETE FROM record_relations WHERE record_id = ?").run(recordId)
    for (const relation of relations)
      sql(
        "INSERT OR IGNORE INTO record_relations (record_id, role, target_type, target_external_id, target_id, " +
          "created_at, amount) VALUES (?, ?, ?, ?, (SELECT id FROM records WHERE account_id = ? AND type = ? " +
          "AND external_id = ?), ?, ?)",
      ).run(
        recordId,
        relation.role,
        relation.type,
        relation.external_id,
        accountId,
        relation.type,
        relation.external_id,
        at,
        relation.amount ?? null,
      )
  }

  const writeOne = (
    accountId: number,
    source: EnvelopeSource,
    { record }: { index: number; record: EnvelopeRecord },
    proposed: string[],
  ): { status: RecordOutcome["status"]; id?: number; flagged?: boolean; complete?: boolean } => {
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
      return { status: "deleted", id: Number(stored.id), flagged: stored.entity_id != null }
    }
    const fields = JSON.stringify(record.fields)
    if (stored && stored.fingerprint === fingerprint && stored.deleted_at == null)
      return { status: "unchanged", id: Number(stored.id) }
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
    relate(id, accountId, relations, time)
    let projected = false
    let flagged = stored?.entity_id != null && stored.projected_fingerprint !== fingerprint
    if (isProjected(record.type) && stored?.entity_id == null) {
      const done = project({ id, type: record.type, fields, account_id: accountId }, source)
      if (done.proposed) proposed.push(done.proposed)
      projected = done.proposed !== undefined
    } else if (record.type === "payment" && stored?.entity_type === "payment" && stored.deleted_at == null) {
      const ref = `payment:${Number(stored.entity_id)}`
      if (resettle(id, ref)) {
        proposed.push(ref)
        if (!beyondSettles) {
          sql("UPDATE records SET projected_fingerprint = fingerprint WHERE id = ?").run(id)
          flagged = false
        }
      }
    }
    return {
      status: stored ? "updated" : "created",
      id,
      flagged,
      // Records waiting on this one move only when it has an entity: made now, or back from a delete.
      complete: projected || (stored?.deleted_at != null && stored.entity_id != null),
    }
  }

  const missingOf = (id: number): string[] | null => {
    const row = sql("SELECT type, entity_id, deleted_at FROM records WHERE id = ?").get(id)
    if (!row || row.entity_id != null || row.deleted_at != null || !isProjected(row.type)) return null
    const { missing } = relatedOf(id, row.type)
    return missing.length > 0 ? missing : null
  }

  const ingest = (
    source: EnvelopeSource,
    records: { index: number; record: EnvelopeRecord }[],
    chunk: number,
  ): RecordsWritten => {
    const outcomes: RecordOutcome[] = []
    const proposed: string[] = []
    const flagged: RecordsWritten["flagged"] = []
    const laterErrors: IngestError[] = []
    const kept: { index: number; key: string; id: number }[] = []
    for (let start = 0; start < records.length; start += chunk) {
      write(database, () => {
        const accountId = accountPk(context, { provider: source.provider, account: source.account })
        const complete: number[] = []
        for (const item of records.slice(start, start + chunk)) {
          try {
            const done = isProjected(item.record.type)
              ? write(database, () => writeOne(accountId, source, item, proposed))
              : writeOne(accountId, source, item, proposed)
            outcomes.push({ index: item.index, key: item.record.key, status: done.status })
            if (done.id === undefined) continue
            kept.push({ index: item.index, key: item.record.key, id: done.id })
            if (done.flagged) {
              const row = sql("SELECT entity_type, entity_id FROM records WHERE id = ?").get(done.id)
              flagged.push({
                index: item.index,
                key: item.record.key,
                entity: entityRef(row?.entity_type, row?.entity_id) as string,
              })
            }
            if (done.complete) complete.push(done.id)
          } catch (error) {
            if (!(error instanceof CliError)) throw error
            const at = (error.details as { at?: string | (string | number)[] } | undefined)?.at ?? "fields"
            const pointer = pointerOf("records", item.index, ...[at].flat())
            outcomes.push({
              index: item.index,
              key: item.record.key,
              status: "refused",
              error: { pointer, code: codeOf(error), message: error.message, key: item.record.key },
            })
          }
        }
        for (const id of complete) completeDependents(id, source, proposed, laterErrors)
      })
    }
    const waiting = read(database, () =>
      kept.flatMap(({ index, key, id }) => {
        const missing = missingOf(id)
        return missing === null ? [] : [{ index, key, missing }]
      }),
    )
    return { outcomes, proposed: [...new Set(proposed)], waiting, flagged, laterErrors }
  }

  const sourceRecordOf = (row: Row): SourceRecord => ({
    provider: String(row.provider),
    account: String(row.account),
    type: String(row.type),
    externalId: String(row.external_id),
    fields: JSON.parse(String(row.fields)) as Record<string, unknown>,
    revision: row.revision == null ? null : Number(row.revision),
    fingerprint: String(row.fingerprint),
    relations: sql(
      "SELECT role, target_type, target_external_id, target_id, amount FROM record_relations WHERE record_id = ? " +
        "ORDER BY id",
    )
      .all(Number(row.id))
      .map((relation) => ({
        role: String(relation.role),
        type: String(relation.target_type),
        externalId: String(relation.target_external_id),
        amount: relation.amount == null ? null : String(relation.amount),
        resolved: relation.target_id != null,
      })),
    entity: entityRef(row.entity_type, row.entity_id),
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
    write: async (source, records, { dryRun = false, chunk = 1000 } = {}) => {
      if (!dryRun) return ingest(source, records, chunk)
      let result: RecordsWritten | undefined
      const rollback = new Error("dry run")
      try {
        write(database, () => {
          result = ingest(source, records, chunk)
          throw rollback
        })
      } catch (error) {
        if (error !== rollback) throw error
      }
      return result as RecordsWritten
    },
    get: async (key) =>
      read(database, () => {
        const row = rowOf(key)
        return row ? sourceRecordOf(row) : undefined
      }),
    list: async ({ provider, account, type, waiting, flagged, limit = 100 }) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new CliError("validation_error", "a record list takes 1–500 items")
      return read(database, () => {
        if (findAccountPk(context, { provider, account }) === undefined) return []
        const rows = database
          .prepare(
            `${SELECT}WHERE a.provider = ? AND a.external_id = ? AND (? IS NULL OR r.type = ?) ` +
              `AND (? IS NULL OR (r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type IN (${PROJECTED_TYPES_SQL}))) ` +
              "AND (? IS NULL OR (r.entity_id IS NOT NULL AND (r.deleted_at IS NOT NULL " +
              "OR r.projected_fingerprint IS NOT r.fingerprint))) ORDER BY r.updated_at DESC, r.id DESC LIMIT ?",
          )
          .all(provider, account, type ?? null, type ?? null, waiting ? 1 : null, flagged ? 1 : null, limit)
        return rows.map(sourceRecordOf)
      })
    },
    map: async (key, entity, by) => {
      if (by !== "owner")
        throw new CliError("permission_error", "only the owner says which entity a record is", {
          reason: "record.map-owner-only",
        })
      const proposed: string[] = []
      const laterErrors: IngestError[] = []
      write(database, () => {
        const row = rowOf(key)
        if (!row || row.deleted_at != null)
          throw new CliError("not_found", `no ${key.type} ${key.externalId} from ${key.provider} ${key.account}`)
        const thing = requiredThing(database, entity, "the entity")
        if (thing.type !== key.type)
          refusal(`a ${key.type} record maps to a ${key.type}:, not ${entity}`, "record.map-type")
        if (row.entity_id != null && !(row.entity_type === thing.type && Number(row.entity_id) === thing.id))
          refusal(
            `${key.type} ${key.externalId} is already ${entityRef(row.entity_type, row.entity_id)}`,
            "record.mapped",
          )
        sql("UPDATE records SET entity_type = ?, entity_id = ?, projected_fingerprint = fingerprint WHERE id = ?").run(
          thing.type,
          thing.id,
          Number(row.id),
        )
        const source = { provider: key.provider, account: key.account, batch_id: String(row.batch_id) }
        completeDependents(Number(row.id), source, proposed, laterErrors)
      })
      return read(database, () => sourceRecordOf(rowOf(key) as Row))
    },
  }
}
