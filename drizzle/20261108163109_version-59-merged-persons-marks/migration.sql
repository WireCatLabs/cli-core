-- A person whose last identity moved to another person is merged into that one. The triggers mark it on any build's
-- write, so an older build's merges are marked too, and keep every mark one hop from a live person.
CREATE TRIGGER persons_merged_au AFTER UPDATE OF person_id ON identity_links
  WHEN old.person_id <> new.person_id BEGIN
  UPDATE persons SET merged_into = NULL WHERE id = new.person_id AND merged_into IS NOT NULL;
  UPDATE persons SET merged_into = new.person_id
    WHERE (id = old.person_id OR merged_into = old.person_id)
      AND (SELECT owner FROM persons WHERE id = old.person_id) = 0
      AND NOT EXISTS (SELECT 1 FROM identity_links WHERE person_id = old.person_id);
END;
--> statement-breakpoint
CREATE TRIGGER persons_merged_ai AFTER INSERT ON identity_links BEGIN
  UPDATE persons SET merged_into = NULL WHERE id = new.person_id AND merged_into IS NOT NULL;
END;
--> statement-breakpoint
UPDATE persons SET merged_into = (
    SELECT e.to_person_id FROM identity_link_events e WHERE e.from_person_id = persons.id ORDER BY e.id DESC LIMIT 1
  )
  WHERE owner = 0 AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = persons.id)
    AND EXISTS (SELECT 1 FROM identity_link_events e WHERE e.from_person_id = persons.id);
--> statement-breakpoint
WITH RECURSIVE hop(id, target, depth) AS (
    SELECT id, merged_into, 0 FROM persons WHERE merged_into IS NOT NULL
    UNION ALL
    SELECT hop.id, p.merged_into, hop.depth + 1 FROM hop JOIN persons p ON p.id = hop.target
      WHERE p.merged_into IS NOT NULL AND hop.depth < 64
  )
  UPDATE persons SET merged_into = (SELECT target FROM hop WHERE hop.id = persons.id ORDER BY depth DESC LIMIT 1)
  WHERE merged_into IS NOT NULL;
