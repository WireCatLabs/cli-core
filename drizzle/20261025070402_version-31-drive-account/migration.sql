-- Drive documents leave their stand-in notes folder (`folder`, named `google-drive:<principal>`) for the
-- principal's `google-drive` account, by UPDATE, so every `document:<id>` reference holds. One folder per
-- principal moves, the oldest; a duplicate, or one whose files the account already holds, stays a folder.
CREATE TEMP TABLE drive_moves (folder_id INTEGER PRIMARY KEY, principal TEXT NOT NULL, account_id INTEGER);
--> statement-breakpoint
INSERT INTO temp.drive_moves (folder_id, principal)
SELECT f.id, substr(f.name, 14) FROM accounts f
WHERE f.provider = 'folder' AND substr(f.name, 1, 13) = 'google-drive:' AND length(f.name) > 13
  AND f.id = (SELECT min(o.id) FROM accounts o WHERE o.provider = 'folder' AND o.name = f.name)
  AND NOT EXISTS (
    SELECT 1 FROM documents held JOIN accounts g ON g.id = held.account_id
    WHERE g.provider = 'google-drive' AND g.external_id = substr(f.name, 14)
      AND held.external_id IN (SELECT external_id FROM documents WHERE account_id = f.id)
  );
--> statement-breakpoint
INSERT OR IGNORE INTO accounts (provider, external_id, name, scope, organization_id, created_at, updated_at)
SELECT 'google-drive', m.principal, 'Google Drive', f.scope, f.organization_id, f.created_at, f.updated_at
FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id;
--> statement-breakpoint
UPDATE temp.drive_moves SET account_id = (
  SELECT id FROM accounts WHERE provider = 'google-drive' AND external_id = drive_moves.principal
);
--> statement-breakpoint
UPDATE accounts SET
  settings = (
    SELECT json_set(
      CASE WHEN json_valid(accounts.settings) AND json_type(accounts.settings) = 'object' THEN accounts.settings ELSE '{}' END,
      '$.format', coalesce(CASE WHEN json_valid(f.settings) THEN json_extract(f.settings, '$.format') END, 'markdown'),
      '$.movedFrom', json_object('id', f.id, 'external_id', f.external_id, 'name', f.name)
    )
    FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id WHERE m.account_id = accounts.id
  ),
  scope = (SELECT f.scope FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id WHERE m.account_id = accounts.id),
  organization_id = (
    SELECT f.organization_id FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id WHERE m.account_id = accounts.id
  )
WHERE id IN (SELECT account_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE account_identities SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = account_identities.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE aliases SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = aliases.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE bot_updates SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = bot_updates.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE chats SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = chats.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE chunks SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = chunks.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE documents SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = documents.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE email_threads SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = email_threads.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE emails SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = emails.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE involvements SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = involvements.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE mailboxes SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mailboxes.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE mail_rules SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mail_rules.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE meeting_series SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = meeting_series.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE meetings SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = meetings.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE messages SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = messages.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE projects SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = projects.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE proposed_actions SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = proposed_actions.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE reminders SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = reminders.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE sync_cursors SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = sync_cursors.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE syncs SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = syncs.account_id)
WHERE account_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE agent_actions SET actor_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = agent_actions.actor_id)
WHERE actor_type = 'account' AND actor_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE agent_actions SET target_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = agent_actions.target_id)
WHERE target_type = 'account' AND target_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE aliases SET aliasable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = aliases.aliasable_id)
WHERE aliasable_type = 'account' AND aliasable_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE attachments SET attachable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = attachments.attachable_id)
WHERE attachable_type = 'account' AND attachable_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE chunks SET chunkable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = chunks.chunkable_id)
WHERE chunkable_type = 'account' AND chunkable_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE involvements SET subject_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = involvements.subject_id)
WHERE subject_type = 'account' AND subject_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE links SET from_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = links.from_id)
WHERE from_type = 'account' AND from_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE links SET to_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = links.to_id)
WHERE to_type = 'account' AND to_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE memories SET subject_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = memories.subject_id)
WHERE subject_type = 'account' AND subject_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE notes SET notable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = notes.notable_id)
WHERE notable_type = 'account' AND notable_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE proposed_actions SET target_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = proposed_actions.target_id)
WHERE target_type = 'account' AND target_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE taggings SET taggable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = taggings.taggable_id)
WHERE taggable_type = 'account' AND taggable_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE facts SET subject_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = facts.subject_id)
WHERE subject_type = 'account' AND subject_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE mention_pending SET source_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mention_pending.source_id)
WHERE source_type = 'account' AND source_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE mentions SET source_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mentions.source_id)
WHERE source_type = 'account' AND source_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
UPDATE mentions SET target_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mentions.target_id)
WHERE target_type = 'account' AND target_id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
-- A profile that named the folder names the account: `{ provider: "google-drive", account: <principal> }`.
UPDATE store_settings SET value = (
  SELECT json_group_object(app.key, CASE WHEN app.type = 'object' THEN (
    SELECT json_group_object(profile.key, CASE
      WHEN profile.type = 'object' AND json_extract(profile.value, '$.provider') = 'folder'
        AND json_extract(profile.value, '$.account') IN (SELECT 'google-drive:' || principal FROM temp.drive_moves)
      THEN json_set(profile.value, '$.provider', 'google-drive', '$.account', substr(json_extract(profile.value, '$.account'), 14))
      WHEN profile.type IN ('object', 'array') THEN json(profile.value)
      ELSE profile.value END)
    FROM json_each(app.value) profile
  ) WHEN app.type = 'array' THEN json(app.value) ELSE app.value END)
  FROM json_each(store_settings.value) app
)
WHERE key = 'profiles' AND json_valid(value) AND json_type(value) = 'object'
  AND EXISTS (SELECT 1 FROM temp.drive_moves);
--> statement-breakpoint
-- A group member `notes:<folder id>` follows the documents to `notes:<account id>`.
UPDATE store_settings SET value = (
  SELECT json_group_object(grp.key, CASE WHEN grp.type = 'array' THEN (
    SELECT json_group_array(coalesce(
      (SELECT 'notes:' || m.account_id FROM temp.drive_moves m WHERE 'notes:' || m.folder_id = member.value),
      member.value))
    FROM json_each(grp.value) member
  ) WHEN grp.type = 'object' THEN json(grp.value) ELSE grp.value END)
  FROM json_each(store_settings.value) grp
)
WHERE key = 'accountGroups' AND json_valid(value) AND json_type(value) = 'object'
  AND EXISTS (SELECT 1 FROM temp.drive_moves);
--> statement-breakpoint
DELETE FROM accounts WHERE id IN (SELECT folder_id FROM temp.drive_moves);
--> statement-breakpoint
DROP TABLE temp.drive_moves;
