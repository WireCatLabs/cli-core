-- A folder account's provider says what the folder is. Drive's stand-in folders (`google-drive:<principal>`) keep
-- `folder`: version 31 moves their documents to the `google-drive` account, and they are no local folder either way.
UPDATE accounts SET provider = CASE
    WHEN json_valid(settings) AND json_extract(settings, '$.format') = 'markdown' THEN 'local' ELSE 'obsidian' END
  WHERE provider = 'folder' AND coalesce(name, '') NOT LIKE 'google-drive:%';
--> statement-breakpoint
UPDATE identities SET email = lower(trim(external_id)) WHERE provider = 'email' AND instr(external_id, '@') > 1;
--> statement-breakpoint
-- A document hard-deleted (a rename onto a gone note's path) takes its file row along; the rename writes its own.
CREATE TRIGGER files_document_bd BEFORE DELETE ON documents BEGIN
  DELETE FROM files WHERE document_id = old.id;
END;
--> statement-breakpoint
-- One `files` row per document is written in JS on open (`fillFiles`), from the document after this id.
INSERT OR REPLACE INTO store_settings (key, value, at) VALUES ('files_backfill_after', '0', unixepoch() * 1000);
--> statement-breakpoint
-- A mail contact's address is its external id; every writer of one gets the column filled the same way.
CREATE TRIGGER identities_email_ai AFTER INSERT ON identities
  WHEN new.provider = 'email' AND new.email IS NULL AND instr(new.external_id, '@') > 1 BEGIN
  UPDATE identities SET email = lower(trim(new.external_id)) WHERE id = new.id;
END;
