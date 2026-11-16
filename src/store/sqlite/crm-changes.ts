import type { CrmActivityKind, CrmKind } from "../../domain/crm.js"
import { formatDecimal, scaleOf } from "../../domain/money.js"
import type { AccountKey } from "../types.js"
import { findAccountPk } from "./accounts.js"
import type { CopyViewer } from "./copy-viewer.js"
import { ACTIVITY_RECORD, type ActivityFilter, crmActivitiesOver, type ListedActivity } from "./crm-activities.js"
import { crmAccountPrefix, OWNER_CHANGE_RECORD, PERSON_RECORD } from "./crm-rows.js"
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
  changes?: readonly CrmChangeKind[]
  /** The identity `<account>/user/<id>`; `null` is none. */
  owner?: string | null
  /** A pipeline's store id: only the changes of its deals or leads. */
  pipeline?: number
  /**
   * A profile that may read only part of the copy (SEC-197): the deals and leads assigned to it, the activities on
   * them, and the contacts linked to them or assigned to it.
   */
  viewer?: CopyViewer
  limit: number
  offset: number
}

const HALF_DAY = 43_200_000
const DAY = 86_400_000
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10)

/**
 * `sql` with each `?N` as a plain `?`, and its values in the order they appear. node:sqlite before Node 22.23 binds
 * no `?N` from a list of values ("column index out of range"), and every version refuses a value the SQL never uses.
 */
export const usedParams = <T>(sql: string, params: readonly T[]): { sql: string; params: T[] } => ({
  sql: sql.replace(/\?\d+/g, "?"),
  params: [...sql.matchAll(/\?(\d+)/g)].map((one) => params[Number(one[1]) - 1] as T),
})

