DROP TRIGGER IF EXISTS person_kind_identity_au;
--> statement-breakpoint
CREATE TRIGGER person_kind_identity_au AFTER UPDATE OF provider, external_id, name, username, phone, email, bot ON identities
WHEN OLD.provider IS NOT NEW.provider OR OLD.external_id IS NOT NEW.external_id OR OLD.name IS NOT NEW.name OR OLD.username IS NOT NEW.username OR OLD.phone IS NOT NEW.phone OR OLD.email IS NOT NEW.email OR OLD.bot IS NOT NEW.bot BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.id);
END;
--> statement-breakpoint
UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND trim(coalesce(name, '')) = '';
