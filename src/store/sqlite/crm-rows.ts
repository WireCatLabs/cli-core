import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import type { CrmItem, CrmPipeline } from "../../domain/crm.js"
import { type DealKind, STAGE_OUTCOMES } from "../../domain/deals.js"
import { dayIn } from "../../domain/moment.js"
import { currencyOf, minorUnits, scaleOf } from "../../domain/money.js"
import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { findAccountPk } from "./accounts.js"
import { authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"

/** What the store could not keep, and why: an item whose stage is not stored or whose field it refuses, or a pipeline. */
export interface CrmSkipped {
  externalId: string
  reason: "crm.stage-unknown" | "crm.item-invalid"
  message: string
}

export const TABLES = { deal: "deals", lead: "leads" } as const

const MONEY_REFUSALS: readonly unknown[] = ["money.currency", "money.amount"]

const amountFault = (item: CrmItem, code: string | null): string => {
  const text = String(item.amount).trim()
  const decimal = /^\d+(?:\.(\d+))?$/.exec(text)
  if (text.startsWith("-")) return "it is below zero"
  if (!decimal) return "it is not a decimal number"
  if ((decimal[1] ?? "").length > scaleOf(String(code))) return `it has more decimals than ${code} has`
  return "it is too large to keep exactly"
}

/** A deal is never dropped over its money: what the store cannot hold is left out, and the deal says why. */
const moneyOf = (item: CrmItem) => {
  if (item.amount == null || item.currency == null) return { currency: null, amount: null, amountNote: null }
  try {
    const currency = currencyOf(item.currency)
    return { currency, amount: minorUnits(String(item.amount), currency), amountNote: null }
  } catch (error) {
    const reason = error instanceof CliError ? (error.details as { reason?: unknown } | undefined)?.reason : undefined
    if (!MONEY_REFUSALS.includes(reason)) throw error
    const code = textOf(String(item.currency), 10)
    const why = reason === "money.currency" ? `the store keeps no amounts in ${code}` : amountFault(item, code)
    return {
      currency: null,
      amount: null,
      amountNote: `the CRM's amount ${textOf(String(item.amount), 40)} ${code} is not kept: ${why}`,
    }
  }
}

/** Who writes a CRM's copies: the sync, not an agent, so `author.kind` is `rule`. */
export const SOURCE = "crm"

/** A deal or lead given to another CRM user, as the sync saw it. */
export const OWNER_CHANGE_RECORD = "crm.owner-change"

/**
 * A contact's own fields beside its identity: who it is assigned to, when the CRM made and changed it, its page and
 * its custom values. Not `person`: a records import's `person` without an entity is matched into people.
 */
export const PERSON_RECORD = "crm.person"

/**
 * A contact's identity id: identities are unique per provider, and two portals of one CRM both have a contact 5.
 * `contact:` references percent-encode it, so the `/` stays one part.
 */
export const crmIdentityId = (key: AccountKey, externalId: string, type: "contact" | "user" = "contact"): string =>
  `${idPart(key.account)}/${type}/${idPart(externalId)}`

/**
 * A `/` inside an account or an id would let `a` + `b/contact/c` and `a/contact/b` + `c` name one contact, so it is
 * escaped, with the `%` that escapes it; an id with neither, every CRM's so far, is written as before.
 */
const idPart = (value: string) => value.replaceAll("%", "%25").replaceAll("/", "%2F")

/** What every contact identity of the account starts with. */
export const crmAccountPrefix = (key: AccountKey) => `${idPart(key.account)}/`

/** The stored copy's `deal:<id>` or `lead:<id>`, deleted or not. */
export const crmRefOf = (context: StoreContext, key: AccountKey, kind: DealKind, externalId: string): string | null => {
  const accountId = findAccountPk(context, key)
  const row =
    accountId === undefined
      ? undefined
      : context.database
          .prepare(`SELECT id FROM ${TABLES[kind]} WHERE account_id = ? AND external_id = ?`)
          .get(accountId, externalId)
  return row ? `${kind}:${row.id}` : null
}

/** The CRM's ids behind the copy's `organization:<id>` (its record) or `person:<id>` (its contacts, unescaped). */
export const crmExternalIdsOf = (context: StoreContext, key: AccountKey, ref: string): string[] => {
  const [, kind, id] = /^(person|organization):(\d+)$/.exec(ref) ?? []
  const accountId = findAccountPk(context, key)
  if (!kind || accountId === undefined) return []
  if (kind === "organization")
    return context.database
      .prepare(
        "SELECT external_id FROM records WHERE account_id = ? AND type = 'organization' " +
          "AND entity_type = 'organization' AND entity_id = ? AND deleted_at IS NULL ORDER BY external_id",
      )
      .all(accountId, Number(id))
      .map((row) => String(row.external_id))
  const prefix = `${crmAccountPrefix(key)}contact/`
  return context.database
    .prepare(
      "SELECT i.external_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider = ? AND l.person_id = ? AND substr(i.external_id, 1, ?) = ? ORDER BY i.external_id",
    )
    .all(key.provider, Number(id), prefix.length, prefix)
    .map((row) => decodeURIComponent(String(row.external_id).slice(prefix.length)))
}

export const day = (value: unknown, what: string): string | null => {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new CliError("validation_error", `${what} is YYYY-MM-DD, not ${JSON.stringify(value)}`)
  return value
}

export const epoch = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback

export const textOf = (value: unknown, most: number): string | null => {
  if (typeof value !== "string") return null
  const kept = value.trim().slice(0, most)
  return kept || null
}

/** What another writer than CRM sync resolved for an item: given ids win over the CRM's own lookups by external id. */
export interface ItemWriter {
  organization?: number | null
  deal?: number | null
  project?: number | null
  author?: { type: string; id: number }
  source?: string
}

/** The single-row writes CRM sync and the records envelope share, so both land on one `(account, external id)` row. */
export const crmRowsOver = (context: StoreContext) => {
  const { database } = context
  const author = (key: AccountKey) => authorActor(context, { bot: key.provider, kind: "rule" }).actor

  const pipelineOf = (accountId: number, kind: DealKind, externalId: string) =>
    database
      .prepare("SELECT * FROM pipelines WHERE account_id = ? AND kind = ? AND external_id = ?")
      .get(accountId, kind, externalId)
  /** One pipeline and its stages, by the source's ids; the rest of the account's pipelines stay as they are. */
  const savePipeline = (accountId: number, kind: DealKind, pipeline: CrmPipeline, at: number): number => {
    const name = textOf(pipeline.name, 80) ?? pipeline.externalId
    const held = pipelineOf(accountId, kind, pipeline.externalId)
    const id = held
      ? Number(held.id)
      : Number(
          database
            .prepare(
              "INSERT INTO pipelines (account_id, external_id, kind, name, name_folded, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(accountId, pipeline.externalId, kind, name, fold(name), at, at)?.id,
        )
    if (held && (held.name !== name || held.deleted_at != null))
      database
        .prepare("UPDATE pipelines SET name = ?, name_folded = ?, updated_at = ?, deleted_at = NULL WHERE id = ?")
        .run(name, fold(name), at, id)
    saveStages(id, pipeline, at)
    saveStages(id, pipeline, at)
    return id
  }

  /**
   * Stage names are unique in a pipeline, but a CRM may swap two, or give two stages one name: listed stages first
   * take a name no stage has, then their own, and a name used twice keeps the stage's id beside it.
   */
  const saveStages = (pipelineId: number, pipeline: CrmPipeline, at: number) => {
    const ordered = [...pipeline.stages].sort((a, b) => a.position - b.position)
    const counts = new Map<string, number>()
    for (const stage of ordered) counts.set(fold(stage.name), (counts.get(fold(stage.name)) ?? 0) + 1)
    const wanted = ordered.map((stage, index) => {
      const name = textOf(stage.name, 80) ?? stage.externalId
      const folded = (counts.get(fold(stage.name)) ?? 0) > 1 ? `${fold(name)} (${stage.externalId})` : fold(name)
      if (!(STAGE_OUTCOMES as readonly string[]).includes(stage.outcome))
        throw new CliError("invalid_response", `stage ${stage.externalId} has no known outcome: ${stage.outcome}`)
      return { ...stage, name, folded, position: index + 1 }
    })
    const held = database.prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ?").all(pipelineId)
    const listed = new Set(wanted.map(({ externalId }) => externalId))
    const taken = new Set(wanted.map(({ folded }) => folded))
    const rename = database.prepare("UPDATE pipeline_stages SET name_folded = ? WHERE id = ?")
    const gone = database.prepare("UPDATE pipeline_stages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    for (const row of held) {
      const kept = row.external_id != null && listed.has(String(row.external_id))
      if (kept) rename.run(`\u0000${row.id}`, Number(row.id))
      else if (taken.has(String(row.name_folded)))
        rename.run(`${row.name_folded} (${row.external_id ?? row.id})`, Number(row.id))
      if (!kept) gone.run(at, Number(row.id))
    }
    const byId = new Map(held.map((row) => [String(row.external_id), row]))
    for (const stage of wanted) {
      const row = byId.get(stage.externalId)
      if (row)
        database
          .prepare(
            "UPDATE pipeline_stages SET name = ?, name_folded = ?, position = ?, outcome = ?, updated_at = ?, " +
              "deleted_at = NULL WHERE id = ?",
          )
          .run(stage.name, stage.folded, stage.position, stage.outcome, at, Number(row.id))
      else
        database
          .prepare(
            "INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, outcome, external_id, created_at, " +
              "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(pipelineId, stage.name, stage.folded, stage.position, stage.outcome, stage.externalId, at, at)
    }
  }

  const organizationIdOf = (accountId: number, externalId: string): number | null => {
    const row = database
      .prepare(
        "SELECT entity_id FROM records WHERE account_id = ? AND type = 'organization' AND external_id = ? " +
          "AND entity_type = 'organization'",
      )
      .get(accountId, externalId)
    return row?.entity_id == null ? null : Number(row.entity_id)
  }
  /** Who a deal or lead went from and to, as `crm.owner-change` on it: a CRM's users are often not listed. */
  const ownerChanged = (
    accountId: number,
    kind: DealKind,
    item: CrmItem,
    change: { from: string | null; to: string | null },
    at: number,
  ) => {
    const when = epoch(item.updatedAt, at)
    const externalId = `${kind}/${item.externalId}/${when}`
    const fields = { kind, ...change, at: when }
    const inserted = database
      .prepare(
        "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
      )
      .get(accountId, OWNER_CHANGE_RECORD, externalId, JSON.stringify(fields), externalId, SOURCE, at, at)
    if (inserted)
      database
        .prepare(
          "INSERT INTO record_relations (record_id, role, target_type, target_external_id, created_at) " +
            "VALUES (?, 'on', ?, ?, ?)",
        )
        .run(Number(inserted.id), kind, item.externalId, at)
  }

  /** The deal or lead row of `(account, external id)`; `writer` gives what another writer than CRM sync resolved. */
  const saveItemRow = (
    key: AccountKey,
    accountId: number,
    kind: DealKind,
    item: CrmItem,
    at: number,
    writer: ItemWriter = {},
  ): CrmSkipped | { id: number; amountNote?: string } => {
    const pipeline = pipelineOf(accountId, kind, item.pipeline)
    const stage =
      pipeline &&
      database
        .prepare("SELECT id, outcome FROM pipeline_stages WHERE pipeline_id = ? AND external_id = ?")
        .get(Number(pipeline.id), item.stage)
    if (!pipeline || !stage)
      return {
        externalId: item.externalId,
        reason: "crm.stage-unknown" as const,
        message: `${kind} ${item.externalId} stands in stage ${item.stage} of pipeline ${item.pipeline}, which is not stored`,
      }
    const title = textOf(item.title, 200) ?? `${kind} ${item.externalId}`
    const { currency, amount, amountNote } = moneyOf(item)
    if (item.status != null && !(STAGE_OUTCOMES as readonly string[]).includes(item.status))
      throw new CliError("validation_error", `${kind} ${item.externalId}'s status is open, won or lost`)
    const status = item.status ?? String(stage.outcome)
    const table = TABLES[kind]
    const held = database
      .prepare(
        `SELECT id, status, closed_date, json_extract(metadata, '$.assignee') AS assignee FROM ${table} ` +
          "WHERE account_id = ? AND external_id = ?",
      )
      .get(accountId, item.externalId)
    // A CRM that gives no closed day: the owner's day it was first seen so closed, never that of a later edit (BUG-8).
    const closed =
      status === "open"
        ? null
        : (day(item.closedDate, "a closed day") ??
          (held && held.status === status && held.closed_date != null
            ? String(held.closed_date)
            : dayIn(epoch(item.updatedAt, at), timezoneOf())))
    const deal =
      writer.deal !== undefined
        ? writer.deal === null
          ? undefined
          : { id: writer.deal }
        : kind === "lead" && item.deal
          ? database.prepare("SELECT id FROM deals WHERE account_id = ? AND external_id = ?").get(accountId, item.deal)
          : undefined
    const metadata = {
      ...(item.metadata ?? {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.assignee ? { assignee: crmIdentityId(key, item.assignee, "user") } : {}),
      ...(textOf(item.contactName, 200) ? { contact_name: textOf(item.contactName, 200) } : {}),
      ...(textOf(item.companyName, 200) ? { company_name: textOf(item.companyName, 200) } : {}),
      ...(item.closedReason && status !== "open" ? { closed_reason: textOf(item.closedReason, 2000) } : {}),
      ...(amountNote ? { amount_note: { label: "Amount not kept", value: amountNote } } : {}),
    }
    const values = {
      title,
      organization:
        writer.organization !== undefined
          ? writer.organization
          : item.organization
            ? organizationIdOf(accountId, item.organization)
            : null,
      stage: Number(stage.id),
      status,
      currency,
      amount,
      close: day(item.closeDate, "an expected close day"),
      closed,
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
      created: epoch(item.createdAt, at),
      updated: epoch(item.updatedAt, at),
    }
    let id: number
    if (held) {
      id = Number(held.id)
      const owner = item.assignee === undefined ? undefined : (metadata.assignee ?? null)
      if (owner !== undefined && owner !== (held.assignee ?? null))
        ownerChanged(accountId, kind, item, { from: (held.assignee as string | null) ?? null, to: owner }, at)
      database
        .prepare(
          `UPDATE ${table} SET title = ?, organization_id = ?, stage_id = ?, status = ?, currency = ?, amount = ?, ` +
            "close_date = ?, closed_date = ?, metadata = ?, updated_at = ?, deleted_at = NULL" +
            (kind === "lead" ? ", deal_id = coalesce(?, deal_id)" : "") +
            " WHERE id = ?",
        )
        .run(
          values.title,
          values.organization,
          values.stage,
          values.status,
          values.currency,
          values.amount,
          values.close,
          values.closed,
          values.metadata,
          values.updated,
          ...(kind === "lead" ? [deal ? Number(deal.id) : null] : []),
          id,
        )
    } else {
      const actor = writer.author ?? author(key)
      id = Number(
        database
          .prepare(
            `INSERT INTO ${table} (title, organization_id, stage_id, status, currency, amount, close_date, closed_date, ` +
              `account_id, external_id, author_type, author_id, source, metadata, created_at, updated_at` +
              (kind === "lead" ? ", deal_id" : "") +
              `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${kind === "lead" ? ", ?" : ""}) RETURNING id`,
          )
          .get(
            values.title,
            values.organization,
            values.stage,
            values.status,
            values.currency,
            values.amount,
            values.close,
            values.closed,
            accountId,
            item.externalId,
            actor.type,
            actor.id,
            writer.source ?? SOURCE,
            values.metadata,
            values.created,
            values.updated,
            ...(kind === "lead" ? [deal ? Number(deal.id) : null] : []),
          )?.id,
      )
    }
    if (writer.project !== undefined)
      database.prepare(`UPDATE ${table} SET project_id = ? WHERE id = ?`).run(writer.project, id)
    return { id, ...(amountNote ? { amountNote } : {}) }
  }

  return { savePipeline, saveItemRow }
}
