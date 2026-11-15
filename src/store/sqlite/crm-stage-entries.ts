import type { CrmStageEntry } from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { SOURCE, TABLES } from "./crm-rows.js"
import type { CrmStageMove } from "./crm-settings.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export const STAGE_ENTRY_RECORD = "crm.stage-entry"

/** An entry whose deal never reached the copy is dropped after this long: the history is read this far back. */
export const STAGE_ENTRY_DAYS = 90
const DAY = 86_400_000

/** One stage a deal or lead entered, from the CRM's own history (`exact`) or from the copy's diffs between syncs. */
export interface StageEntry {
  itemId: number
  toStageId: number
  at: number
  exact: boolean
}

/**
 * Every stage entry of the kind's rows in one pipeline, or of one row, oldest first per row: the CRM's own history
 * where a row has any, else the copy's diffs, never both for one row. Entries handled or expired stay history.
 */
export const stageEntriesOf = (
  database: CacheDatabase,
  kind: DealKind,
  { pipeline = null, item = null }: { pipeline?: number | null; item?: number | null },
): StageEntry[] => {
  const exact = database
    .prepare(
      `SELECT d.id AS item_id, s.id AS stage_id, json_extract(r.fields, '$.at') AS at FROM records r ` +
        "JOIN record_relations rr ON rr.record_id = r.id AND rr.role = 'on' AND rr.target_type = ? " +
        `JOIN ${TABLES[kind]} d ON d.account_id = r.account_id AND d.external_id = rr.target_external_id ` +
        "JOIN pipeline_stages s ON s.id = json_extract(r.fields, '$.stage_id') " +
        "WHERE r.type = ? AND (? IS NULL OR s.pipeline_id = ?) AND (? IS NULL OR d.id = ?) " +
        "ORDER BY d.id, json_extract(r.fields, '$.at'), r.id",
    )
    .all(kind, STAGE_ENTRY_RECORD, pipeline, pipeline, item, item)
    .map((row) => ({ itemId: Number(row.item_id), toStageId: Number(row.stage_id), at: Number(row.at), exact: true }))
  const withHistory = new Set(exact.map(({ itemId }) => itemId))
  const copied = database
    .prepare(
      "SELECT item_id, to_stage_id, changed_at FROM pipeline_stage_changes WHERE item_type = ? " +
        "AND (? IS NULL OR pipeline_id = ?) AND (? IS NULL OR item_id = ?) ORDER BY item_id, id",
    )
    .all(kind, pipeline, pipeline, item, item)
    .filter((row) => !withHistory.has(Number(row.item_id)))
    .map((row) => ({
      itemId: Number(row.item_id),
      toStageId: Number(row.to_stage_id),
      at: Number(row.changed_at),
      exact: false,
    }))
  return [...exact, ...copied]
}

/**
 * The CRM's own record of each stage a deal or lead entered, read on every sync. An entry waits for its stage task
 * until it is handled; one on a deal the copy does not hold yet is kept, and counts once the deal arrives.
 */
export const crmStageEntriesOver = (context: StoreContext) => {
  const { database, now } = context

  /** Answers how many were new; an entry into a stage the copy does not hold is not kept. */
  const save = (key: AccountKey, entries: readonly CrmStageEntry[]): number =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const at = now()
      let saved = 0
      for (const entry of entries) {
        const stage = database
          .prepare(
            "SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id " +
              "WHERE p.account_id = ? AND p.kind = ? AND p.external_id = ? AND s.external_id = ?",
          )
          .get(accountId, entry.kind, entry.pipeline, entry.stage)
        if (!stage) continue
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
            JSON.stringify({ kind: entry.kind, item: entry.item, stage_id: Number(stage.id), at: entry.at }),
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

  /**
   * The entries on rows the copy holds whose stage task is not handled yet, made at or after `since`, oldest first, as
   * stage moves whose task source names the CRM's history row.
   */
  const pending = (key: AccountKey, since: number): CrmStageMove[] => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return []
    return database
      .prepare(
        "SELECT r.id, r.external_id, json_extract(r.fields, '$.kind') AS kind, coalesce(d.id, l.id) AS item_id, " +
          "s.external_id AS stage, s.name AS stage_name, p.name AS pipeline_name FROM records r " +
          "JOIN record_relations rr ON rr.record_id = r.id AND rr.role = 'on' " +
          "LEFT JOIN deals d ON rr.target_type = 'deal' AND d.account_id = r.account_id " +
          "AND d.external_id = rr.target_external_id AND d.deleted_at IS NULL " +
          "LEFT JOIN leads l ON rr.target_type = 'lead' AND l.account_id = r.account_id " +
          "AND l.external_id = rr.target_external_id AND l.deleted_at IS NULL " +
          "JOIN pipeline_stages s ON s.id = json_extract(r.fields, '$.stage_id') JOIN pipelines p ON p.id = s.pipeline_id " +
          "WHERE r.account_id = ? AND r.type = ? AND r.deleted_at IS NULL AND coalesce(d.id, l.id) IS NOT NULL " +
          "AND json_extract(r.fields, '$.handled') IS NULL AND json_extract(r.fields, '$.at') >= ? " +
          "ORDER BY json_extract(r.fields, '$.at'), r.id",
      )
      .all(accountId, STAGE_ENTRY_RECORD, since)
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
      for (const id of ids)
        database
          .prepare("UPDATE records SET fields = json_set(fields, '$.handled', 1), updated_at = ? WHERE id = ?")
          .run(at, id)
    })

  /** Entries no stored row has claimed for `STAGE_ENTRY_DAYS`: their deal is outside the copy for good. */
  const expire = (key: AccountKey): number =>
    write(database, () => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return 0
      const at = now()
      return database
        .prepare(
          "UPDATE records SET deleted_at = ? WHERE account_id = ? AND type = ? AND deleted_at IS NULL " +
            "AND json_extract(fields, '$.handled') IS NULL AND json_extract(fields, '$.at') < ? " +
            "AND NOT EXISTS (SELECT 1 FROM record_relations rr JOIN deals d ON rr.target_type = 'deal' " +
            "AND d.account_id = records.account_id AND d.external_id = rr.target_external_id " +
            "WHERE rr.record_id = records.id) " +
            "AND NOT EXISTS (SELECT 1 FROM record_relations rr JOIN leads l ON rr.target_type = 'lead' " +
            "AND l.account_id = records.account_id AND l.external_id = rr.target_external_id " +
            "WHERE rr.record_id = records.id)",
        )
        .run(at, accountId, STAGE_ENTRY_RECORD, at - STAGE_ENTRY_DAYS * DAY).changes
    })

  return { save, pending, handled, expire }
}
