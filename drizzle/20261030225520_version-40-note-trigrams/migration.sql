CREATE VIRTUAL TABLE note_trigrams USING fts5(text, content = '', contentless_delete = 1, tokenize = 'trigram');--> statement-breakpoint
CREATE VIRTUAL TABLE document_trigrams USING fts5(text, content = '', contentless_delete = 1, tokenize = 'trigram');--> statement-breakpoint
CREATE TRIGGER note_trigrams_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM note_trigrams WHERE rowid = old.id;
END;--> statement-breakpoint
CREATE TRIGGER document_trigrams_bd BEFORE DELETE ON documents BEGIN
  DELETE FROM document_trigrams WHERE rowid = old.id;
END;--> statement-breakpoint
-- The trigrams hold JS-normalized text, which SQL cannot produce: fillTrigrams fills the rows stored before this
-- version, up to `watermark`, and a search reads the rest of them by their text meanwhile.
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version)
  SELECT 'note_trigrams', coalesce(max(id), 0), 0, 0, 1 FROM notes
  UNION ALL SELECT 'document_trigrams', coalesce(max(id), 0), 0, 0, 1 FROM documents;
