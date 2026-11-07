-- A CRM's deal and lead people were stored as the owner's (confirmed = 1): they are the CRM account's report.
UPDATE links SET confirmed = 0, account_id = (SELECT d.account_id FROM deals d WHERE d.id = links.from_id)
  WHERE source = 'crm' AND kind = 'related-to' AND from_type = 'deal';
--> statement-breakpoint
UPDATE links SET confirmed = 0, account_id = (SELECT l.account_id FROM leads l WHERE l.id = links.from_id)
  WHERE source = 'crm' AND kind = 'related-to' AND from_type = 'lead';
--> statement-breakpoint
-- The unique key below needs one row per relationship; of duplicates the owner's row stays, then the oldest.
DELETE FROM links WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY kind, from_type, from_id, to_type, to_id, ifnull(anchor, ''), ifnull(role, ''), ifnull(account_id, 0)
      ORDER BY confirmed DESC, id
    ) AS n
    FROM links WHERE kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND to_id IS NOT NULL
  ) WHERE n > 1
);
--> statement-breakpoint
CREATE TRIGGER link_revisions_ai AFTER INSERT ON links
  WHEN new.kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND new.to_id IS NOT NULL BEGIN
  INSERT INTO link_revisions (link_id, change, before, after, author, account_id, created_at)
  VALUES (new.id, 'added', NULL,
    json_object('role', new.role, 'confirmed', new.confirmed, 'account_id', new.account_id, 'starts_at', new.starts_at,
      'ends_at', new.ends_at, 'deleted_at', new.deleted_at),
    new.author, new.account_id, new.updated_at);
END;
--> statement-breakpoint
-- Only a change a reader sees: a sync that touches `updated_at` alone writes no revision.
CREATE TRIGGER link_revisions_au AFTER UPDATE OF role, confirmed, account_id, starts_at, ends_at, deleted_at ON links
  WHEN new.kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND new.to_id IS NOT NULL
    AND (old.role IS NOT new.role OR old.confirmed IS NOT new.confirmed OR old.account_id IS NOT new.account_id
      OR old.starts_at IS NOT new.starts_at OR old.ends_at IS NOT new.ends_at OR old.deleted_at IS NOT new.deleted_at) BEGIN
  INSERT INTO link_revisions (link_id, change, before, after, author, account_id, created_at)
  VALUES (new.id,
    CASE
      WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL THEN 'withdrawn'
      WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL THEN 'restored'
      WHEN old.confirmed = 0 AND new.confirmed = 1 THEN 'confirmed'
      WHEN old.ends_at IS NULL AND new.ends_at IS NOT NULL THEN 'ended'
      ELSE 'changed'
    END,
    json_object('role', old.role, 'confirmed', old.confirmed, 'account_id', old.account_id, 'starts_at', old.starts_at,
      'ends_at', old.ends_at, 'deleted_at', old.deleted_at),
    json_object('role', new.role, 'confirmed', new.confirmed, 'account_id', new.account_id, 'starts_at', new.starts_at,
      'ends_at', new.ends_at, 'deleted_at', new.deleted_at),
    new.author, new.account_id, new.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER link_revisions_ad AFTER DELETE ON links
  WHEN old.kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND old.to_id IS NOT NULL BEGIN
  INSERT INTO link_revisions (link_id, change, before, after, author, account_id, created_at)
  VALUES (old.id, 'removed',
    json_object('role', old.role, 'confirmed', old.confirmed, 'account_id', old.account_id, 'starts_at', old.starts_at,
      'ends_at', old.ends_at, 'deleted_at', old.deleted_at),
    NULL, old.author, old.account_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
