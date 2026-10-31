ALTER TABLE `tasks` ADD `priority_score` real;--> statement-breakpoint
ALTER TABLE `tasks` ADD `agent` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- 0 urgent … 4 low land inside the critical, high, medium and low quarters, with room on either side for moves.
UPDATE tasks SET priority_score = CASE priority WHEN 0 THEN 0.875 WHEN 1 THEN 0.625 WHEN 2 THEN 0.375 WHEN 3 THEN 0.1875 WHEN 4 THEN 0.0625 END WHERE priority IS NOT NULL;--> statement-breakpoint
-- A build before version 41 writes only `priority`; these keep the score in step with what it wrote.
CREATE TRIGGER tasks_priority_score_ai AFTER INSERT ON tasks WHEN new.priority IS NOT NULL AND new.priority_score IS NULL BEGIN
  UPDATE tasks SET priority_score = CASE new.priority WHEN 0 THEN 0.875 WHEN 1 THEN 0.625 WHEN 2 THEN 0.375 WHEN 3 THEN 0.1875 WHEN 4 THEN 0.0625 END WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_priority_score_au AFTER UPDATE OF priority ON tasks WHEN new.priority IS NOT old.priority AND new.priority_score IS old.priority_score BEGIN
  UPDATE tasks SET priority_score = CASE new.priority WHEN 0 THEN 0.875 WHEN 1 THEN 0.625 WHEN 2 THEN 0.375 WHEN 3 THEN 0.1875 WHEN 4 THEN 0.0625 END WHERE id = new.id;
END;--> statement-breakpoint
-- Every build's write bumps it, older ones too, so a stale copy is caught whoever wrote last.
CREATE TRIGGER tasks_revision_au AFTER UPDATE ON tasks WHEN new.revision IS old.revision BEGIN
  UPDATE tasks SET revision = old.revision + 1 WHERE id = new.id;
END;
