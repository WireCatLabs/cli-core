-- A claim renewed, a follow-up time or a close suggestion is an agent at work, not a change a person could overwrite;
-- bumping on those made the board report a conflict while an agent simply worked.
DROP TRIGGER tasks_revision_au;--> statement-breakpoint
CREATE TRIGGER tasks_revision_au AFTER UPDATE OF title, description, status, priority, priority_score, agent, due_at, project_id, parent_id ON tasks
  WHEN new.revision IS old.revision AND (new.title IS NOT old.title OR new.description IS NOT old.description
    OR new.status IS NOT old.status OR new.priority IS NOT old.priority OR new.priority_score IS NOT old.priority_score
    OR new.agent IS NOT old.agent OR new.due_at IS NOT old.due_at OR new.project_id IS NOT old.project_id
    OR new.parent_id IS NOT old.parent_id) BEGIN
  UPDATE tasks SET revision = old.revision + 1 WHERE id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_revision_assignment_ai AFTER INSERT ON task_assignments BEGIN
  UPDATE tasks SET revision = revision + 1 WHERE id = new.task_id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_revision_assignment_ad AFTER DELETE ON task_assignments BEGIN
  UPDATE tasks SET revision = revision + 1 WHERE id = old.task_id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_revision_tagging_ai AFTER INSERT ON taggings WHEN new.taggable_type = 'task' BEGIN
  UPDATE tasks SET revision = revision + 1 WHERE id = new.taggable_id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_revision_tagging_ad AFTER DELETE ON taggings WHEN old.taggable_type = 'task' BEGIN
  UPDATE tasks SET revision = revision + 1 WHERE id = old.taggable_id;
END;
