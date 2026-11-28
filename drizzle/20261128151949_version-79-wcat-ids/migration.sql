-- memo became `wcat` (cli-core#3443): the ids memo's code wrote take the new names. Whole values only, and never onto
-- a name already taken (both columns are unique), so a store a newer build already wrote opens all the same. History
-- labels (provenance, reasons, decision notes in metadata, batch ids) keep the name they were written with.
UPDATE mailboxes SET external_id = 'wcat:bulk' WHERE external_id = 'memo:bulk'
  AND NOT EXISTS (SELECT 1 FROM mailboxes n WHERE n.account_id = mailboxes.account_id AND n.external_id = 'wcat:bulk');
--> statement-breakpoint
UPDATE mailboxes SET external_id = 'wcat:' || substr(external_id, 6) WHERE substr(external_id, 1, 14) = 'memo:envelope:'
  AND NOT EXISTS (SELECT 1 FROM mailboxes n
    WHERE n.account_id = mailboxes.account_id AND n.external_id = 'wcat:' || substr(mailboxes.external_id, 6));
--> statement-breakpoint
UPDATE bots SET name = 'wcat-scan' WHERE name = 'memo-scan' AND NOT EXISTS (SELECT 1 FROM bots n WHERE n.name = 'wcat-scan');
--> statement-breakpoint
UPDATE bots SET name = 'wcat-mcp' WHERE name = 'memo-mcp' AND NOT EXISTS (SELECT 1 FROM bots n WHERE n.name = 'wcat-mcp');
--> statement-breakpoint
UPDATE bots SET name = 'wcat-findings' WHERE name = 'memo-findings' AND NOT EXISTS (SELECT 1 FROM bots n WHERE n.name = 'wcat-findings');
--> statement-breakpoint
UPDATE bots SET name = 'wcat-mail-findings' WHERE name = 'memo-mail-findings' AND NOT EXISTS (SELECT 1 FROM bots n WHERE n.name = 'wcat-mail-findings');
--> statement-breakpoint
UPDATE bots SET name = 'files-reader' WHERE name = 'memo-reader' AND NOT EXISTS (SELECT 1 FROM bots n WHERE n.name = 'files-reader');
--> statement-breakpoint
-- A program rule an agent made is undone only by that agent, by its handle.
UPDATE mail_sort_rules SET decided_by = 'wcat-scan' WHERE decided_by = 'memo-scan';
--> statement-breakpoint
UPDATE mail_sort_rules SET decided_by = 'wcat-mcp' WHERE decided_by = 'memo-mcp';
--> statement-breakpoint
UPDATE mail_sort_rules SET decided_by = 'wcat-findings' WHERE decided_by = 'memo-findings';
--> statement-breakpoint
UPDATE mail_sort_rules SET decided_by = 'wcat-mail-findings' WHERE decided_by = 'memo-mail-findings';
--> statement-breakpoint
UPDATE mail_sort_rules SET decided_by = 'files-reader' WHERE decided_by = 'memo-reader';
--> statement-breakpoint
-- A saved template names the tool that saved it.
UPDATE templates SET updated_by = 'wcat' WHERE updated_by = 'memo';
--> statement-breakpoint
UPDATE templates_history SET saved_by = 'wcat' WHERE saved_by = 'memo';
--> statement-breakpoint
-- Later breaking upgrades name each recorded client to upgrade; there is no `memo` to upgrade any more.
UPDATE store_settings SET value = (
  SELECT json_group_array(CASE WHEN json_extract(e.value, '$.command') = 'memo'
    THEN json_set(e.value, '$.command', 'wcat') ELSE json(e.value) END)
  FROM json_each(store_settings.value) e
  WHERE NOT (json_extract(e.value, '$.command') = 'memo' AND EXISTS (
    SELECT 1 FROM json_each(store_settings.value) w WHERE json_extract(w.value, '$.command') = 'wcat')))
WHERE key = 'clients' AND json_valid(value) AND json_type(value) = 'array'
  AND EXISTS (SELECT 1 FROM json_each(store_settings.value) e WHERE json_extract(e.value, '$.command') = 'memo');
