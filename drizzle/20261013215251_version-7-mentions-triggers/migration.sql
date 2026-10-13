-- Finding mentions needs JS, so the triggers only queue the message and the store's next write finds them.
-- Messages stored before version 7 are not queued here: `mentions rebuild` reads them in batches.
CREATE TRIGGER mention_pending_message_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('message', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mention_pending_message_au AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN
  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('message', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER mentions_message_ad AFTER DELETE ON messages BEGIN
  DELETE FROM mentions WHERE source_type = 'message' AND source_id = old.id;
  DELETE FROM mention_pending WHERE source_type = 'message' AND source_id = old.id;
END;
