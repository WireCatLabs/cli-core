import type { CacheDatabase } from "../store/driver.js"

// What a migration created that replaying it would create again; a migration that only updates rows needs nothing.
const UNDO: Record<number, string> = {
  62: `${[
    "person_au",
    "link_ai",
    "link_ad",
    "link_au",
    "identity_au",
    "member_ai",
    "member_ad",
    "member_au",
    "chat_au",
    "member_count_ai",
    "member_count_ad",
    "member_count_au",
    "email_ai",
    "email_ad",
    "email_au",
    "recipient_ai",
    "recipient_ad",
    "recipient_au",
    "email_mailbox_ai",
    "email_mailbox_ad",
    "mailbox_au",
    "meeting_participant_ai",
    "meeting_participant_ad",
    "meeting_participant_au",
    "calendar_participant_ai",
    "calendar_participant_ad",
    "calendar_participant_au",
    "account_identity_ai",
    "account_identity_ad",
    "account_identity_au",
    "organization_identity_ai",
    "organization_identity_ad",
    "organization_identity_au",
    "record_ai",
    "record_ad",
    "record_au",
    "assignment_ai",
    "assignment_ad",
    "assignment_au",
    "task_au",
    "message_ai",
    "message_ad",
    "message_au",
  ]
    .map((name) => `DROP TRIGGER person_kind_${name};`)
    .join(" ")}
    DROP INDEX persons_kind_to_work_out; DROP INDEX persons_by_kind; ALTER TABLE persons DROP COLUMN kind;
    ALTER TABLE persons DROP COLUMN name_order; ALTER TABLE persons DROP COLUMN messages_from;
    ALTER TABLE persons DROP COLUMN task_count; ALTER TABLE persons DROP COLUMN last_contact;`,
  61: "DROP INDEX account_identities_in_address_book; ALTER TABLE account_identities DROP COLUMN address_book;",
  60: `DROP INDEX pipeline_stages_by_base_stage_id; ALTER TABLE pipeline_stages DROP COLUMN base_stage_id;
    ALTER TABLE pipeline_stages DROP COLUMN base_confirmed;`,
  59: "DROP TABLE templates_history; DROP TABLE templates;",
  58: `DROP TRIGGER enrichments_document_gone; DROP TRIGGER enrichments_note_gone; DROP TRIGGER enrichments_email_gone;
    DROP TABLE enrichments;`,
  57: `DROP TRIGGER payments_refund_bi; DROP TRIGGER payments_refund_bu; DROP TRIGGER payment_allocations_refunded_bd;
    DROP TRIGGER payments_refund_leaves_bu; DROP TRIGGER payments_linked_bu; DROP TRIGGER payment_allocations_refund_bd;
    DROP TRIGGER payment_allocations_void_bd; DROP INDEX identities_by_phone;
    DROP TRIGGER orders_valid_bi; DROP TRIGGER orders_valid_bu; DROP TRIGGER invoices_valid_bu;
    DROP TRIGGER payments_confirm_bu; DROP TRIGGER payment_allocations_valid_bi; DROP TRIGGER payment_allocations_valid_bu;
    DROP TABLE transaction_splits; DROP TABLE financial_transactions; DROP TABLE financial_accounts;
    DROP TABLE subscription_prices; DROP INDEX invoices_by_subscription_id; DROP INDEX payments_by_subscription_id;
    ALTER TABLE invoices DROP COLUMN subscription_id; ALTER TABLE payments DROP COLUMN subscription_id;
    DROP TABLE subscriptions; DROP INDEX invoices_by_contract_id; DROP INDEX orders_by_contract_id;
    DROP INDEX orders_by_deal_id; ALTER TABLE invoices DROP COLUMN contract_id; ALTER TABLE orders DROP COLUMN contract_id;
    ALTER TABLE orders DROP COLUMN deal_id; ALTER TABLE orders DROP COLUMN direction; DROP TABLE contracts;
    DROP TABLE order_lines; DROP INDEX invoice_lines_by_catalog_item_id; ALTER TABLE invoice_lines DROP COLUMN catalog_item_id;
    DROP TABLE catalog_items; DROP INDEX payments_by_refund_of; ALTER TABLE payments DROP COLUMN refund_of;
    DROP INDEX records_by_account_id_batch_id; ALTER TABLE records DROP COLUMN created_entity;
    ALTER TABLE record_relations DROP COLUMN as_role;
    CREATE TRIGGER orders_valid_bi BEFORE INSERT ON orders
      WHEN new.customer_type NOT IN ('person', 'organization')
        OR new.purpose NOT IN ('personal', 'business', 'client', 'other')
        OR new.status NOT IN ('placed', 'shipped', 'delivered', 'cancelled', 'returned')
        OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
        OR (new.total IS NULL) <> (new.currency IS NULL) OR new.total < 0 BEGIN
      SELECT RAISE(ABORT, 'orders: a person or organization customer, a known purpose, status and review, an amount with its currency');
    END;
    CREATE TRIGGER orders_valid_bu BEFORE UPDATE ON orders
      WHEN new.customer_type NOT IN ('person', 'organization')
        OR new.purpose NOT IN ('personal', 'business', 'client', 'other')
        OR new.status NOT IN ('placed', 'shipped', 'delivered', 'cancelled', 'returned')
        OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
        OR (new.total IS NULL) <> (new.currency IS NULL) OR new.total < 0 BEGIN
      SELECT RAISE(ABORT, 'orders: a person or organization customer, a known purpose, status and review, an amount with its currency');
    END;
    CREATE TRIGGER invoices_valid_bu BEFORE UPDATE ON invoices
      WHEN new.direction NOT IN ('receivable', 'payable') OR new.total < 0
        OR new.status NOT IN ('draft', 'issued', 'partly_paid', 'paid', 'void')
        OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
        OR (new.currency IS NOT old.currency AND EXISTS (SELECT 1 FROM payment_allocations WHERE invoice_id = new.id))
        OR new.total < (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
          WHERE a.invoice_id = new.id AND p.review = 'confirmed' AND p.deleted_at IS NULL) BEGIN
      SELECT RAISE(ABORT, 'invoices: the total stays at or above what is allocated to it, in the same currency');
    END;
    CREATE TRIGGER payments_confirm_bu BEFORE UPDATE OF review ON payments
      WHEN new.review = 'confirmed' AND old.review IS NOT 'confirmed' AND EXISTS (
        SELECT 1 FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = new.id
          AND a.amount + (SELECT coalesce(sum(o.amount), 0) FROM payment_allocations o JOIN payments p ON p.id = o.payment_id
            WHERE o.invoice_id = a.invoice_id AND o.payment_id <> new.id AND p.review = 'confirmed' AND p.deleted_at IS NULL)
          > i.total) BEGIN
      SELECT RAISE(ABORT, 'payments: confirming it would settle more than an invoice''s total');
    END;
    CREATE TRIGGER payment_allocations_valid_bi BEFORE INSERT ON payment_allocations
      WHEN new.amount <= 0
        OR (SELECT currency FROM payments WHERE id = new.payment_id)
          IS NOT (SELECT currency FROM invoices WHERE id = new.invoice_id)
        OR (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.payment_id) + new.amount
          > (SELECT amount FROM payments WHERE id = new.payment_id)
        OR (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
          WHERE a.invoice_id = new.invoice_id
            AND ((p.review = 'confirmed' AND p.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
          > (SELECT total FROM invoices WHERE id = new.invoice_id) BEGIN
      SELECT RAISE(ABORT, 'payment_allocations: above 0, one currency, within the payment and within the invoice');
    END;
    CREATE TRIGGER payment_allocations_valid_bu BEFORE UPDATE ON payment_allocations
      WHEN new.amount <= 0 OR new.payment_id IS NOT old.payment_id OR new.invoice_id IS NOT old.invoice_id
        OR (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.payment_id AND id <> old.id)
          + new.amount > (SELECT amount FROM payments WHERE id = new.payment_id)
        OR (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
          WHERE a.invoice_id = new.invoice_id AND a.id <> old.id
            AND ((p.review = 'confirmed' AND p.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
          > (SELECT total FROM invoices WHERE id = new.invoice_id) BEGIN
      SELECT RAISE(ABORT, 'payment_allocations: above 0, within the payment and within the invoice, sides unchanged');
    END;`,
  56: `DROP TRIGGER link_revisions_ai; DROP TRIGGER link_revisions_au; DROP TRIGGER link_revisions_ad;
    DROP INDEX links_relationship_key; DROP TABLE link_revisions; ALTER TABLE links DROP COLUMN account_id;
    ALTER TABLE links DROP COLUMN starts_at; ALTER TABLE links DROP COLUMN ends_at; ALTER TABLE links DROP COLUMN deleted_at;`,
  55: "DROP TABLE decision_requests;",
  54: "DROP TABLE crm_fields;",
  53: `DROP INDEX pipelines_by_account_id_kind_external_id; ALTER TABLE pipelines DROP COLUMN deleted_at;
    ALTER TABLE pipeline_stages DROP COLUMN deleted_at;
    CREATE UNIQUE INDEX pipelines_by_account_id_external_id ON pipelines (account_id, external_id)
    WHERE account_id IS NOT NULL AND external_id IS NOT NULL;`,
  52: "DROP TABLE pipeline_stage_changes; DROP TABLE leads; DROP TABLE deals; DROP TABLE pipeline_stages; DROP TABLE pipelines;",
  51: `DROP INDEX tasks_by_provider_external_id; ALTER TABLE tasks DROP COLUMN provider;
    ALTER TABLE tasks DROP COLUMN external_id; ALTER TABLE tasks DROP COLUMN source_url;
    ALTER TABLE orders DROP COLUMN source_url;`,
  50: "DROP TABLE orders;",
  49: "ALTER TABLE record_relations DROP COLUMN amount;",
  48: "DELETE FROM store_settings WHERE key = 'test_accounts_to_purge';",
  47: "DROP TABLE record_relations; DROP TABLE records;",
  46: `DROP TRIGGER facts_no_payment_bi; DROP TRIGGER facts_no_payment_bu;
    DELETE FROM store_settings WHERE key = 'payment_facts_to_move';`,
  45: "DROP TABLE payment_allocations; DROP TABLE invoice_lines; DROP TABLE payments; DROP TABLE invoices;",
  44: "ALTER TABLE links DROP COLUMN purpose; DELETE FROM store_settings WHERE key = 'suggested_links_to_move';",
  43: "DROP INDEX memories_by_project_id; ALTER TABLE memories DROP COLUMN project_id;",
  42: `DROP TRIGGER tasks_revision_assignment_ai; DROP TRIGGER tasks_revision_assignment_ad;
    DROP TRIGGER tasks_revision_tagging_ai; DROP TRIGGER tasks_revision_tagging_ad; DROP TRIGGER tasks_revision_au;
    CREATE TRIGGER tasks_revision_au AFTER UPDATE ON tasks WHEN new.revision IS old.revision BEGIN
      UPDATE tasks SET revision = old.revision + 1 WHERE id = new.id;
    END;`,
  40: `DROP TRIGGER note_trigrams_bd; DROP TRIGGER document_trigrams_bd; DROP TABLE note_trigrams;
    DROP TABLE document_trigrams; DELETE FROM search_index_state WHERE name IN ('note_trigrams', 'document_trigrams');`,
  41: `DROP TRIGGER tasks_priority_score_ai; DROP TRIGGER tasks_priority_score_au; DROP TRIGGER tasks_revision_au;
    ALTER TABLE tasks DROP COLUMN priority_score; ALTER TABLE tasks DROP COLUMN agent; ALTER TABLE tasks DROP COLUMN revision;`,
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
