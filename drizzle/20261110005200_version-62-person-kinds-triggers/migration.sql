CREATE TRIGGER person_kind_person_au AFTER UPDATE OF name, owner ON persons
WHEN OLD.name IS NOT NEW.name OR OLD.owner IS NOT NEW.owner BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_link_ai AFTER INSERT ON identity_links BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (NEW.person_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_link_ad AFTER DELETE ON identity_links BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (OLD.person_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_link_au AFTER UPDATE OF person_id, identity_id ON identity_links
WHEN OLD.person_id IS NOT NEW.person_id OR OLD.identity_id IS NOT NEW.identity_id BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (OLD.person_id, NEW.person_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_identity_au AFTER UPDATE OF provider, external_id, username, phone, email, bot ON identities
WHEN OLD.provider IS NOT NEW.provider OR OLD.external_id IS NOT NEW.external_id OR OLD.username IS NOT NEW.username OR OLD.phone IS NOT NEW.phone OR OLD.email IS NOT NEW.email OR OLD.bot IS NOT NEW.bot BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_ai AFTER INSERT ON chat_members BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_ad AFTER DELETE ON chat_members BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_au AFTER UPDATE OF chat_id, identity_id ON chat_members
WHEN OLD.chat_id IS NOT NEW.chat_id OR OLD.identity_id IS NOT NEW.identity_id BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_chat_au AFTER UPDATE OF kind, participants_count ON chats
WHEN OLD.kind IS NOT NEW.kind OR OLD.participants_count IS NOT NEW.participants_count BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM chat_members m JOIN identity_links l ON l.identity_id = m.identity_id WHERE m.chat_id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_count_ai AFTER INSERT ON member_counts
WHEN (SELECT participants_count FROM chats WHERE id = NEW.chat_id) IS NULL BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM chat_members m JOIN identity_links l ON l.identity_id = m.identity_id WHERE m.chat_id = NEW.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_count_ad AFTER DELETE ON member_counts
WHEN (SELECT participants_count FROM chats WHERE id = OLD.chat_id) IS NULL BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM chat_members m JOIN identity_links l ON l.identity_id = m.identity_id WHERE m.chat_id = OLD.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_member_count_au AFTER UPDATE OF listed_count, chat_id, date ON member_counts
WHEN (OLD.listed_count IS NOT NEW.listed_count OR OLD.chat_id IS NOT NEW.chat_id OR OLD.date IS NOT NEW.date)
  AND (SELECT participants_count FROM chats WHERE id = NEW.chat_id) IS NULL BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM chat_members m JOIN identity_links l ON l.identity_id = m.identity_id WHERE m.chat_id = NEW.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_email_ai AFTER INSERT ON emails BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.from_identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_email_ad AFTER DELETE ON emails BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.from_identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_email_au AFTER UPDATE OF from_identity_id, outgoing, deleted_at, draft, sent_at, received_at ON emails
WHEN OLD.from_identity_id IS NOT NEW.from_identity_id OR OLD.outgoing IS NOT NEW.outgoing OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.draft IS NOT NEW.draft OR OLD.sent_at IS NOT NEW.sent_at OR OLD.received_at IS NOT NEW.received_at BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.from_identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.from_identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM email_recipients r JOIN identity_links l ON l.identity_id = r.identity_id WHERE r.email_id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_recipient_ai AFTER INSERT ON email_recipients
WHEN (SELECT outgoing FROM emails WHERE id = NEW.email_id) = 1 BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_recipient_ad AFTER DELETE ON email_recipients
WHEN (SELECT outgoing FROM emails WHERE id = OLD.email_id) = 1 BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_recipient_au AFTER UPDATE OF email_id, identity_id ON email_recipients
WHEN (OLD.email_id IS NOT NEW.email_id OR OLD.identity_id IS NOT NEW.identity_id) AND 1 IN (SELECT outgoing FROM emails WHERE id IN (OLD.email_id, NEW.email_id)) BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_email_mailbox_ai AFTER INSERT ON email_mailboxes BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM emails e JOIN identity_links l ON l.identity_id = e.from_identity_id WHERE e.id = NEW.email_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_email_mailbox_ad AFTER DELETE ON email_mailboxes BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM emails e JOIN identity_links l ON l.identity_id = e.from_identity_id WHERE e.id = OLD.email_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_mailbox_au AFTER UPDATE OF kind ON mailboxes
WHEN OLD.kind IS NOT NEW.kind BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT l.person_id FROM email_mailboxes m JOIN emails e ON e.id = m.email_id JOIN identity_links l ON l.identity_id = e.from_identity_id WHERE m.mailbox_id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_meeting_participant_ai AFTER INSERT ON meeting_participants BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_meeting_participant_ad AFTER DELETE ON meeting_participants BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_meeting_participant_au AFTER UPDATE OF identity_id ON meeting_participants
WHEN OLD.identity_id IS NOT NEW.identity_id BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_calendar_participant_ai AFTER INSERT ON calendar_entry_participants BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_calendar_participant_ad AFTER DELETE ON calendar_entry_participants BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_calendar_participant_au AFTER UPDATE OF identity_id, resource ON calendar_entry_participants
WHEN OLD.identity_id IS NOT NEW.identity_id OR OLD.resource IS NOT NEW.resource BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_account_identity_ai AFTER INSERT ON account_identities BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_account_identity_ad AFTER DELETE ON account_identities BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_account_identity_au AFTER UPDATE OF identity_id, address_book, mail_signals, last_messaged_at ON account_identities
WHEN OLD.identity_id IS NOT NEW.identity_id OR OLD.address_book IS NOT NEW.address_book OR OLD.mail_signals IS NOT NEW.mail_signals OR OLD.last_messaged_at IS NOT NEW.last_messaged_at BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_organization_identity_ai AFTER INSERT ON organization_identities BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_organization_identity_ad AFTER DELETE ON organization_identities BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_organization_identity_au AFTER UPDATE OF identity_id ON organization_identities
WHEN OLD.identity_id IS NOT NEW.identity_id BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_record_ai AFTER INSERT ON records BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT NEW.entity_id WHERE NEW.entity_type = 'person');
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_record_ad AFTER DELETE ON records BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT OLD.entity_id WHERE OLD.entity_type = 'person');
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_record_au AFTER UPDATE OF entity_type, entity_id, deleted_at ON records
WHEN OLD.entity_type IS NOT NEW.entity_type OR OLD.entity_id IS NOT NEW.entity_id OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT OLD.entity_id WHERE OLD.entity_type = 'person');
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT NEW.entity_id WHERE NEW.entity_type = 'person');
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_assignment_ai AFTER INSERT ON task_assignments BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT NEW.assignee_id WHERE NEW.assignee_type = 'person' UNION SELECT to_person_id FROM identity_link_events WHERE NEW.assignee_type = 'person' AND from_person_id = NEW.assignee_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_assignment_ad AFTER DELETE ON task_assignments BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT OLD.assignee_id WHERE OLD.assignee_type = 'person' UNION SELECT to_person_id FROM identity_link_events WHERE OLD.assignee_type = 'person' AND from_person_id = OLD.assignee_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_assignment_au AFTER UPDATE OF task_id, assignee_type, assignee_id ON task_assignments
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.assignee_type IS NOT NEW.assignee_type OR OLD.assignee_id IS NOT NEW.assignee_id BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT OLD.assignee_id WHERE OLD.assignee_type = 'person' UNION SELECT to_person_id FROM identity_link_events WHERE OLD.assignee_type = 'person' AND from_person_id = OLD.assignee_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT NEW.assignee_id WHERE NEW.assignee_type = 'person' UNION SELECT to_person_id FROM identity_link_events WHERE NEW.assignee_type = 'person' AND from_person_id = NEW.assignee_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_task_au AFTER UPDATE OF deleted_at ON tasks
WHEN OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT a.assignee_id FROM task_assignments a WHERE a.task_id = NEW.id AND a.assignee_type = 'person' UNION SELECT e.to_person_id FROM task_assignments a JOIN identity_link_events e ON e.from_person_id = a.assignee_id WHERE a.task_id = NEW.id AND a.assignee_type = 'person');
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_message_ai AFTER INSERT ON messages BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.sender_identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_message_ad AFTER DELETE ON messages BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.sender_identity_id);
END;
--> statement-breakpoint
CREATE TRIGGER person_kind_message_au AFTER UPDATE OF sender_identity_id, sent_at, deleted_at ON messages
WHEN OLD.sender_identity_id IS NOT NEW.sender_identity_id OR OLD.sent_at IS NOT NEW.sent_at OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = OLD.sender_identity_id);
  UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN (SELECT person_id FROM identity_links WHERE identity_id = NEW.sender_identity_id);
END;
