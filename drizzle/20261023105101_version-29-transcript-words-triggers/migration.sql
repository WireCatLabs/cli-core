-- Words and stems of a voice note's transcript, rowid = attachment id. The words are the vocabulary garbled
-- spellings are read from; the typed form is still found in attachment_words. Stemming needs JS, so the
-- triggers only queue the attachment and the next search indexes it, as tasks do.
CREATE VIRTUAL TABLE transcript_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
--> statement-breakpoint
CREATE VIRTUAL TABLE transcript_words_vocab USING fts5vocab(transcript_words, 'col');
--> statement-breakpoint
CREATE VIRTUAL TABLE transcript_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
-- A transcript is the text of a message's voice attachment, whoever wrote it, as `speech()` in lucene-fields.ts.
CREATE TRIGGER transcript_index_ai AFTER INSERT ON attachments
  WHEN new.attachable_type = 'message' AND (coalesce(new.extractor, '') LIKE 'speech:%'
    OR new.kind IN ('voice', 'video_note') OR coalesce(new.mime, '') = 'audio/ogg') BEGIN
  INSERT OR IGNORE INTO transcript_index_pending (indexable_type, id) VALUES ('attachment', new.id);
END;
--> statement-breakpoint
-- Queued whether it became a transcript or stopped being one: the drain drops what is no longer live.
CREATE TRIGGER transcript_index_au AFTER UPDATE OF text, kind, mime, extractor, attachable_type ON attachments
  WHEN (old.text IS NOT new.text OR old.kind IS NOT new.kind OR old.mime IS NOT new.mime
    OR old.extractor IS NOT new.extractor OR old.attachable_type IS NOT new.attachable_type)
    AND ((new.attachable_type = 'message' AND (coalesce(new.extractor, '') LIKE 'speech:%'
      OR new.kind IN ('voice', 'video_note') OR coalesce(new.mime, '') = 'audio/ogg'))
    OR (old.attachable_type = 'message' AND (coalesce(old.extractor, '') LIKE 'speech:%'
      OR old.kind IN ('voice', 'video_note') OR coalesce(old.mime, '') = 'audio/ogg'))) BEGIN
  INSERT OR IGNORE INTO transcript_index_pending (indexable_type, id) VALUES ('attachment', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER transcript_index_ad AFTER DELETE ON attachments BEGIN
  DELETE FROM transcript_words WHERE rowid = old.id;
  DELETE FROM transcript_stems WHERE rowid = old.id;
  DELETE FROM transcript_index_pending WHERE indexable_type = 'attachment' AND id = old.id;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)
  VALUES ('transcript_index', 0, 0, 0, 1, NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO transcript_index_pending (indexable_type, id)
  SELECT 'attachment', id FROM attachments WHERE attachable_type = 'message' AND coalesce(text, '') <> ''
    AND (coalesce(extractor, '') LIKE 'speech:%' OR kind IN ('voice', 'video_note') OR coalesce(mime, '') = 'audio/ogg');
