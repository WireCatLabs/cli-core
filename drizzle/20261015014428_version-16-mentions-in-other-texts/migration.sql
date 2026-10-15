-- Documents, notes and mail have text of their own: queue it for mentions as a message's text is, again when it
-- changes or is deleted (a soft delete too, so its mentions go), and drop its mentions with the row. Rows stored
-- before version 16 wait for `mentions rebuild`, as messages stored before version 7 do.
CREATE TRIGGER mention_pending_document_ai AFTER INSERT ON documents WHEN coalesce(new.body, '') <> '' BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('document', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_document_au AFTER UPDATE OF body, deleted_at ON documents
  WHEN old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('document', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mentions_document_ad AFTER DELETE ON documents BEGIN
  DELETE FROM mentions WHERE source_type = 'document' AND source_id = old.id;
  DELETE FROM mention_pending WHERE source_type = 'document' AND source_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_note_ai AFTER INSERT ON notes WHEN coalesce(new.body, '') <> '' BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('note', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_note_au AFTER UPDATE OF body, deleted_at ON notes
  WHEN old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('note', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mentions_note_ad AFTER DELETE ON notes BEGIN
  DELETE FROM mentions WHERE source_type = 'note' AND source_id = old.id;
  DELETE FROM mention_pending WHERE source_type = 'note' AND source_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_email_ai AFTER INSERT ON emails WHEN coalesce(new.body_text, '') <> '' BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('email', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_email_au AFTER UPDATE OF body_text, deleted_at ON emails
  WHEN old.body_text IS NOT new.body_text OR old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('email', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mentions_email_ad AFTER DELETE ON emails BEGIN
  DELETE FROM mentions WHERE source_type = 'email' AND source_id = old.id;
  DELETE FROM mention_pending WHERE source_type = 'email' AND source_id = old.id;
END;
