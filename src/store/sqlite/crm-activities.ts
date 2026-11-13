import type { CrmActivity, CrmActivityKind } from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import { recordFingerprint } from "../../domain/records.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { crmIdentityId, SOURCE, TABLES, textOf } from "./crm-rows.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export const ACTIVITY_RECORD = "crm.activity"

/** A CRM's text field holds what people typed or pasted, a whole e-mail thread too. */
const MOST_BODY = 20_000
const MOST_SUBJECT = 500

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
  /** On no deal or lead this copy keeps, so not stored. */
  outOfScope: number
}

export const crmActivitiesOver = (context: StoreContext) => {
  const { database, now } = context

  const kept = (accountId: number, kind: DealKind, externalId: string): boolean =>
    database
      .prepare(`SELECT 1 FROM ${TABLES[kind]} WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL`)
      .get(accountId, externalId) !== undefined

  const save = (key: AccountKey, activities: readonly CrmActivity[]): CrmActivitiesSaved =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const at = now()
      let saved = 0
      let outOfScope = 0
      for (const activity of activities) {
        const on = activity.on.filter((one) => kept(accountId, one.kind, one.externalId))
        const held = database
          .prepare("SELECT id FROM records WHERE account_id = ? AND type = ? AND external_id = ?")
          .get(accountId, ACTIVITY_RECORD, activity.externalId)
        if (on.length === 0) {
          // It left every kept deal: one stored before goes with it.
          if (held) database.prepare("UPDATE records SET deleted_at = ? WHERE id = ?").run(at, Number(held.id))
          outOfScope += 1
          continue
        }
        const fields = {
          kind: activity.kind,
          subject: textOf(activity.subject, MOST_SUBJECT) ?? "",
          body: textOf(activity.body, MOST_BODY),
          due_at: activity.dueAt ?? null,
          done: activity.done,
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
      .map((row) => {
        const fields = JSON.parse(String(row.fields)) as Record<string, unknown>
        return {
          externalId: String(row.external_id),
          kind: fields.kind as CrmActivityKind,
          subject: String(fields.subject ?? ""),
          body: (fields.body as string | null) ?? null,
          dueAt: (fields.due_at as number | null) ?? null,
          done: fields.done === true,
          assignee: (fields.assignee as string | null) ?? null,
          createdAt: Number(fields.created_at),
          updatedAt: Number(fields.updated_at),
        }
      })
  }

  return { save, of }
}
