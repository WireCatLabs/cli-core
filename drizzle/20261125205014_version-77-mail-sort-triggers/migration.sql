UPDATE emails SET sort_checked = 1 WHERE mail_type IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER mail_sort_checked_au AFTER UPDATE OF mail_type ON emails
WHEN NEW.mail_type IS NULL AND NEW.sort_checked IS NOT NULL BEGIN
  UPDATE emails SET sort_checked = NULL WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_sort_effects_identity_ad AFTER DELETE ON identities BEGIN
  DELETE FROM mail_sort_effects WHERE identity_id = OLD.id;
END;