-- A bot of version 74 is a person row holding the bot's identities. Each identity moves to the bot, the move is logged
-- with the bot's author, and the person row stays, emptied and hidden, so a move back gives its uid back.
INSERT INTO sender_bot_identities (identity_id, bot_id, created_at)
SELECT l.identity_id, b.id, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM sender_bots b JOIN identity_links l ON l.person_id = b.person_id;
--> statement-breakpoint
INSERT INTO sender_bot_moves (identity_id, from_person_id, from_bot_id, to_person_id, to_bot_id, author, reason, created_at)
SELECT s.identity_id, b.person_id, NULL, NULL, b.id, b.author, 'store version 75: a bot holds its own identities',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM sender_bot_identities s JOIN sender_bots b ON b.id = s.bot_id;
--> statement-breakpoint
DELETE FROM identity_links WHERE identity_id IN (SELECT identity_id FROM sender_bot_identities);
--> statement-breakpoint
-- Negative: a build before 75 reads a bot as its person row, and this names none.
UPDATE sender_bots SET person_id = -id;
--> statement-breakpoint
-- Stored as a merge's emptied person is, so every build's people list leaves it out.
CREATE TRIGGER person_kind_sender_bot_origin_au AFTER UPDATE OF kind ON persons
WHEN NEW.kind IS NOT 'merged' AND NEW.owner = 0
  AND NOT EXISTS (SELECT 1 FROM identity_links WHERE person_id = NEW.id)
  AND EXISTS (SELECT 1 FROM sender_bot_moves WHERE from_person_id = NEW.id AND to_bot_id IS NOT NULL) BEGIN
  UPDATE persons SET kind = 'merged' WHERE id = NEW.id;
END;
--> statement-breakpoint
UPDATE persons SET kind = 'merged' WHERE owner = 0
  AND NOT EXISTS (SELECT 1 FROM identity_links WHERE person_id = persons.id)
  AND EXISTS (SELECT 1 FROM sender_bot_moves WHERE from_person_id = persons.id AND to_bot_id IS NOT NULL);
--> statement-breakpoint
-- An older build's sync links an identity with no person to a new one: a bot's identity gets none.
CREATE TRIGGER sender_bot_identity_link_bi BEFORE INSERT ON identity_links
WHEN EXISTS (SELECT 1 FROM sender_bot_identities WHERE identity_id = NEW.identity_id) BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
-- A re-key moves a person's link onto an identity a bot holds: the bot keeps it, and the move is logged.
CREATE TRIGGER sender_bot_identity_link_au AFTER UPDATE OF identity_id ON identity_links
WHEN EXISTS (SELECT 1 FROM sender_bot_identities WHERE identity_id = NEW.identity_id) BEGIN
  INSERT INTO sender_bot_moves (identity_id, from_person_id, from_bot_id, to_person_id, to_bot_id, author, reason, created_at)
  SELECT NEW.identity_id, NEW.person_id, NULL, NULL, s.bot_id, 'rules', 'the source re-keyed the identity',
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM sender_bot_identities s WHERE s.identity_id = NEW.identity_id;
  DELETE FROM identity_links WHERE identity_id = NEW.identity_id;
END;
--> statement-breakpoint
-- ...and the person row it made for it, with its log row, goes again.
CREATE TRIGGER sender_bot_identity_person_ai AFTER INSERT ON identity_link_events
WHEN NEW.from_person_id IS NULL
  AND EXISTS (SELECT 1 FROM sender_bot_identities WHERE identity_id = NEW.identity_id)
  AND NOT EXISTS (SELECT 1 FROM identity_links WHERE person_id = NEW.to_person_id) BEGIN
  DELETE FROM identity_link_events WHERE id = NEW.id;
  DELETE FROM persons WHERE id = NEW.to_person_id AND owner = 0
    AND NOT EXISTS (SELECT 1 FROM identity_link_events WHERE from_person_id = NEW.to_person_id OR to_person_id = NEW.to_person_id);
END;
--> statement-breakpoint
CREATE TRIGGER sender_bot_identities_linked_bi BEFORE INSERT ON sender_bot_identities
WHEN EXISTS (SELECT 1 FROM identity_links WHERE identity_id = NEW.identity_id) BEGIN
  SELECT RAISE(ABORT, 'sender_bot_identities: the identity is linked to a person; unlink it first');
END;
--> statement-breakpoint
-- An older build gives a bot back by deleting its row; one that still holds identities stays.
CREATE TRIGGER sender_bots_holding_bd BEFORE DELETE ON sender_bots
WHEN EXISTS (SELECT 1 FROM sender_bot_identities WHERE bot_id = OLD.id) BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER sender_bot_identities_identity_ad AFTER DELETE ON identities BEGIN
  DELETE FROM sender_bot_identities WHERE identity_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER sender_bots_emptied_ad AFTER DELETE ON sender_bot_identities
WHEN NOT EXISTS (SELECT 1 FROM sender_bot_identities WHERE bot_id = OLD.bot_id) BEGIN
  DELETE FROM sender_bots WHERE id = OLD.bot_id;
END;
--> statement-breakpoint
CREATE TRIGGER sender_bots_emptied_au AFTER UPDATE OF bot_id ON sender_bot_identities
WHEN NOT EXISTS (SELECT 1 FROM sender_bot_identities WHERE bot_id = OLD.bot_id) BEGIN
  DELETE FROM sender_bots WHERE id = OLD.bot_id;
END;
