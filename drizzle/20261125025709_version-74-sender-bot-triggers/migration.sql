-- No foreign keys on the bot tables, so an older build that erases a person or an organization, or purges an account,
-- still can; these drop or clear their rows with it.
CREATE TRIGGER sender_bots_person_ad AFTER DELETE ON persons BEGIN
  DELETE FROM sender_bots WHERE person_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER sender_bots_organization_ad AFTER DELETE ON organizations BEGIN
  UPDATE sender_bots SET organization_id = NULL WHERE organization_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER sender_bot_moves_identity_ad AFTER DELETE ON identities BEGIN
  DELETE FROM sender_bot_moves WHERE identity_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_sender_bot_ai AFTER INSERT ON sender_bots BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id = NEW.person_id;
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_sender_bot_ad AFTER DELETE ON sender_bots BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id = OLD.person_id;
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_sender_bot_au AFTER UPDATE OF person_id, author, name ON sender_bots BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (OLD.person_id, NEW.person_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_sender_bot_move_ai AFTER INSERT ON sender_bot_moves BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
