import type { CacheDatabase } from "../store/driver.js"

// What a migration created that replaying it would create again; a migration that only updates rows needs nothing.
const UNDO: Record<number, string> = {
  40: `DROP TRIGGER note_trigrams_bd; DROP TRIGGER document_trigrams_bd; DROP TABLE note_trigrams;
    DROP TABLE document_trigrams; DELETE FROM search_index_state WHERE name IN ('note_trigrams', 'document_trigrams');`,
  39: "DROP TABLE email_locations;",
  38: `DROP TRIGGER tasks_title_folded_au; DROP TRIGGER tasks_close_reason_folded_au; DROP TRIGGER attachments_name_folded_au; DROP TRIGGER attachments_local_path_folded_au; DROP TRIGGER meetings_title_folded_au; DROP TRIGGER files_path_folded_au; DROP TRIGGER projects_name_folded_au; DROP TRIGGER chats_title_folded_au; DROP TRIGGER identities_name_folded_au; DROP TRIGGER email_threads_subject_folded_au; DROP TRIGGER mailboxes_name_folded_au;
    DROP INDEX chats_title_to_fold; DROP INDEX email_threads_subject_to_fold; DROP INDEX identities_name_to_fold;
    DROP INDEX mailboxes_by_name_folded; DROP INDEX mailboxes_name_to_fold; DROP INDEX projects_by_name_folded;
    DROP INDEX projects_name_to_fold; ALTER TABLE chats DROP COLUMN title_folded;
    ALTER TABLE email_threads DROP COLUMN subject_folded; ALTER TABLE identities DROP COLUMN name_folded;
    ALTER TABLE mailboxes DROP COLUMN name_folded; ALTER TABLE projects DROP COLUMN name_folded;`,
  37: `DROP TRIGGER mention_pending_attachment_contact_ai; DROP TRIGGER mention_pending_attachment_contact_au;
    ALTER TABLE identities DROP COLUMN phone;`,
  36: "ALTER TABLE attachments DROP COLUMN contact;",
  34: `DROP TRIGGER vector_index_chunk_ai; DROP TRIGGER vector_index_chunk_ad; DROP TRIGGER vector_index_chunk_au;
    DROP TRIGGER vector_index_embedding_ai; DROP TRIGGER vector_index_embedding_ad;
    DROP TRIGGER vector_index_embedding_au; DROP TRIGGER vector_index_message_au;
    DROP TRIGGER vector_index_attachment_au; DROP TRIGGER vector_index_conversation_au; DROP TRIGGER vector_index_chat_au;
    DROP TABLE vector_index_redo; DROP TABLE vector_indexes;`,
  33: `DROP TRIGGER event_index_ai; DROP TRIGGER event_index_au; DROP TRIGGER event_index_ad;
    DROP TRIGGER event_index_entry_au; DROP TRIGGER event_index_participant_ai; DROP TRIGGER event_index_participant_au;
    DROP TRIGGER event_index_participant_ad; DROP TRIGGER calendar_entries_time_bi; DROP TRIGGER calendar_entries_time_bu;
    DROP TABLE event_words_vocab; DROP TABLE event_words; DROP TABLE event_stems; DROP TABLE event_index_pending;
    DELETE FROM search_index_state WHERE name = 'event_index';
    DROP TABLE calendar_entry_participants; DROP TABLE calendar_entry_revisions; DROP TABLE calendar_entries;
    DROP TABLE calendars; DROP INDEX meetings_by_join_key; DROP INDEX meetings_join_key_to_fill;
    ALTER TABLE meetings DROP COLUMN join_key; ALTER TABLE events DROP COLUMN status;
    ALTER TABLE events DROP COLUMN all_day; ALTER TABLE events DROP COLUMN source_deleted_at;`,
  32: `CREATE TRIGGER document_tombstone AFTER UPDATE OF deleted_at ON documents
      WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
      DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = new.id;
    END;
    ALTER TABLE documents DROP COLUMN pinned_file_id; DROP TRIGGER identities_email_ai; DROP TRIGGER files_document_bd; DROP TABLE files; DROP TABLE link_reviews;
    DROP TABLE entity_link_events; DROP INDEX identities_by_email; ALTER TABLE identities DROP COLUMN email;
    UPDATE accounts SET provider = 'folder' WHERE provider IN ('local', 'obsidian');
    DELETE FROM store_settings WHERE key = 'files_backfill_after';`,
  30: "DROP VIEW resolved_tags; DROP TABLE tag_consolidations; DROP TABLE tag_redirects; DROP INDEX canonical_auto_tag_claims_by_tag_id; CREATE INDEX auto_tag_claims_by_tag_id ON canonical_auto_tag_claims(tag_id); ALTER TABLE canonical_auto_tag_claims RENAME TO auto_tag_claims; ALTER TABLE canonical_tags RENAME TO tags;",
  29: `DROP TRIGGER transcript_index_ai; DROP TRIGGER transcript_index_au; DROP TRIGGER transcript_index_ad;
    DROP TABLE transcript_words_vocab; DROP TABLE transcript_words; DROP TABLE transcript_stems;
    DROP TABLE transcript_index_pending; DELETE FROM search_index_state WHERE name = 'transcript_index';`,
  28: `ALTER TABLE chats DROP COLUMN muted; ALTER TABLE chats DROP COLUMN muted_until; ALTER TABLE chats DROP COLUMN archived;
    ALTER TABLE chats DROP COLUMN marked_unread; ALTER TABLE chats DROP COLUMN unread_counted_at;`,
  27: "ALTER TABLE messages DROP COLUMN delivery;",
  26: "DROP TABLE message_reactions;",
  25: `DROP TRIGGER chat_revisions_au; DROP TRIGGER chat_revisions_ad; DROP TABLE chat_revisions;
    DROP TABLE chat_revision_source;`,
  24: "DROP INDEX messages_starred_by_time; ALTER TABLE messages DROP COLUMN starred;",
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
