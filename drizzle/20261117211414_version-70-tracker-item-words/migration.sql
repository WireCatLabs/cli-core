-- Words of a tracker item's title and text, rowid = tracker_items.id: issues, projects and comments found by any word.
CREATE VIRTUAL TABLE tracker_item_words USING fts5(
  normalized_text,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE TRIGGER tracker_item_words_ai AFTER INSERT ON tracker_items WHEN new.normalized_text <> '' BEGIN
  INSERT INTO tracker_item_words (rowid, normalized_text) VALUES (new.id, new.normalized_text);
END;--> statement-breakpoint
CREATE TRIGGER tracker_item_words_au AFTER UPDATE OF normalized_text ON tracker_items
  WHEN old.normalized_text IS NOT new.normalized_text BEGIN
  DELETE FROM tracker_item_words WHERE rowid = old.id;
  INSERT INTO tracker_item_words (rowid, normalized_text)
    SELECT new.id, new.normalized_text WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER tracker_item_words_ad AFTER DELETE ON tracker_items BEGIN
  DELETE FROM tracker_item_words WHERE rowid = old.id;
END;
