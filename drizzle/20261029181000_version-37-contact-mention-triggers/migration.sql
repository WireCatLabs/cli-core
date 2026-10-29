-- A shared contact card has no text, only a phone: queue it for mentions like an attachment's text.
-- Cards stored before version 37 wait for `mentions rebuild`.
CREATE TRIGGER mention_pending_attachment_contact_ai AFTER INSERT ON attachments
  WHEN new.attachable_type = 'message' AND new.contact IS NOT NULL BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_attachment_contact_au AFTER UPDATE OF contact ON attachments
  WHEN new.attachable_type = 'message' AND old.contact IS NOT new.contact BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);
END;
