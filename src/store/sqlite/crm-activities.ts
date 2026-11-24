import type { CrmActivity, CrmActivityKind, CrmKind } from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import { recordFingerprint } from "../../domain/records.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { type CopyViewer, viewerSql } from "./copy-viewer.js"
import { ACTIVITY_RECORD, dropCrmActivityChunks, rechunkCrmActivities } from "./crm-activity-chunks.js"
import { crmAccountPrefix, crmIdentityId, SOURCE, TABLES, textOf } from "./crm-rows.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export { ACTIVITY_RECORD }

/**
 * Marks deleted the activities on nothing but these contacts or companies: their subject and body leave the copy with
 * the rows they were on. Answers how many.
 */
export const forgetActivitiesOn = (
  database: CacheDatabase,
  accountId: number,
  kind: "person" | "organization",
  externalIds: readonly string[],
  at: number,
): number => {
  const removed = "rr.target_type = ? AND rr.target_external_id IN (SELECT value FROM json_each(?))"
  const ids = JSON.stringify(externalIds)
  const forgotten = database
    .prepare(
      "UPDATE records SET deleted_at = ? WHERE account_id = ? AND type = ? AND deleted_at IS NULL " +
        `AND EXISTS (SELECT 1 FROM record_relations rr WHERE rr.record_id = records.id AND rr.role = 'on' AND ${removed}) ` +
        "AND NOT EXISTS (SELECT 1 FROM record_relations rr WHERE rr.record_id = records.id AND rr.role = 'on' " +
        `AND NOT (${removed})) RETURNING id`,
    )
    .all(at, accountId, ACTIVITY_RECORD, kind, ids, kind, ids)
    .map(({ id }) => Number(id))
  dropCrmActivityChunks(database, forgotten)
  return forgotten.length
}

/** A CRM's text field holds what people typed or pasted, a whole e-mail thread too. */
const MOST_BODY = 20_000
const MOST_SUBJECT = 500
/** The kinds that record something already done rather than ask for it. */
const LOGGED: ReadonlySet<CrmActivityKind> = new Set(["comment", "call", "email", "meeting"])

/** One activity as `deals show` lists it. */
export interface StoredActivity {
  externalId: string
  kind: CrmActivityKind
  subject: string
  body: string | null
  dueAt: number | null
  done: boolean
  /** The identity `<account>/user/<id>`, as a deal's assignee. */
  assignee: string | null
  createdAt: number
  updatedAt: number
}

const activityOf = (externalId: string, fields: Record<string, unknown>): StoredActivity => ({
  externalId,
  kind: fields.kind as CrmActivityKind,
  subject: String(fields.subject ?? ""),
  body: (fields.body as string | null) ?? null,
  dueAt: (fields.due_at as number | null) ?? null,
  done: fields.done === true,
  assignee: (fields.assignee as string | null) ?? null,
  createdAt: Number(fields.created_at),
  updatedAt: Number(fields.updated_at),
})

/** What `activities list` narrows by; every bound is inclusive epoch ms. */
export interface ActivityFilter {
  status?: "open" | "done"
  due?: { since?: number; until?: number }
  /** Open and due before this moment. */
  overdueAt?: number
  kinds?: readonly CrmActivityKind[]
  /** On this deal, lead, contact or company, by the store's reference (`deal:12`, `person:4`, `organization:3`). */
  on?: string
  /** The identity `<account>/user/<id>` it is assigned to; `null` is none. */
  owner?: string | null
  /**
   * A profile that may read only part of the copy (SEC-197): the activities on its deals and leads, and those on
   * contacts or companies alone that are assigned to it. A hidden deal or lead is never named in `on`.
   */
  viewer?: CopyViewer
  /** 1–500. */
  limit: number
  offset: number
}

/** One row the activity is on, with the store's reference and title when the copy holds it. */
export interface ActivityTarget {
  kind: CrmKind
  externalId: string
  ref: string | null
  title: string | null
}

export interface ListedActivity extends StoredActivity {
  doneAt: number | null
  on: ActivityTarget[]
}

/** The subjects and texts of the activities on each deal or lead of a kind, by `<account id>\u0000<external id>`. */
export const activityTexts = (database: StoreContext["database"], kind: DealKind): Map<string, string[]> => {
  const found = new Map<string, string[]>()
  for (const row of database
    .prepare(
      "SELECT r.account_id, rr.target_external_id, json_extract(r.fields, '$.subject') AS subject, " +
        "json_extract(r.fields, '$.body') AS body FROM records r JOIN record_relations rr ON rr.record_id = r.id " +
        "WHERE r.type = ? AND r.deleted_at IS NULL AND rr.role = 'on' AND rr.target_type = ?",
    )
    .all(ACTIVITY_RECORD, kind)) {
    const key = `${row.account_id}\u0000${row.target_external_id}`
    const texts = found.get(key) ?? []
    found.set(key, texts)
    for (const text of [row.subject, row.body]) if (typeof text === "string" && text) texts.push(text)
  }
  return found
}