/** The SQL of every change in `filter`'s window, unordered, and its numbered parameters (`?13`, `?14` page it). */
const changesQuery = (context: StoreContext, key: AccountKey, filter: ChangeFilter) => {
  const accountId = findAccountPk(context, key)
  if (accountId === undefined) return undefined
  // ?15 is set when a viewer limits the read, ?16 its assignee; `= NULL` then hides every row.
  const items = (table: string, kind: string) =>
    `SELECT '${kind}' AS kind, d.id, d.external_id, d.status, d.created_at, d.closed_date, ` +
    `json_extract(d.metadata, '$.assignee') AS owner, s.pipeline_id FROM ${table} d ` +
    "JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.account_id = ?1 AND d.deleted_at IS NULL " +
    "AND (?15 IS NULL OR json_extract(d.metadata, '$.assignee') = ?16)"
  const entries =
    "SELECT r.id AS record, i.kind, i.id AS item, i.owner, i.pipeline_id, " +
    "CAST(json_extract(r.fields, '$.at') AS INTEGER) AS at, CAST(json_extract(r.fields, '$.stage_id') AS INTEGER) AS stage, " +
    "lag(CAST(json_extract(r.fields, '$.stage_id') AS INTEGER)) OVER (PARTITION BY i.kind, i.id " +
    "ORDER BY json_extract(r.fields, '$.at'), r.id) AS before FROM records r " +
    "JOIN record_relations rr ON rr.record_id = r.id AND rr.role = 'on' " +
    "JOIN items i ON i.kind = rr.target_type AND i.external_id = rr.target_external_id " +
    "WHERE r.account_id = ?1 AND r.type = ?2 AND r.deleted_at IS NULL"
  const closing = "(SELECT outcome FROM pipeline_stages WHERE id = m.stage) IN ('won', 'lost')"
  const itemOf = (record: string) =>
    "(SELECT i.kind || ':' || i.id FROM record_relations rr JOIN items i ON i.kind = rr.target_type " +
    `AND i.external_id = rr.target_external_id WHERE rr.record_id = ${record} AND rr.role = 'on' LIMIT 1)`
  const closedAt =
    "(SELECT max(m.at) FROM entries m WHERE m.kind = i.kind AND m.item = i.id " +
    "AND (SELECT outcome FROM pipeline_stages WHERE id = m.stage) = i.status)"
  const onDealOrLead =
    "EXISTS (SELECT 1 FROM record_relations x WHERE x.record_id = a.id AND x.role = 'on' " +
    "AND x.target_type IN ('deal', 'lead'))"
  const linkedToSeen =
    "EXISTS (SELECT 1 FROM identities n JOIN identity_links l ON l.identity_id = n.id " +
    "JOIN links k ON k.to_type = 'person' AND k.to_id = l.person_id AND k.deleted_at IS NULL " +
    "JOIN items v ON v.kind = k.from_type AND v.id = k.from_id WHERE n.provider = ?17 AND n.external_id = ?18 || r.external_id)"
  const parts = [
    "SELECT 'created' AS change, created_at AS at, kind, id AS item, NULL AS record, NULL AS from_id, NULL AS to_id, " +
      "0 AS exact, owner, pipeline_id FROM items",
    `SELECT 'moved', m.at, m.kind, m.item, m.record, m.before, m.stage, 1, m.owner, m.pipeline_id FROM entries m ` +
      `WHERE m.before IS NOT NULL AND NOT ${closing}`,
    "SELECT 'moved', c.changed_at, i.kind, i.id, NULL, c.from_stage_id, c.to_stage_id, 0, i.owner, i.pipeline_id " +
      "FROM pipeline_stage_changes c JOIN items i ON i.kind = c.item_type AND i.id = c.item_id " +
      "WHERE c.from_stage_id IS NOT NULL AND c.changed_at BETWEEN ?6 AND ?7 " +
      "AND (SELECT outcome FROM pipeline_stages WHERE id = c.to_stage_id) NOT IN ('won', 'lost') " +
      // The CRM's own entry of this move replaces it; an entry with no earlier one in the copy cannot say where from.
      "AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.kind = i.kind AND e.item = i.id " +
      "AND e.stage = c.to_stage_id AND e.before IS NOT NULL)",
    // The closed day only narrows the rows; the window is checked on `at`, so a deal is listed in one window only.
    `SELECT i.status, coalesce(${closedAt}, CAST(strftime('%s', i.closed_date) AS INTEGER) * 1000 + ${HALF_DAY}), ` +
      `i.kind, i.id, NULL, NULL, NULL, ${closedAt} IS NOT NULL, i.owner, i.pipeline_id FROM items i ` +
      "WHERE i.status IN ('won', 'lost') AND i.closed_date BETWEEN ?8 AND ?9",
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
        "BETWEEN ?6 AND ?7" +
        // One that arrived done with no due date was done as it was made: its `activity_added` says it.
        (field === "done_at"
          ? " AND NOT (json_extract(r.fields, '$.due_at') IS NULL AND " +
            "json_extract(r.fields, '$.done_at') = json_extract(r.fields, '$.created_at'))"
          : "") +
        ") a " +
        // A viewer reads an activity on its own deal or lead, or one on contacts alone that is assigned to it.
        `WHERE ?15 IS NULL OR a.item IS NOT NULL OR (NOT ${onDealOrLead} AND json_extract(a.fields, '$.assignee') = ?16)`,
    ),
    "SELECT 'person_added', CAST(json_extract(r.fields, '$.created_at') AS INTEGER), 'person', NULL, r.id, NULL, " +
      "NULL, 0, json_extract(r.fields, '$.assignee'), NULL FROM records r WHERE r.account_id = ?1 " +
      "AND r.type = ?5 AND r.deleted_at IS NULL AND json_extract(r.fields, '$.created_at') BETWEEN ?6 AND ?7 " +
      `AND (?15 IS NULL OR json_extract(r.fields, '$.assignee') = ?16 OR ${linkedToSeen})`,
  ]
  const where = [
    "at BETWEEN ?6 AND ?7",
    ...(filter.changes?.length ? ["change IN (SELECT value FROM json_each(?10))"] : []),
    ...(filter.owner === undefined ? [] : [filter.owner === null ? "owner IS NULL" : "owner = ?11"]),
    ...(filter.pipeline === undefined ? [] : ["pipeline_id = ?12"]),
  ]
  return {
    sql:
      `WITH items AS (${items("deals", "deal")} UNION ALL ${items("leads", "lead")}), entries AS (${entries}) ` +
      `SELECT * FROM (${parts.join(" UNION ALL ")}) WHERE ${where.join(" AND ")}`,
    params: [
      accountId,
      STAGE_ENTRY_RECORD,
      OWNER_CHANGE_RECORD,
      ACTIVITY_RECORD,
      PERSON_RECORD,
      filter.since,
      filter.until,
      // A day without a time is taken at its noon in UTC, which is never more than a day from the window's days.
      utcDay(filter.since - DAY),
      utcDay(filter.until + DAY),
      filter.changes?.length ? JSON.stringify(filter.changes) : null,
      filter.owner ?? null,
      filter.pipeline ?? null,
      filter.limit + 1,
      filter.offset,
      filter.viewer ? 1 : null,
      filter.viewer?.assignee ?? null,
      key.provider,
      `${crmAccountPrefix(key)}contact/`,
    ],
  }
}

