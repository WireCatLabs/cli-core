import type { CrmStageEntry } from "../../domain/crm.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { SOURCE, TABLES } from "./crm-rows.js"
import type { CrmStageMove } from "./crm-settings.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export const STAGE_ENTRY_RECORD = "crm.stage-entry"

/**
 * The CRM's own record of each stage a deal or lead entered, kept until its stage task is handled: a run stopped
 * between reading the history and opening the tasks opens them next time. A handled entry stays, marked deleted, so
 * reading the same history again opens nothing.
 */
export const crmStageEntriesOver = (context: StoreContext) => {
  const { database, now } = context

  /** Answers how many were new; an entry on a deal or lead the copy does not hold, or into an unknown stage, is not. */
  const save = (key: AccountKey, entries: readonly CrmStageEntry[]): number =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const at = now()
      let saved = 0
      for (const entry of entries) {
        const item = database
          .prepare(
            `SELECT id FROM ${TABLES[entry.kind]} WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL`,
          )
          .get(accountId, entry.item)
        const stage = database
          .prepare(
            "SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id " +
              "WHERE p.account_id = ? AND p.kind = ? AND p.external_id = ? AND s.external_id = ?",
          )
          .get(accountId, entry.kind, entry.pipeline, entry.stage)
        if (!item || !stage) continue
        const externalId = `${entry.kind}/${entry.externalId}`
        const inserted = database
          .prepare(
            "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
          )
          .get(
            accountId,
            STAGE_ENTRY_RECORD,
            externalId,
            JSON.stringify({ kind: entry.kind, item_id: Number(item.id), stage_id: Number(stage.id), at: entry.at }),
            externalId,
            SOURCE,
            at,
            at,
          )
        if (!inserted) continue
        database
          .prepare(
            "INSERT INTO record_relations (record_id, role, target_type, target_external_id, created_at) " +
              "VALUES (?, 'on', ?, ?, ?)",
          )
          .run(Number(inserted.id), entry.kind, entry.item, at)
        saved += 1
      }
      return saved
    })

  /** The entries not handled yet, oldest first, as stage moves whose task source names the CRM's history row. */
  const pending = (key: AccountKey): CrmStageMove[] => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return []
    return database
      .prepare(
        "SELECT r.id, r.external_id, json_extract(r.fields, '$.kind') AS kind, " +
          "json_extract(r.fields, '$.item_id') AS item_id, s.external_id AS stage, s.name AS stage_name, " +
          "p.name AS pipeline_name FROM records r " +
          "JOIN pipeline_stages s ON s.id = json_extract(r.fields, '$.stage_id') JOIN pipelines p ON p.id = s.pipeline_id " +
          "WHERE r.account_id = ? AND r.type = ? AND r.deleted_at IS NULL " +
          "ORDER BY json_extract(r.fields, '$.at'), r.id",
      )
      .all(accountId, STAGE_ENTRY_RECORD)
      .map((row) => {
        const ref = `${String(row.kind)}:${String(row.item_id)}`
        return {
          id: Number(row.id),
          kind: row.kind as CrmStageMove["kind"],
          ref,
          source: `${ref}/history/${String(row.external_id).split("/").at(-1)}`,
          stage: String(row.stage),
          stageName: String(row.stage_name),
          pipelineName: String(row.pipeline_name),
        }
      })
  }

  const handled = (ids: readonly number[]): void =>
    write(database, () => {
      const at = now()
      for (const id of ids) database.prepare("UPDATE records SET deleted_at = ? WHERE id = ?").run(at, id)
    })

  return { save, pending, handled }
}
