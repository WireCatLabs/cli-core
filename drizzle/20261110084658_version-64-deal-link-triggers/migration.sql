DROP TRIGGER IF EXISTS person_kind_deal_link_ai;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_link_ai AFTER INSERT ON links
WHEN NEW.from_type IN ('deal', 'lead') AND NEW.kind = 'related-to' AND NEW.to_type = 'person' BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = NEW.from_type AND d.from_id = NEW.from_id AND d.kind = 'related-to' AND +d.to_type = 'person' UNION SELECT NEW.to_id);
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS person_kind_deal_link_ad;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_link_ad AFTER DELETE ON links
WHEN OLD.from_type IN ('deal', 'lead') AND OLD.kind = 'related-to' AND OLD.to_type = 'person' BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = OLD.from_type AND d.from_id = OLD.from_id AND d.kind = 'related-to' AND +d.to_type = 'person' UNION SELECT OLD.to_id);
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS person_kind_deal_link_au;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_link_au AFTER UPDATE OF from_type, from_id, to_type, to_id, kind, role, deleted_at ON links
WHEN (OLD.from_type IN ('deal', 'lead') AND OLD.kind = 'related-to' AND OLD.to_type = 'person' OR NEW.from_type IN ('deal', 'lead') AND NEW.kind = 'related-to' AND NEW.to_type = 'person')
  AND (OLD.to_id IS NOT NEW.to_id OR OLD.role IS NOT NEW.role OR OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.from_id IS NOT NEW.from_id OR OLD.from_type IS NOT NEW.from_type OR OLD.kind IS NOT NEW.kind OR OLD.to_type IS NOT NEW.to_type) BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = OLD.from_type AND d.from_id = OLD.from_id AND d.kind = 'related-to' AND +d.to_type = 'person' UNION SELECT OLD.to_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = NEW.from_type AND d.from_id = NEW.from_id AND d.kind = 'related-to' AND +d.to_type = 'person' UNION SELECT NEW.to_id);
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS person_kind_deal_owner_moved_au;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_owner_moved_au AFTER UPDATE OF person_id ON identity_links
WHEN OLD.person_id IS NOT NEW.person_id AND EXISTS (SELECT 1 FROM links o WHERE o.to_type = 'person' AND o.to_id IN (SELECT OLD.person_id UNION SELECT NEW.person_id UNION SELECT e.from_person_id FROM identity_link_events e WHERE e.identity_id = NEW.identity_id) AND o.role = 'owner' AND o.from_type IN ('deal', 'lead')) BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links o JOIN links d ON d.from_type = o.from_type AND d.from_id = o.from_id AND d.kind = 'related-to' AND +d.to_type = 'person' WHERE o.to_type = 'person' AND o.to_id IN (SELECT OLD.person_id UNION SELECT NEW.person_id UNION SELECT e.from_person_id FROM identity_link_events e WHERE e.identity_id = NEW.identity_id) AND o.role = 'owner' AND o.from_type IN ('deal', 'lead'));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS person_kind_deal_owner_person_au;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_owner_person_au AFTER UPDATE OF owner ON persons
WHEN OLD.owner IS NOT NEW.owner BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links o JOIN links d ON d.from_type = o.from_type AND d.from_id = o.from_id AND d.kind = 'related-to' AND +d.to_type = 'person' WHERE o.to_type = 'person' AND o.role = 'owner' AND o.from_type IN ('deal', 'lead') AND o.to_id IN (SELECT NEW.id UNION SELECT e.from_person_id FROM identity_link_events e JOIN identity_links l ON l.identity_id = e.identity_id WHERE l.person_id = NEW.id));
END;