/** How many changes of each kind `filter`'s window holds, every page together. */
export const crmChangeCounts = (
  context: StoreContext,
  key: AccountKey,
  filter: Omit<ChangeFilter, "limit" | "offset">,
): Record<CrmChangeKind, number> => {
  const counts = Object.fromEntries(CRM_CHANGES.map((one) => [one, 0])) as Record<CrmChangeKind, number>
  const query = changesQuery(context, key, { ...filter, limit: 0, offset: 0 })
  if (!query) return counts
  const counted = usedParams(`SELECT change, count(*) AS n FROM (${query.sql}) GROUP BY change`, query.params)
  for (const row of context.database.prepare(counted.sql).all(...counted.params))
    counts[row.change as CrmChangeKind] = Number(row.n)
  return counts
}

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
  const query = changesQuery(context, key, filter)
  if (!query) return { items: [], hasMore: false }
  const paged = usedParams(
    `${query.sql} ORDER BY at DESC, change, kind, item DESC, record DESC LIMIT ?13 OFFSET ?14`,
    query.params,
  )
  const rows = database.prepare(paged.sql).all(...paged.params)
  const stageName = database.prepare("SELECT name FROM pipeline_stages WHERE id = ?")
  const nameOf = (id: unknown) =>
    id == null ? null : ((stageName.get(Number(id))?.name as string | undefined) ?? null)
  const itemStatements = Object.fromEntries(
    (["deal", "lead"] as const).map((kind) => [
      kind,
      database.prepare(
        "SELECT d.external_id, d.title, d.currency, d.amount, json_extract(d.metadata, '$.closed_reason') AS reason, " +
          `p.id AS pipeline, p.name AS pipeline_name FROM ${kind === "deal" ? "deals" : "leads"} d ` +
          "JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = s.pipeline_id WHERE d.id = ?",
      ),
    ]),
  )
  const itemRow = (kind: string, id: unknown) =>
    id == null || (kind !== "deal" && kind !== "lead") ? undefined : itemStatements[kind]?.get(Number(id))
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
  /** How many activities a filter matches, every page together. */
  activityCount(key: AccountKey, filter: Omit<ActivityFilter, "limit" | "offset">): Promise<number>
  /** One page of what changed in the account's copy in a window, newest first (`crmChanges`). */
  changes(key: AccountKey, filter: ChangeFilter): Promise<{ items: CrmChange[]; hasMore: boolean }>
  /** How many changes of each kind a window holds (`crmChangeCounts`). */
  changeCounts(key: AccountKey, filter: Omit<ChangeFilter, "limit" | "offset">): Promise<Record<CrmChangeKind, number>>
}

export const crmReadsOver = (context: StoreContext): CrmReads => {
  const activities = crmActivitiesOver(context)
  return {
    activities: async (key, filter) => activities.list(key, filter),
    activityCount: async (key, filter) => activities.count(key, filter),
    changes: async (key, filter) => crmChanges(context, key, filter),
    changeCounts: async (key, filter) => crmChangeCounts(context, key, filter),
  }
}
