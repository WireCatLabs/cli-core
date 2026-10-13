-- Words of an attachment's file name, rowid = attachment id, so a bare search word finds a file by its name
-- without reading every name. unicode61 folds case and Latin accents but not й and ё, which normalize()
-- folds into и and е: the triggers fold those two so a query normalized in JS still matches.
CREATE VIRTUAL TABLE attachment_name_words USING fts5(
  name,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER attachment_name_words_ai AFTER INSERT ON attachments WHEN new.name IS NOT NULL BEGIN
  INSERT INTO attachment_name_words (rowid, name)
    VALUES (new.id, replace(replace(replace(replace(new.name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е'));
END;
--> statement-breakpoint
CREATE TRIGGER attachment_name_words_au AFTER UPDATE OF name ON attachments
  WHEN old.name IS NOT new.name BEGIN
  DELETE FROM attachment_name_words WHERE rowid = old.id;
  INSERT INTO attachment_name_words (rowid, name)
    SELECT new.id, replace(replace(replace(replace(new.name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е')
    WHERE new.name IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER attachment_name_words_ad AFTER DELETE ON attachments BEGIN
  DELETE FROM attachment_name_words WHERE rowid = old.id;
END;
--> statement-breakpoint
INSERT INTO attachment_name_words (rowid, name)
  SELECT id, replace(replace(replace(replace(name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е')
  FROM attachments WHERE name IS NOT NULL;
