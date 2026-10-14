-- A message's files and voice notes have text of their own (attachments.text): queue it for mentions as a
-- message's text is, and drop its mentions with it. Attachments stored before version 10 wait for
-- `mentions rebuild`, as messages stored before version 7 do.
CREATE TRIGGER mention_pending_attachment_ai AFTER INSERT ON attachments
  WHEN new.attachable_type = 'message' AND coalesce(new.text, '') <> '' BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_attachment_au AFTER UPDATE OF text, extractor ON attachments
  WHEN new.attachable_type = 'message' AND (old.text IS NOT new.text OR old.extractor IS NOT new.extractor) BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mentions_attachment_ad AFTER DELETE ON attachments BEGIN
  DELETE FROM mentions WHERE source_type = 'attachment' AND source_id = old.id;
  DELETE FROM mention_pending WHERE source_type = 'attachment' AND source_id = old.id;
END;
