CREATE TRIGGER person_kind_chat_senders_au AFTER UPDATE OF kind, participants_count ON chats
WHEN OLD.kind IS NOT NEW.kind OR (OLD.participants_count <= 10) IS NOT (NEW.participants_count <= 10) BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM messages s JOIN identity_links l ON l.identity_id = s.sender_identity_id WHERE s.chat_id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_count_senders_ai AFTER INSERT ON member_counts
WHEN (SELECT participants_count FROM chats WHERE id = NEW.chat_id) IS NULL BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM messages s JOIN identity_links l ON l.identity_id = s.sender_identity_id WHERE s.chat_id = NEW.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_count_senders_ad AFTER DELETE ON member_counts
WHEN (SELECT participants_count FROM chats WHERE id = OLD.chat_id) IS NULL BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM messages s JOIN identity_links l ON l.identity_id = s.sender_identity_id WHERE s.chat_id = OLD.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_count_senders_au AFTER UPDATE OF listed_count, chat_id, date ON member_counts
WHEN (OLD.listed_count IS NOT NEW.listed_count OR OLD.chat_id IS NOT NEW.chat_id OR OLD.date IS NOT NEW.date)
  AND (SELECT participants_count FROM chats WHERE id = NEW.chat_id) IS NULL BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM messages s JOIN identity_links l ON l.identity_id = s.sender_identity_id WHERE s.chat_id = NEW.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_link_ai AFTER INSERT ON links
WHEN NEW.from_type IN ('deal', 'lead') AND NEW.kind = 'related-to' AND NEW.to_type = 'person' BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = NEW.from_type AND d.from_id = NEW.from_id AND d.kind = 'related-to' AND d.to_type = 'person' UNION SELECT NEW.to_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_link_ad AFTER DELETE ON links
WHEN OLD.from_type IN ('deal', 'lead') AND OLD.kind = 'related-to' AND OLD.to_type = 'person' BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = OLD.from_type AND d.from_id = OLD.from_id AND d.kind = 'related-to' AND d.to_type = 'person' UNION SELECT OLD.to_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_link_au AFTER UPDATE OF from_type, from_id, to_type, to_id, kind, role, deleted_at ON links
WHEN (OLD.from_type IN ('deal', 'lead') AND OLD.kind = 'related-to' AND OLD.to_type = 'person' OR NEW.from_type IN ('deal', 'lead') AND NEW.kind = 'related-to' AND NEW.to_type = 'person')
  AND (OLD.to_id IS NOT NEW.to_id OR OLD.role IS NOT NEW.role OR OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.from_id IS NOT NEW.from_id OR OLD.from_type IS NOT NEW.from_type OR OLD.kind IS NOT NEW.kind OR OLD.to_type IS NOT NEW.to_type) BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = OLD.from_type AND d.from_id = OLD.from_id AND d.kind = 'related-to' AND d.to_type = 'person' UNION SELECT OLD.to_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links d WHERE d.from_type = NEW.from_type AND d.from_id = NEW.from_id AND d.kind = 'related-to' AND d.to_type = 'person' UNION SELECT NEW.to_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_deal_owner_moved_au AFTER UPDATE OF person_id ON identity_links
WHEN OLD.person_id IS NOT NEW.person_id AND EXISTS (SELECT 1 FROM links o WHERE o.to_type = 'person' AND o.to_id IN (OLD.person_id, NEW.person_id) AND o.role = 'owner' AND o.from_type IN ('deal', 'lead')) BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT d.to_id FROM links o JOIN links d ON d.from_type = o.from_type AND d.from_id = o.from_id AND d.kind = 'related-to' AND d.to_type = 'person' WHERE o.to_type = 'person' AND o.to_id IN (OLD.person_id, NEW.person_id) AND o.role = 'owner' AND o.from_type IN ('deal', 'lead'));
END;
