-- A person's role on a project or an organization written before the role lists, such as "клиент, принимает решения",
-- moves into the role note and leaves the role unset, so the link takes updates again and keeps its words. Of rows that
-- would meet in the relationship key, the oldest moves; none moves beside a row that already has no role.
UPDATE links SET metadata = json_set(coalesce(metadata, '{}'), '$.roleNote', role), role = NULL
WHERE id IN (
  WITH moves AS (
    SELECT l.id, l.kind, l.from_type, l.from_id, l.to_type, l.to_id, ifnull(l.anchor, '') AS anchor,
      ifnull(l.account_id, 0) AS account_id
    FROM links l
    WHERE l.kind = 'member-of' AND l.from_type = 'person' AND l.to_type IN ('project', 'organization')
      AND l.to_id IS NOT NULL AND trim(ifnull(l.role, '')) <> '' AND json_valid(coalesce(l.metadata, '{}'))
      AND NOT (l.to_type = 'project' AND l.role IN ('owner', 'manager', 'contributor', 'client-contact', 'approver'))
      AND NOT (l.to_type = 'organization'
        AND l.role IN ('employee', 'contractor', 'founder', 'owner', 'manager', 'adviser', 'contact'))
      AND NOT EXISTS (
        SELECT 1 FROM store_settings s,
          json_each(coalesce(CASE WHEN json_valid(s.value) THEN CASE WHEN json_type(s.value) = 'array' THEN s.value END END,
            '[]')) j
        WHERE s.key = 'relationships.roles.' || l.to_type AND j.type = 'object' AND json_extract(j.value, '$.id') = l.role)
  )
  SELECT m.id FROM moves m
  WHERE m.id = (SELECT min(n.id) FROM moves n WHERE n.kind = m.kind AND n.from_type = m.from_type
      AND n.from_id = m.from_id AND n.to_type = m.to_type AND n.to_id = m.to_id AND n.anchor = m.anchor
      AND n.account_id = m.account_id)
    AND NOT EXISTS (SELECT 1 FROM links o WHERE o.kind = m.kind AND o.from_type = m.from_type AND o.from_id = m.from_id
      AND o.to_type = m.to_type AND o.to_id = m.to_id AND ifnull(o.anchor, '') = m.anchor
      AND ifnull(o.account_id, 0) = m.account_id AND ifnull(o.role, '') = '')
);
