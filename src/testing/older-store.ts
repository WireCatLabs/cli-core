import type { CacheDatabase } from "../store/driver.js"

// What a migration created that replaying it would create again; a migration that only updates rows needs nothing.
const UNDO: Record<number, string> = {
  23: "DROP TABLE chat_event_people; DROP TABLE chat_events;",
  22: "ALTER TABLE account_identities DROP COLUMN mail_demoted;",
  21: "DROP TABLE document_annotation_transfers;",
  20: "DROP TABLE poll_votes;",
  19: `ALTER TABLE account_identities DROP COLUMN mail_score; ALTER TABLE account_identities DROP COLUMN mail_signals;
    ALTER TABLE account_identities DROP COLUMN mail_scored_at;`,
  18: "DROP TABLE places;",
  17: `DROP INDEX tasks_by_close_suggested_by_type_close_suggested_by_id; ALTER TABLE tasks DROP COLUMN close_certainty;
    ALTER TABLE tasks DROP COLUMN close_suggested_as; ALTER TABLE tasks DROP COLUMN close_suggested_by_type;
    ALTER TABLE tasks DROP COLUMN close_suggested_by_id; ALTER TABLE tasks DROP COLUMN close_suggested_certainty;
    ALTER TABLE tasks DROP COLUMN close_suggested_reason; ALTER TABLE tasks DROP COLUMN close_suggested_at;`,
  16: `DROP TRIGGER mention_pending_document_ai; DROP TRIGGER mention_pending_document_au; DROP TRIGGER mentions_document_ad;
    DROP TRIGGER mention_pending_note_ai; DROP TRIGGER mention_pending_note_au; DROP TRIGGER mentions_note_ad;
    DROP TRIGGER mention_pending_email_ai; DROP TRIGGER mention_pending_email_au; DROP TRIGGER mentions_email_ad;`,
  15: "DROP TABLE task_pairs;",
  14: `DROP TRIGGER task_index_ai; DROP TRIGGER task_index_au; DROP TRIGGER task_index_ad; DROP TABLE task_words_vocab; DROP TABLE task_words;
    DROP TABLE task_stems; DROP TABLE task_index_pending; DELETE FROM search_index_state WHERE name = 'task_index';`,
  13: `DROP TABLE task_key_counters; ALTER TABLE tasks DROP COLUMN category; ALTER TABLE tasks DROP COLUMN claimed_by;
    ALTER TABLE tasks DROP COLUMN claimed_until;`,
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
