-- A memory of kind `fact` becomes a fact: what happened is a fact, not a conclusion. Its id rides in
-- `metadata.memory` so its links can follow; the memory row stays, marked deleted.
INSERT INTO facts (type, statement, status, subject_type, subject_id, author_type, author_id, model,
  confirmed_by_type, confirmed_by_id, scope, source, metadata, created_at, updated_at, deleted_at)
SELECT 'fact', m.body,
  CASE m.status WHEN 'proposed' THEN 'proposed' WHEN 'stale' THEN 'proposed' ELSE 'accepted' END,
  m.subject_type, m.subject_id, m.author_type, m.author_id, m.model,
  CASE m.status WHEN 'confirmed' THEN 'person' END,
  CASE m.status WHEN 'confirmed' THEN (SELECT id FROM persons WHERE owner = 1 ORDER BY id LIMIT 1) END,
  m.scope, 'memory',
  json_object('memory', m.id, 'memory_status', m.status, 'confidence', m.confidence,
    'last_verified_at', m.last_verified_at),
  m.created_at, m.updated_at,
  CASE m.status WHEN 'superseded' THEN m.updated_at END
FROM memories m WHERE m.kind = 'fact' AND m.deleted_at IS NULL ORDER BY m.id;
--> statement-breakpoint
UPDATE links SET from_type = 'fact', from_id = (
  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = links.from_id)
WHERE from_type = 'memory' AND from_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);
--> statement-breakpoint
UPDATE links SET to_type = 'fact', to_id = (
  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = links.to_id)
WHERE to_type = 'memory' AND to_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);
--> statement-breakpoint
UPDATE notes SET notable_type = 'fact', notable_id = (
  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = notes.notable_id)
WHERE notable_type = 'memory' AND notable_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);
--> statement-breakpoint
UPDATE taggings SET taggable_type = 'fact', taggable_id = (
  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = taggings.taggable_id)
WHERE taggable_type = 'memory' AND taggable_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);
--> statement-breakpoint
UPDATE memories SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE kind = 'fact' AND deleted_at IS NULL;
--> statement-breakpoint
-- An assignment's one home is task_assignments; the assigned-to links stay until their readers move.
INSERT OR IGNORE INTO task_assignments (task_id, assignee_type, assignee_id, role, created_at, updated_at)
SELECT l.from_id, 'person', l.to_id, 'assignee', l.created_at, l.updated_at FROM links l
WHERE l.kind = 'assigned-to' AND l.confirmed = 1 AND l.from_type = 'task' AND l.to_type = 'person'
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = l.from_id) AND EXISTS (SELECT 1 FROM persons p WHERE p.id = l.to_id)
ORDER BY l.id;
