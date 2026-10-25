-- The event is indexed, not each entry: its title, description and location, and the names its entries list.
-- Stemming needs JS, so the triggers only queue the event and the next search indexes it, as tasks do.
CREATE VIRTUAL TABLE event_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
--> statement-breakpoint
CREATE VIRTUAL TABLE event_words_vocab USING fts5vocab(event_words, 'col');
--> statement-breakpoint
CREATE VIRTUAL TABLE event_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER event_index_ai AFTER INSERT ON events BEGIN
  INSERT OR IGNORE INTO event_index_pending (indexable_type, id) VALUES ('event', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER event_index_au AFTER UPDATE OF title, description, location, deleted_at ON events
  WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.location IS NOT new.location
    OR old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO event_index_pending (indexable_type, id) VALUES ('event', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER event_index_ad AFTER DELETE ON events BEGIN
  DELETE FROM event_words WHERE rowid = old.id;
  DELETE FROM event_stems WHERE rowid = old.id;
  DELETE FROM event_index_pending WHERE indexable_type = 'event' AND id = old.id;
END;
--> statement-breakpoint
-- An entry that joins or leaves an event, or changes kind, changes what the event is found by.
CREATE TRIGGER event_index_entry_au AFTER UPDATE OF event_id, event_type, deleted_at ON calendar_entries
  WHEN old.event_id IS NOT new.event_id OR old.event_type IS NOT new.event_type OR old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)
    SELECT 'event', value FROM (SELECT old.event_id AS value UNION SELECT new.event_id) WHERE value IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER event_index_participant_ai AFTER INSERT ON calendar_entry_participants BEGIN
  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)
    SELECT 'event', event_id FROM calendar_entries WHERE id = new.entry_id AND event_id IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER event_index_participant_au AFTER UPDATE OF name ON calendar_entry_participants
  WHEN old.name IS NOT new.name BEGIN
  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)
    SELECT 'event', event_id FROM calendar_entries WHERE id = new.entry_id AND event_id IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER event_index_participant_ad AFTER DELETE ON calendar_entry_participants BEGIN
  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)
    SELECT 'event', event_id FROM calendar_entries WHERE id = old.entry_id AND event_id IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_entries_time_bi BEFORE INSERT ON calendar_entries
  WHEN new.ends_at < new.starts_at BEGIN
  SELECT RAISE(ABORT, 'a calendar entry cannot end before it starts');
END;
--> statement-breakpoint
CREATE TRIGGER calendar_entries_time_bu BEFORE UPDATE OF starts_at, ends_at ON calendar_entries
  WHEN new.ends_at < new.starts_at BEGIN
  SELECT RAISE(ABORT, 'a calendar entry cannot end before it starts');
END;
--> statement-breakpoint
INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)
  VALUES ('event_index', 0, 0, 0, 1, NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO event_index_pending (indexable_type, id) SELECT 'event', id FROM events;
