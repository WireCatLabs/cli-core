import { CliError } from "@wirecat/cli-base"
import {
  AMOUNT_ROLES,
  DECIDED_TABLES,
  FIELD_REFERENCE_ROLES,
  hasV1Roles,
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
  type RecordRelation,
  recordFingerprint,
} from "../../domain/records.js"
import { contractOperationsOver } from "./business-contracts.js"
import { crmRowsOver } from "./crm.js"
import { financeOperationsOver } from "./finance.js"
import { transactionOperationsOver } from "./money-transactions.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { orderOperationsOver } from "./orders.js"
import { productOperationsOver } from "./products.js"
import {
  addIdentifiers,
  createEntity,
  entitiesByIdentifiers,
  identifiersOf,
  matchOf,
  renameMade,
} from "./record-matching.js"
import { codeOf, type Projection, type ProjectionTools, type Row, refusal, stringField } from "./record-projection.js"
import { RECORD_PROJECTORS } from "./record-projectors.js"
import { recordRelationsOver } from "./record-relations.js"
import { recordSettlingOver } from "./record-settling.js"
import { importStampsOver } from "./record-stamps.js"
import { subscriptionOperationsOver } from "./subscriptions.js"
import { write } from "./transaction.js"
import { walletOperationsOver } from "./wallets.js"

/** Why a changed record's entity was left alone, beyond the source having changed it. */
export interface Flag {
  reason?: string
  candidates?: string[]
}

export interface Unresolved {
  reason: string
  candidates: string[]
}

/** A value of the record that looks like an identifier and was kept as data only. */
export interface Ignored {
  at: (string | number)[]
  reason: string
}

export interface WriteOutcome {
  status: "created" | "updated" | "unchanged" | "deleted"
  id: number
  ignored?: Ignored[]
  flagged?: Flag
  /** It now has an entity, so the records waiting on it may get theirs. */
  complete?: boolean
  unmatched?: Unresolved
}

interface Projected {
  ignored?: Ignored[]
  made?: string
  /** Made as a proposal. */
  proposed?: string
  missing: string[]
  unmatched?: Unresolved
}

const specOf = (type: RecordType) => RECORD_TYPES[type] as RecordTypeSpec

/** A record's fingerprint without its settles relations: what an import may not change on a payment it proposed. */
const unsettled = (fields: Row, relations: RecordRelation[]) =>
  recordFingerprint(
    fields,
    relations.filter((relation) => !AMOUNT_ROLES.includes(relation.role)),
  )

const tableOf = (type: unknown): string | undefined =>
  typeof type === "string" && Object.hasOwn(DECIDED_TABLES, type)
    ? DECIDED_TABLES[type as keyof typeof DECIDED_TABLES]
    : undefined

