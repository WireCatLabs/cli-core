-- Rebuilding identity_links dropped its triggers; they come back here. An identity an organization owns has no
-- person, so it takes part in nothing as a person: a move to an organization drops its involvements, and a move from
-- one to a person queues them.
CREATE TRIGGER involvement_identity_link_ai AFTER INSERT ON identity_links BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE sender_identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'chat', chat_id FROM chat_members WHERE identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'meeting', meeting_id FROM meeting_participants WHERE identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', id FROM emails WHERE from_identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', email_id FROM email_recipients WHERE identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT from_type, from_id FROM links WHERE to_type = 'identity' AND to_id = new.identity_id;
END;
--> statement-breakpoint
CREATE TRIGGER involvement_identity_link_au AFTER UPDATE OF person_id ON identity_links WHEN old.person_id IS NOT new.person_id BEGIN
  UPDATE involvements SET person_id = new.person_id WHERE identity_id = new.identity_id AND new.person_id IS NOT NULL;
  DELETE FROM involvements WHERE identity_id = new.identity_id AND new.person_id IS NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE sender_identity_id = new.identity_id AND old.person_id IS NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'chat', chat_id FROM chat_members WHERE identity_id = new.identity_id AND old.person_id IS NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'meeting', meeting_id FROM meeting_participants WHERE identity_id = new.identity_id AND old.person_id IS NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', id FROM emails WHERE from_identity_id = new.identity_id AND old.person_id IS NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', email_id FROM email_recipients WHERE identity_id = new.identity_id AND old.person_id IS NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT from_type, from_id FROM links WHERE to_type = 'identity' AND to_id = new.identity_id AND old.person_id IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER involvement_identity_link_ad AFTER DELETE ON identity_links BEGIN
  DELETE FROM involvements WHERE identity_id = old.identity_id;
END;
--> statement-breakpoint
-- Exactly one owner: a person or an organization.
CREATE TRIGGER identity_links_one_owner_ai BEFORE INSERT ON identity_links
  WHEN (new.person_id IS NULL) = (new.organization_id IS NULL) BEGIN
  SELECT RAISE(ABORT, 'an identity has exactly one owner: a person or an organization');
END;
--> statement-breakpoint
CREATE TRIGGER identity_links_one_owner_au BEFORE UPDATE OF person_id, organization_id ON identity_links
  WHEN (new.person_id IS NULL) = (new.organization_id IS NULL) BEGIN
  SELECT RAISE(ABORT, 'an identity has exactly one owner: a person or an organization');
END;
