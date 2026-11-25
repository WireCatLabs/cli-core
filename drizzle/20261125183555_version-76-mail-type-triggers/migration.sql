CREATE TRIGGER mail_type_email_au AFTER UPDATE OF from_address, from_identity_id, subject, headers, metadata, outgoing, body_html ON emails
WHEN OLD.from_address IS NOT NEW.from_address OR OLD.from_identity_id IS NOT NEW.from_identity_id OR OLD.subject IS NOT NEW.subject OR OLD.headers IS NOT NEW.headers OR OLD.metadata IS NOT NEW.metadata OR OLD.outgoing IS NOT NEW.outgoing OR OLD.body_html IS NOT NEW.body_html BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_outgoing_au AFTER UPDATE OF outgoing ON emails
WHEN NEW.outgoing IS 1 AND OLD.outgoing IS NOT 1 BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND from_identity_id IN (SELECT identity_id FROM email_recipients WHERE email_id = NEW.id AND identity_id IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_list_ai AFTER INSERT ON emails
WHEN coalesce(json_extract(NEW.headers, '$."list-id"'), json_extract(NEW.metadata, '$.listId')) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM emails o WHERE coalesce(json_extract(o.headers, '$."list-id"'), json_extract(o.metadata, '$.listId')) = coalesce(json_extract(NEW.headers, '$."list-id"'), json_extract(NEW.metadata, '$.listId')) AND o.from_address IS NEW.from_address AND o.id <> NEW.id) BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND coalesce(json_extract(headers, '$."list-id"'), json_extract(metadata, '$.listId')) = coalesce(json_extract(NEW.headers, '$."list-id"'), json_extract(NEW.metadata, '$.listId'));
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_recipient_ai AFTER INSERT ON email_recipients BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id = NEW.email_id;
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND NEW.identity_id IS NOT NULL AND from_identity_id = NEW.identity_id
    AND (SELECT outgoing FROM emails WHERE id = NEW.email_id) IS 1
    AND NOT EXISTS (SELECT 1 FROM email_recipients r JOIN emails o ON o.id = r.email_id WHERE r.identity_id = NEW.identity_id AND o.outgoing = 1 AND r.email_id <> NEW.email_id);
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_recipient_ad AFTER DELETE ON email_recipients BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id = OLD.email_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_recipient_au AFTER UPDATE OF email_id, identity_id, address, role ON email_recipients
WHEN OLD.email_id IS NOT NEW.email_id OR OLD.identity_id IS NOT NEW.identity_id OR OLD.address IS NOT NEW.address OR OLD.role IS NOT NEW.role BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id IN (OLD.email_id, NEW.email_id);
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_attachment_ai AFTER INSERT ON attachments
WHEN NEW.attachable_type = 'email' AND lower(NEW.mime) IN ('text/calendar', 'application/ics', 'message/delivery-status', 'message/disposition-notification') BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id = NEW.attachable_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_attachment_ad AFTER DELETE ON attachments
WHEN OLD.attachable_type = 'email' AND lower(OLD.mime) IN ('text/calendar', 'application/ics', 'message/delivery-status', 'message/disposition-notification') BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id = OLD.attachable_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_attachment_au AFTER UPDATE OF mime ON attachments
WHEN NEW.attachable_type = 'email' AND OLD.mime IS NOT NEW.mime BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND id = NEW.attachable_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_bot_ai AFTER INSERT ON sender_bot_identities BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND from_identity_id = NEW.identity_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_bot_ad AFTER DELETE ON sender_bot_identities BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND from_identity_id = OLD.identity_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_organization_ai AFTER INSERT ON organization_identities BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND from_identity_id = NEW.identity_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_organization_ad AFTER DELETE ON organization_identities BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND from_identity_id = OLD.identity_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_type_sector_au AFTER UPDATE OF metadata, deleted_at ON organizations
WHEN json_extract(OLD.metadata, '$.sector') IS NOT json_extract(NEW.metadata, '$.sector') OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND from_identity_id IN (SELECT identity_id FROM organization_identities WHERE organization_id = NEW.id);
END;
