import type { CacheDatabase } from "../store/driver.js"

// What a migration created that replaying it would create again; a migration that only updates rows needs nothing.
const UNDO: Record<number, string> = {
  12: "DROP INDEX emails_by_mail_rule_id; ALTER TABLE emails DROP COLUMN mail_rule_id; DROP TABLE mail_rules;",
  11: "DROP TABLE organization_identities;",
  10: `DROP TRIGGER mention_pending_attachment_ai; DROP TRIGGER mention_pending_attachment_au;
    DROP TRIGGER mentions_attachment_ad;`,
  7: `DROP TRIGGER mention_pending_message_ai; DROP TRIGGER mention_pending_message_au;
    DROP TRIGGER mentions_message_ad; DROP TABLE mentions; DROP TABLE mention_pending;`,
  8: `DROP INDEX attachments_by_name_folded; DROP INDEX meetings_by_account_id_title_folded; DROP INDEX tasks_by_title_folded;
    ALTER TABLE attachments DROP COLUMN name_folded; ALTER TABLE attachments DROP COLUMN local_path_folded;
    ALTER TABLE meetings DROP COLUMN title_folded; ALTER TABLE tasks DROP COLUMN title_folded;
    ALTER TABLE tasks DROP COLUMN close_reason_folded;`,
  9: `DROP INDEX tasks_close_reason_to_fold; DROP INDEX attachments_local_path_to_fold;
    DROP INDEX meetings_title_to_fold;`,
}

/** Makes a store look as if it stopped before `version`, so the next open replays every migration from there. */
export const rollBackTo = (database: CacheDatabase, version: number): void => {
  for (const [from, sql] of Object.entries(UNDO).reverse()) if (Number(from) >= version) database.exec(sql)
  database.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(version)
}
