CREATE TRIGGER chat_revisions_au AFTER UPDATE OF external_id, title, membership_state, scope, searchable, parent_chat_id ON chats BEGIN
  INSERT INTO chat_revisions (chat_id, account_id, field, old_value, new_value, source, created_at)
  SELECT new.id, new.account_id, f.field, f.old_value, f.new_value, s.source,
    coalesce(s.at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  FROM (
    SELECT 'external_id' AS field, old.external_id AS old_value, new.external_id AS new_value
    UNION ALL SELECT 'title', old.title, new.title
    UNION ALL SELECT 'membership_state', old.membership_state, new.membership_state
    UNION ALL SELECT 'scope', old.scope, new.scope
    UNION ALL SELECT 'searchable', old.searchable, new.searchable
    UNION ALL SELECT 'parent_chat_id', old.parent_chat_id, new.parent_chat_id
  ) f
  LEFT JOIN chat_revision_source s ON s.id = 1
  WHERE f.old_value IS NOT f.new_value;
END;--> statement-breakpoint
CREATE TRIGGER chat_revisions_ad AFTER DELETE ON chats BEGIN
  DELETE FROM chat_revisions WHERE chat_id = old.id;
END;
