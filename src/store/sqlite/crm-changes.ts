import type { CrmActivityKind, CrmKind } from "../../domain/crm.js"
import { dayIn } from "../../domain/moment.js"
import { formatDecimal, scaleOf } from "../../domain/money.js"
import type { AccountKey } from "../types.js"
import { findAccountPk } from "./accounts.js"
import { ACTIVITY_RECORD, type ActivityFilter, crmActivitiesOver, type ListedActivity } from "./crm-activities.js"
import { OWNER_CHANGE_RECORD, PERSON_RECORD } from "./crm-rows.js"
import { STAGE_ENTRY_RECORD } from "./crm-stage-entries.js"
import type { StoreContext } from "./open.js"

export const CRM_CHANGES = [
  "created",
  "moved",
  "won",
  "lost",
  "owner_changed",
  "activity_added",
  "activity_done",
  "person_added",
] as const
export type CrmChangeKind = (typeof CRM_CHANGES)[number]

/** One thing that happened in a CRM account's copy, newest first in a page. */
export interface CrmChange {
  change: CrmChangeKind
  at: number
  kind: CrmKind
  /** The deal, lead or contact as the store names it; `null` when the copy no longer links it. */
  ref: string | null
  externalId: string
  title: string | null
  pipeline: string | null
  pipelineName: string | null
  /** A move's stages by name; an owner change's users as `<account>/user/<id>`. */
  from: string | null
  to: string | null
  amount: string | null
  currency: string | null
  /** A move from the CRM's own stage history rather than the copy's diffs between syncs. */
  exact: boolean
  /** Why a lost deal was lost, as the CRM says. */
  reason: string | null
  /** The identity `<account>/user/<id>` the row is assigned to. */
  owner: string | null
  activity: { externalId: string; kind: CrmActivityKind; subject: string; dueAt: number | null; done: boolean } | null
}

/** What `changes list` narrows by: `since` and `until` are inclusive epoch ms. */
export interface ChangeFilter {
  since: number
  until: number
  /** The zone whose days a won or lost day is compared in. */
  zone: string
  changes?: readonly CrmChangeKind[]
  /** The identity `<account>/user/<id>`; `null` is none. */
  owner?: string | null
  /** A pipeline's store id: only the changes of its deals or leads. */
  pipeline?: number
  limit: number
  offset: number
}

const HALF_DAY = 43_200_000

/**
 * Every change of an account's copy in a window, newest first, paged in SQL: deals and leads made, moved, won, lost
 * and given another owner, activities added and done, contacts added. A move comes from the CRM's own stage history
 * where a row has any, else from the copy's changes, never both; a move into a won or lost stage is listed as won or
 * lost. A day the CRM gives without a time, as a closed day, is taken at its noon in UTC, the same day everywhere.
 */
