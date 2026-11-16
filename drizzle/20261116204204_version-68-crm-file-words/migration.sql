-- Words of a downloaded CRM file's text, rowid = crm_files.id. Apart from attachment_words, so no generic
-- reader of attachments finds a colleague's file: only CRM code reads it, under the copy's viewer rule.
CREATE VIRTUAL TABLE crm_file_words USING fts5(
  normalized_text,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE crm_file_words_vocab USING fts5vocab(crm_file_words, 'col');--> statement-breakpoint
CREATE TRIGGER crm_file_words_ai AFTER INSERT ON crm_files WHEN new.normalized_text <> '' BEGIN
  INSERT INTO crm_file_words (rowid, normalized_text) VALUES (new.id, new.normalized_text);
END;--> statement-breakpoint
CREATE TRIGGER crm_file_words_au AFTER UPDATE OF normalized_text ON crm_files
  WHEN old.normalized_text IS NOT new.normalized_text BEGIN
  DELETE FROM crm_file_words WHERE rowid = old.id;
  INSERT INTO crm_file_words (rowid, normalized_text)
    SELECT new.id, new.normalized_text WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER crm_file_words_ad AFTER DELETE ON crm_files BEGIN
  DELETE FROM crm_file_words WHERE rowid = old.id;
END;