/** One record into the store and into its entity, as its type's registry entry says. */
export const recordWritesOver = (context: StoreContext) => {
  const { database, now } = context
  const sql = (text: string) => database.prepare(text)
  const finance = financeOperationsOver(context)
  const relations = recordRelationsOver(context)
  const { entityRef, relatedOf, storedRelations, relate } = relations
  const { settle, checkShares } = recordSettlingOver(context, finance)
  const stamps = importStampsOver(context)
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

  const isProposed = (type: unknown, id: number) => {
    const table = tableOf(type)
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

  const identify = (row: Row, type: IdentityType, source: EnvelopeSource, options: EnvelopeOptions): Projected => {
    const fields = JSON.parse(String(row.fields)) as Row
    const ids = identifiersOf(type, fields, source, String(row.external_id), options)
    const match = matchOf(context, type, ids)
    const ignored = ids.ignored.length > 0 ? { ignored: ids.ignored } : {}
    if (match.outcome === "ambiguous")
      return {
        ...ignored,
        missing: [],
        unmatched: { reason: match.reason, candidates: match.ids.map((id) => entityRef(type, id) as string) },
      }
    if (match.outcome === "one") {
      const ref = entityRef(type, match.id) as string
      setEntity(Number(row.id), ref, false)
      return { ...ignored, made: ref, missing: [] }
    }
    const related = relatedOf(Number(row.id), type)
    if (related.missing.length > 0) return { ...ignored, missing: related.missing }
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
    return { ...ignored, made: ref, missing: [] }
  }

  /** Gives a record its entity once every reference it names has one: a proposal, a direct row, or a match. */
  const project = (row: Row, source: EnvelopeSource, options: EnvelopeOptions = {}): Projected => {
    const type = row.type as RecordType
    if (isIdentityType(type)) return identify(row, type, source, options)
    const projector = RECORD_PROJECTORS[type]
    if (projector === null) return { missing: [] }
    const related = relatedOf(Number(row.id), type)
    if (related.missing.length > 0) return { missing: related.missing }
    const projection = projectionOf(row, source, related)
    if (hasV1Roles(type)) for (const name of FIELD_REFERENCE_ROLES) stringField(projection.fields, name)
    const ref = projector.create(projection, toolsOf())
    const entity = setEntity(Number(row.id), ref, false)
    if (specOf(type).update === "re-propose") stamps.stamp(type, entity.id)
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
    const table = tableOf(stored.entity_type)
    return (
      table === undefined ||
      sql(`SELECT review FROM ${table} WHERE id = ?`).get(Number(stored.entity_id))?.review !== "rejected"
    )
  }

  /**
   * Takes a changed record into the entity it already has, as its type's registry entry says: `undefined` when it
   * did, else why the entity was left alone.
   */
  const updateEntity = (
    stored: Row,
    id: number,
    source: EnvelopeSource,
    options: EnvelopeOptions,
    proposed: (ref: string) => void,
    ignore: (ignored: Ignored[]) => void,
  ): Flag | undefined => {
    const type = stored.type as RecordType
    const entityId = Number(stored.entity_id)
    const ref = entityRef(stored.entity_type, stored.entity_id) as string
    const row = sql("SELECT * FROM records WHERE id = ?").get(id) as Row
    const fields = JSON.parse(String(row.fields)) as Row
    const kind = specOf(type).update
    if (isIdentityType(type)) {
      if (Number(stored.created_entity) !== 1) return {}
      const ids = identifiersOf(type, fields, source, String(row.external_id), options)
      if (ids.ignored.length > 0) ignore(ids.ignored)
      const others = entitiesByIdentifiers(database, type, ids).filter((one) => one !== entityId)
      if (others.length > 0)
        return { reason: "record.ambiguous", candidates: others.map((one) => entityRef(type, one) as string) }
      renameMade(context, type, entityId, fields.name, (JSON.parse(String(stored.fields)) as Row).name)
      addIdentifiers(context, type, entityId, ids, typeof fields.name === "string" ? fields.name : null, source)
      return undefined
    }
    const projector = RECORD_PROJECTORS[type]
    if (!projector?.update || kind === "flag") return {}
    if (kind === "re-propose" && !stamps.untouched(type, entityId)) return {}
    const related = relatedOf(id, type)
    if (related.missing.length > 0) return {}
    if (!projector.update(ref, projectionOf(row, source, related), toolsOf())) return {}
    if (kind === "re-propose") stamps.stamp(type, entityId)
    if (isProposed(type, entityId)) proposed(ref)
    return undefined
  }

  const writeOne = (
    accountId: number,
    source: EnvelopeSource,
    record: EnvelopeRecord,
    options: EnvelopeOptions,
    proposed: (ref: string) => void,
  ): WriteOutcome => {
    const stored = sql("SELECT * FROM records WHERE account_id = ? AND type = ? AND external_id = ?").get(
      accountId,
      record.type,
      record.external_id,
    )
    const sent = record.relations ?? []
    const fingerprint = record.operation === "upsert" ? recordFingerprint(record.fields ?? {}, sent) : null
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
      return { status: "deleted", id: Number(stored.id), ...(liveEntity(stored) ? { flagged: {} } : {}) }
    }
    const fields = JSON.stringify(record.fields)
    const typed = isRecordType(record.type)
    if (stored && stored.fingerprint === fingerprint && stored.deleted_at == null) {
      if (stored.entity_id == null && isIdentityType(record.type)) {
        const done = project(stored, source, options)
        return {
          status: "unchanged",
          id: Number(stored.id),
          complete: done.made !== undefined,
          unmatched: done.unmatched,
          ignored: done.ignored,
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
          unsettled(record.fields ?? {}, sent))
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
    relate(id, accountId, [...sent, ...fieldReferences(record, options)], time)
    let made = false
    let unmatched: Unresolved | undefined
    let ignored: Ignored[] | undefined
    let flagged: Flag | undefined =
      stored?.entity_id != null && stored.projected_fingerprint !== fingerprint ? {} : undefined
    if (typed && stored?.entity_id == null) {
      const done = project(sql("SELECT * FROM records WHERE id = ?").get(id) as Row, source, options)
      if (done.proposed) proposed(done.proposed)
      made = done.made !== undefined
      unmatched = done.unmatched
      ignored = done.ignored
    } else if (typed && stored?.entity_id != null && stored.deleted_at == null) {
      const resettles = specOf(record.type as RecordType).update === "re-settle"
      // A payment takes its settles again even when only they changed, so its projected fingerprint lags behind.
      if (flagged !== undefined || resettles) {
        const left = updateEntity(stored, id, source, options, proposed, (list) => {
          ignored = list
        })
        if (left === undefined && !(resettles && beyondSettles)) {
          sql("UPDATE records SET projected_fingerprint = fingerprint WHERE id = ?").run(id)
          flagged = undefined
        } else if (left !== undefined) flagged = left
      }
    }
    return {
      status: stored ? "updated" : "created",
      id,
      ...(flagged === undefined ? {} : { flagged }),
      unmatched,
      ignored,
      // Records waiting on this one move only when it has an entity: made now, or back from a delete.
      complete: made || (stored?.deleted_at != null && stored.entity_id != null),
    }
  }

  return { writeOne, project, completeDependents, entityRef, missingOf: relations.missingOf }
}