export const crmChanges = (
  context: StoreContext,
  key: AccountKey,
  filter: ChangeFilter,
): { items: CrmChange[]; hasMore: boolean } => {
  const { database } = context
  const accountId = findAccountPk(context, key)
  if (accountId === undefined) return { items: [], hasMore: false }
  const items = (table: string, kind: string) =>
    `SELECT '${kind}' AS kind, d.id, d.external_id, d.status, d.created_at, d.closed_date, ` +
    `json_extract(d.metadata, '$.assignee') AS owner, s.pipeline_id FROM ${table} d ` +
    "JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.account_id = ?1 AND d.deleted_at IS NULL"
  const entries =
    "SELECT r.id AS record, i.kind, i.id AS item, i.owner, i.pipeline_id, " +
    "CAST(json_extract(r.fields, '$.at') AS INTEGER) AS at, CAST(json_extract(r.fields, '$.stage_id') AS INTEGER) AS stage, " +
    "lag(CAST(json_extract(r.fields, '$.stage_id') AS INTEGER)) OVER (PARTITION BY i.kind, i.id " +
    "ORDER BY json_extract(r.fields, '$.at'), r.id) AS before FROM records r " +
    "JOIN record_relations rr ON rr.record_id = r.id AND rr.role = 'on' " +
    "JOIN items i ON i.kind = rr.target_type AND i.external_id = rr.target_external_id " +
    "WHERE r.account_id = ?1 AND r.type = ?2"
  const closing = "(SELECT outcome FROM pipeline_stages WHERE id = m.stage) IN ('won', 'lost')"
  const itemOf = (record: string) =>
    "(SELECT i.kind || ':' || i.id FROM record_relations rr JOIN items i ON i.kind = rr.target_type " +
    `AND i.external_id = rr.target_external_id WHERE rr.record_id = ${record} AND rr.role = 'on' LIMIT 1)`
  const parts = [
    "SELECT 'created' AS change, created_at AS at, kind, id AS item, NULL AS record, NULL AS from_id, NULL AS to_id, " +
      "0 AS exact, owner, pipeline_id FROM items WHERE created_at BETWEEN ?6 AND ?7",
    `SELECT 'moved', m.at, m.kind, m.item, m.record, m.before, m.stage, 1, m.owner, m.pipeline_id FROM entries m ` +
      `WHERE m.before IS NOT NULL AND m.at BETWEEN ?6 AND ?7 AND NOT ${closing}`,
    "SELECT 'moved', c.changed_at, i.kind, i.id, NULL, c.from_stage_id, c.to_stage_id, 0, i.owner, i.pipeline_id " +
      "FROM pipeline_stage_changes c JOIN items i ON i.kind = c.item_type AND i.id = c.item_id " +
      "WHERE c.from_stage_id IS NOT NULL AND c.changed_at BETWEEN ?6 AND ?7 " +
      "AND (SELECT outcome FROM pipeline_stages WHERE id = c.to_stage_id) NOT IN ('won', 'lost') " +
      "AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.kind = i.kind AND e.item = i.id)",
    "SELECT i.status, coalesce((SELECT max(m.at) FROM entries m WHERE m.kind = i.kind AND m.item = i.id " +
      `AND (SELECT outcome FROM pipeline_stages WHERE id = m.stage) = i.status), ` +
      `CAST(strftime('%s', i.closed_date) AS INTEGER) * 1000 + ${HALF_DAY}), i.kind, i.id, NULL, NULL, NULL, ` +
      "0, i.owner, i.pipeline_id FROM items i WHERE i.status IN ('won', 'lost') " +
      "AND i.closed_date BETWEEN ?8 AND ?9",
    "SELECT 'owner_changed', CAST(json_extract(r.fields, '$.at') AS INTEGER), i.kind, i.id, r.id, NULL, NULL, 0, " +
      "json_extract(r.fields, '$.to'), i.pipeline_id FROM records r " +
      "JOIN record_relations rr ON rr.record_id = r.id AND rr.role = 'on' " +
      "JOIN items i ON i.kind = rr.target_type AND i.external_id = rr.target_external_id " +
      "WHERE r.account_id = ?1 AND r.type = ?3 AND r.deleted_at IS NULL " +
      "AND json_extract(r.fields, '$.at') BETWEEN ?6 AND ?7",
    ...(["created_at", "done_at"] as const).map(
      (field) =>
        `SELECT '${field === "created_at" ? "activity_added" : "activity_done"}', ` +
        `CAST(json_extract(a.fields, '$.${field}') AS INTEGER), coalesce(substr(a.item, 1, instr(a.item, ':') - 1), a.target), ` +
        "CAST(substr(a.item, instr(a.item, ':') + 1) AS INTEGER), a.id, NULL, NULL, 0, " +
        "coalesce((SELECT owner FROM items i WHERE i.kind || ':' || i.id = a.item), " +
        "json_extract(a.fields, '$.assignee')), (SELECT pipeline_id FROM items i WHERE i.kind || ':' || i.id = a.item) " +
        `FROM (SELECT r.id, r.fields, ${itemOf("r.id")} AS item, (SELECT target_type FROM record_relations ` +
        "WHERE record_id = r.id AND role = 'on' LIMIT 1) AS target FROM records r WHERE r.account_id = ?1 " +
        `AND r.type = ?4 AND r.deleted_at IS NULL AND json_extract(r.fields, '$.${field}') ` +
        "BETWEEN ?6 AND ?7) a",
    ),
    "SELECT 'person_added', CAST(json_extract(r.fields, '$.created_at') AS INTEGER), 'person', NULL, r.id, NULL, " +
      "NULL, 0, json_extract(r.fields, '$.assignee'), NULL FROM records r WHERE r.account_id = ?1 " +
      "AND r.type = ?5 AND r.deleted_at IS NULL AND json_extract(r.fields, '$.created_at') BETWEEN ?6 AND ?7",
  ]
  const where = [
    ...(filter.changes?.length ? ["change IN (SELECT value FROM json_each(?10))"] : []),
    ...(filter.owner === undefined ? [] : [filter.owner === null ? "owner IS NULL" : "owner = ?11"]),
    ...(filter.pipeline === undefined ? [] : ["pipeline_id = ?12"]),
  ]
  const rows = database
    .prepare(
      `WITH items AS (${items("deals", "deal")} UNION ALL ${items("leads", "lead")}), entries AS (${entries}) ` +
        `SELECT * FROM (${parts.join(" UNION ALL ")}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
        "ORDER BY at DESC, change, item DESC, record DESC LIMIT ?13 OFFSET ?14",
    )
    .all(
      accountId,
      STAGE_ENTRY_RECORD,
      OWNER_CHANGE_RECORD,
      ACTIVITY_RECORD,
      PERSON_RECORD,
      filter.since,
      filter.until,
      dayIn(filter.since, filter.zone),
      dayIn(filter.until, filter.zone),
      filter.changes?.length ? JSON.stringify(filter.changes) : null,
      filter.owner ?? null,
      filter.pipeline ?? null,
      filter.limit + 1,
      filter.offset,
    )
  const stageName = database.prepare("SELECT name FROM pipeline_stages WHERE id = ?")
  const nameOf = (id: unknown) =>
    id == null ? null : ((stageName.get(Number(id))?.name as string | undefined) ?? null)
  const itemRow = (kind: string, id: unknown) =>
    id == null || (kind !== "deal" && kind !== "lead")
      ? undefined
      : database
          .prepare(
            "SELECT d.external_id, d.title, d.currency, d.amount, json_extract(d.metadata, '$.closed_reason') AS reason, " +
              `p.id AS pipeline, p.name AS pipeline_name FROM ${kind === "deal" ? "deals" : "leads"} d ` +
              "JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = s.pipeline_id WHERE d.id = ?",
          )
          .get(Number(id))
  const recordRow = database.prepare("SELECT external_id, fields FROM records WHERE id = ?")
  return {
    hasMore: rows.length > filter.limit,
    items: rows.slice(0, filter.limit).map((row): CrmChange => {
      const change = row.change as CrmChangeKind
      const item = itemRow(String(row.kind), row.item)
      const record = row.record == null ? undefined : recordRow.get(Number(row.record))
      const fields = record ? (JSON.parse(String(record.fields)) as Record<string, unknown>) : {}
      const activity = change === "activity_added" || change === "activity_done"
      const person = change === "person_added"
      const currency = (item?.currency as string | null | undefined) ?? null
      return {
        change,
        at: Number(row.at),
        kind: row.kind as CrmKind,
        ref: item ? `${String(row.kind)}:${String(row.item)}` : null,
        externalId: String(item?.external_id ?? record?.external_id ?? ""),
        title: item ? String(item.title) : person ? ((fields.name as string | null) ?? null) : null,
        pipeline: item ? `pipeline:${String(item.pipeline)}` : null,
        pipelineName: item ? String(item.pipeline_name) : null,
        from: change === "owner_changed" ? ((fields.from as string | null) ?? null) : nameOf(row.from_id),
        to: change === "owner_changed" ? ((fields.to as string | null) ?? null) : nameOf(row.to_id),
        amount:
          item?.amount == null || currency === null ? null : formatDecimal(Number(item.amount), scaleOf(currency)),
        currency,
        exact: row.exact === 1,
        reason: change === "lost" ? ((item?.reason as string | null | undefined) ?? null) : null,
        owner: (row.owner as string | null) ?? null,
        activity: activity
          ? {
              externalId: String(record?.external_id),
              kind: fields.kind as CrmActivityKind,
              subject: String(fields.subject ?? ""),
              dueAt: (fields.due_at as number | null) ?? null,
              done: fields.done === true,
            }
          : null,
      }
    }),
  }
}

/** The pages `activities list`, `changes list` and the digest read of one account's copy. */
export interface CrmReads {
  /** One page of the account's activities: open ones first by due time, then the rest, newest first. */
  activities(key: AccountKey, filter: ActivityFilter): Promise<{ items: ListedActivity[]; hasMore: boolean }>
  /** One page of what changed in the account's copy in a window, newest first (`crmChanges`). */
  changes(key: AccountKey, filter: ChangeFilter): Promise<{ items: CrmChange[]; hasMore: boolean }>
}

export const crmReadsOver = (context: StoreContext): CrmReads => {
  const activities = crmActivitiesOver(context)
  return {
    activities: async (key, filter) => activities.list(key, filter),
    changes: async (key, filter) => crmChanges(context, key, filter),
  }
}