export interface CrmActivitiesSaved {
  saved: number
  /** On no deal, lead, contact or company this copy keeps, so not stored. */
  outOfScope: number
}

export const crmActivitiesOver = (context: StoreContext) => {
  const { database, now } = context

  /** A deal or lead the copy keeps, a contact it holds, or a company it keeps. */
  const kept = (key: AccountKey, accountId: number, kind: CrmKind, externalId: string): boolean =>
    (kind === "person"
      ? database
          .prepare("SELECT 1 FROM identities WHERE provider = ? AND external_id = ?")
          .get(key.provider, crmIdentityId(key, externalId))
      : kind === "organization"
        ? database
            .prepare(
              "SELECT 1 FROM records WHERE account_id = ? AND type = 'organization' AND external_id = ? " +
                "AND deleted_at IS NULL",
            )
            .get(accountId, externalId)
        : database
            .prepare(`SELECT 1 FROM ${TABLES[kind]} WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL`)
            .get(accountId, externalId)) !== undefined

  /**
   * When it was done, as near as the copy can tell: the CRM's change that closed it, kept once seen. A record of
   * something already done — a comment, a logged call, mail or meeting — that arrives done with no due date was done
   * when it was made, and `changes list` lists it once. A task or to-do may be closed long after it was made, often
   * with no deadline in Bitrix24, so it keeps the CRM's change.
   */
  const doneAt = (activity: CrmActivity, held: Record<string, unknown> | undefined): number | null => {
    if (!activity.done) return null
    if (held?.done) return (held.done_at as number | null) ?? null
    return held === undefined && activity.dueAt == null && LOGGED.has(activity.kind)
      ? activity.createdAt
      : activity.updatedAt
  }
  const save = (key: AccountKey, activities: readonly CrmActivity[]): CrmActivitiesSaved =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const at = now()
      let saved = 0
      let outOfScope = 0
      for (const activity of activities) {
        const on = activity.on.filter((one) => kept(key, accountId, one.kind, one.externalId))
        const held = database
          .prepare(
            "SELECT id, json_extract(fields, '$.done') AS done, json_extract(fields, '$.done_at') AS done_at " +
              "FROM records WHERE account_id = ? AND type = ? AND external_id = ?",
          )
          .get(accountId, ACTIVITY_RECORD, activity.externalId)
        if (on.length === 0) {
          // It left every kept deal: one stored before goes with it.
          if (held) {
            database.prepare("UPDATE records SET deleted_at = ? WHERE id = ?").run(at, Number(held.id))
            dropCrmActivityChunks(database, [Number(held.id)])
          }
          outOfScope += 1
          continue
        }
        const fields = {
          kind: activity.kind,
          subject: textOf(activity.subject, MOST_SUBJECT) ?? "",
          body: textOf(activity.body, MOST_BODY),
          due_at: activity.dueAt ?? null,
          done: activity.done,
          done_at: doneAt(activity, held),
          assignee: activity.assignee ? crmIdentityId(key, activity.assignee, "user") : null,
          created_at: activity.createdAt,
          updated_at: activity.updatedAt,
        }
        const relations = on.map((one) => ({ role: "on", type: one.kind, external_id: one.externalId }))
        const fingerprint = recordFingerprint(fields, relations)
        let id: number
        if (held) {
          id = Number(held.id)
          database
            .prepare(
              "UPDATE records SET fields = ?, fingerprint = ?, batch_id = ?, updated_at = ?, deleted_at = NULL " +
                "WHERE id = ?",
            )
            .run(JSON.stringify(fields), fingerprint, SOURCE, at, id)
          database.prepare("DELETE FROM record_relations WHERE record_id = ?").run(id)
        } else
          id = Number(
            database
              .prepare(
                "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, created_at, " +
                  "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
              )
              .get(accountId, ACTIVITY_RECORD, activity.externalId, JSON.stringify(fields), fingerprint, SOURCE, at, at)
              ?.id,
          )
        for (const one of on)
          database
            .prepare(
              "INSERT INTO record_relations (record_id, role, target_type, target_external_id, created_at) " +
                "VALUES (?, 'on', ?, ?, ?)",
            )
            .run(id, one.kind, one.externalId, at)
        rechunkCrmActivities(database, [id], at)
        saved += 1
      }
      return { saved, outOfScope }
    })

  /** The activities on one deal or lead: open ones first by due time, then the rest, newest first. */
  const of = (key: AccountKey, kind: DealKind, externalId: string, limit: number): StoredActivity[] => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return []
    return database
      .prepare(
        "SELECT r.external_id, r.fields FROM records r JOIN record_relations rr ON rr.record_id = r.id " +
          "WHERE r.account_id = ? AND r.type = ? AND r.deleted_at IS NULL AND rr.role = 'on' " +
          "AND rr.target_type = ? AND rr.target_external_id = ? " +
          "ORDER BY json_extract(r.fields, '$.done') ASC, " +
          "CASE WHEN json_extract(r.fields, '$.done') THEN NULL ELSE json_extract(r.fields, '$.due_at') END ASC, " +
          "json_extract(r.fields, '$.updated_at') DESC LIMIT ?",
      )
      .all(accountId, ACTIVITY_RECORD, kind, externalId, limit)
      .map((row) => activityOf(String(row.external_id), JSON.parse(String(row.fields)) as Record<string, unknown>))
  }

  /** The CRM ids of the activity targets a store reference names in this account, by kind. */
  const targetOf = (
    key: AccountKey,
    accountId: number,
    ref: string,
    viewer: CopyViewer | undefined,
  ): { kind: CrmKind; ids: string } => {
    const [type = "", id = ""] = ref.split(":")
    const one = (sql: string, ...params: (string | number)[]) =>
      JSON.stringify(
        database
          .prepare(sql)
          .all(...params)
          .map((row) => String(row.id)),
      )
    if (type === "deal" || type === "lead") {
      const seen = viewerSql(TABLES[type], viewer)
      return {
        kind: type,
        ids: one(
          `SELECT external_id AS id FROM ${TABLES[type]} WHERE account_id = ? AND id = ? AND ${seen.sql}`,
          accountId,
          Number(id),
          ...seen.params,
        ),
      }
    }
    if (type === "organization")
      return {
        kind: type,
        ids: one(
          "SELECT external_id AS id FROM records WHERE account_id = ? AND type = 'organization' " +
            "AND entity_type = 'organization' AND entity_id = ? AND deleted_at IS NULL",
          accountId,
          Number(id),
        ),
      }
    const prefix = `${crmAccountPrefix(key)}contact/`
    return {
      kind: "person",
      ids: one(
        "SELECT substr(i.external_id, ?) AS id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
          "WHERE i.provider = ? AND substr(i.external_id, 1, ?) = ? AND l.person_id = ?",
        prefix.length + 1,
        key.provider,
        prefix.length,
        prefix,
        Number(id),
      ),
    }
  }

  const targets = (
    key: AccountKey,
    accountId: number,
    recordId: number,
    viewer: CopyViewer | undefined,
  ): ActivityTarget[] =>
    database
      .prepare("SELECT target_type, target_external_id FROM record_relations WHERE record_id = ? AND role = 'on'")
      .all(recordId)
      .map((row) => {
        const kind = String(row.target_type) as CrmKind
        const externalId = String(row.target_external_id)
        const found =
          kind === "deal" || kind === "lead"
            ? database
                .prepare(
                  `SELECT '${kind}:' || id AS ref, title FROM ${TABLES[kind]} d WHERE account_id = ? ` +
                    `AND external_id = ? AND ${viewerSql("d", viewer).sql}`,
                )
                .get(accountId, externalId, ...viewerSql("d", viewer).params)
            : kind === "organization"
              ? database
                  .prepare(
                    "SELECT 'organization:' || o.id AS ref, o.name AS title FROM records r " +
                      "JOIN organizations o ON o.id = r.entity_id WHERE r.account_id = ? AND r.type = 'organization' " +
                      "AND r.entity_type = 'organization' AND r.external_id = ?",
                  )
                  .get(accountId, externalId)
              : database
                  .prepare(
                    "SELECT 'person:' || l.person_id AS ref, coalesce(p.name, i.name) AS title FROM identities i " +
                      "LEFT JOIN identity_links l ON l.identity_id = i.id LEFT JOIN persons p ON p.id = l.person_id " +
                      "WHERE i.provider = ? AND i.external_id = ?",
                  )
                  .get(key.provider, crmIdentityId(key, externalId))
        return {
          kind,
          externalId,
          ref: found?.ref == null ? null : String(found.ref),
          title: found?.title == null ? null : String(found.title),
        }
      })

  const field = (name: string) => `json_extract(r.fields, '$.${name}')`
  const whereOf = (key: AccountKey, accountId: number, filter: Omit<ActivityFilter, "limit" | "offset">) => {
    const where: { sql: string; params: (string | number)[] }[] = []
    if (filter.status) where.push({ sql: `${field("done")} = ?`, params: [filter.status === "done" ? 1 : 0] })
    if (filter.due?.since !== undefined) where.push({ sql: `${field("due_at")} >= ?`, params: [filter.due.since] })
    if (filter.due?.until !== undefined) where.push({ sql: `${field("due_at")} <= ?`, params: [filter.due.until] })
    if (filter.overdueAt !== undefined)
      where.push({ sql: `${field("done")} = 0 AND ${field("due_at")} < ?`, params: [filter.overdueAt] })
    if (filter.kinds?.length)
      where.push({
        sql: `${field("kind")} IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(filter.kinds)],
      })
    if (filter.owner !== undefined)
      where.push(
        filter.owner === null
          ? { sql: `${field("assignee")} IS NULL`, params: [] }
          : { sql: `${field("assignee")} = ?`, params: [filter.owner] },
      )
    if (filter.on !== undefined) {
      const target = targetOf(key, accountId, filter.on, filter.viewer)
      where.push({
        sql:
          "EXISTS (SELECT 1 FROM record_relations rr WHERE rr.record_id = r.id AND rr.role = 'on' " +
          "AND rr.target_type = ? AND rr.target_external_id IN (SELECT value FROM json_each(?)))",
        params: [target.kind, target.ids],
      })
    }
    if (filter.viewer) where.push(seenSql(filter.viewer))
    return where
  }

  /** One page of the account's activities: open ones first, overdue before undated, then the rest, newest first. */
  const list = (key: AccountKey, filter: ActivityFilter): { items: ListedActivity[]; hasMore: boolean } => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return { items: [], hasMore: false }
    const where = whereOf(key, accountId, filter)
    const open = `CASE WHEN ${field("done")} THEN NULL ELSE ${field("due_at")} END`
    const rows = database
      .prepare(
        "SELECT r.id, r.external_id, r.fields FROM records r WHERE r.account_id = ? AND r.type = ? " +
          `AND r.deleted_at IS NULL ${where.map(({ sql }) => `AND ${sql}`).join(" ")} ` +
          `ORDER BY ${field("done")} ASC, ${field("done")} = 0 AND ${field("due_at")} IS NULL, ${open} ASC, ` +
          `${field("updated_at")} DESC, r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(accountId, ACTIVITY_RECORD, ...where.flatMap(({ params }) => params), filter.limit + 1, filter.offset)
    return {
      hasMore: rows.length > filter.limit,
      items: rows.slice(0, filter.limit).map((row) => {
        const fields = JSON.parse(String(row.fields)) as Record<string, unknown>
        return {
          ...activityOf(String(row.external_id), fields),
          doneAt: (fields.done_at as number | null) ?? null,
          on: targets(key, accountId, Number(row.id), filter.viewer),
        }
      }),
    }
  }

  /** How many activities `filter` matches, every page together. */
  const count = (key: AccountKey, filter: Omit<ActivityFilter, "limit" | "offset">): number => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return 0
    const where = whereOf(key, accountId, filter)
    return Number(
      database
        .prepare(
          "SELECT count(*) AS n FROM records r WHERE r.account_id = ? AND r.type = ? AND r.deleted_at IS NULL " +
            where.map(({ sql }) => `AND ${sql}`).join(" "),
        )
        .get(accountId, ACTIVITY_RECORD, ...where.flatMap(({ params }) => params))?.n ?? 0,
    )
  }

  return { save, of, list, count }
}

/** An activity a viewer may read: on one of its deals or leads, or on contacts alone and assigned to it. */
const seenSql = (viewer: CopyViewer): { sql: string; params: string[] } => {
  if (viewer.assignee === null) return { sql: "0", params: [] }
  const on = (table: string, kind: string) =>
    `EXISTS (SELECT 1 FROM record_relations rr JOIN ${table} d ON d.account_id = r.account_id ` +
    "AND d.external_id = rr.target_external_id AND d.deleted_at IS NULL " +
    `WHERE rr.record_id = r.id AND rr.role = 'on' AND rr.target_type = '${kind}' ` +
    "AND json_extract(d.metadata, '$.assignee') = ?)"
  return {
    sql:
      `(${on("deals", "deal")} OR ${on("leads", "lead")} OR (NOT EXISTS (SELECT 1 FROM record_relations rr ` +
      "WHERE rr.record_id = r.id AND rr.role = 'on' AND rr.target_type IN ('deal', 'lead')) " +
      "AND json_extract(r.fields, '$.assignee') = ?))",
    params: [viewer.assignee, viewer.assignee, viewer.assignee],
  }
}
