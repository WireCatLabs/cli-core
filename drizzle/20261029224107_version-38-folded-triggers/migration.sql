-- A build older than 38, or a write that forgets the copy, changes a name without its folded copy: empty the copy
-- so the next open refills it (fillFolded) rather than leave a stale one that filters would trust.
CREATE TRIGGER tasks_title_folded_au AFTER UPDATE OF title ON tasks
  WHEN new.title IS NOT old.title AND new.title_folded IS old.title_folded BEGIN
  UPDATE tasks SET title_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_close_reason_folded_au AFTER UPDATE OF close_reason ON tasks
  WHEN new.close_reason IS NOT old.close_reason AND new.close_reason_folded IS old.close_reason_folded BEGIN
  UPDATE tasks SET close_reason_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER attachments_name_folded_au AFTER UPDATE OF name ON attachments
  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN
  UPDATE attachments SET name_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER attachments_local_path_folded_au AFTER UPDATE OF local_path ON attachments
  WHEN new.local_path IS NOT old.local_path AND new.local_path_folded IS old.local_path_folded BEGIN
  UPDATE attachments SET local_path_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER meetings_title_folded_au AFTER UPDATE OF title ON meetings
  WHEN new.title IS NOT old.title AND new.title_folded IS old.title_folded BEGIN
  UPDATE meetings SET title_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER files_path_folded_au AFTER UPDATE OF path ON files
  WHEN new.path IS NOT old.path AND new.path_folded IS old.path_folded BEGIN
  UPDATE files SET path_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER projects_name_folded_au AFTER UPDATE OF name ON projects
  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN
  UPDATE projects SET name_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER chats_title_folded_au AFTER UPDATE OF title ON chats
  WHEN new.title IS NOT old.title AND new.title_folded IS old.title_folded BEGIN
  UPDATE chats SET title_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER identities_name_folded_au AFTER UPDATE OF name ON identities
  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN
  UPDATE identities SET name_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER email_threads_subject_folded_au AFTER UPDATE OF subject ON email_threads
  WHEN new.subject IS NOT old.subject AND new.subject_folded IS old.subject_folded BEGIN
  UPDATE email_threads SET subject_folded = NULL WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER mailboxes_name_folded_au AFTER UPDATE OF name ON mailboxes
  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN
  UPDATE mailboxes SET name_folded = NULL WHERE id = new.id;
END;
