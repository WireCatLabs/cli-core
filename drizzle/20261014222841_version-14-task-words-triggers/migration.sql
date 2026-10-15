-- Words and stems of a task's title and description, rowid = task id, for the duplicate check's candidate lookup.
-- Stemming needs JS, so the triggers only queue the task and the next lookup indexes it, as notes do.
CREATE VIRTUAL TABLE task_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
--> statement-breakpoint
CREATE VIRTUAL TABLE task_words_vocab USING fts5vocab(task_words, 'col');
--> statement-breakpoint
CREATE VIRTUAL TABLE task_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER task_index_ai AFTER INSERT ON tasks BEGIN
  INSERT OR IGNORE INTO task_index_pending (indexable_type, id) VALUES ('task', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER task_index_au AFTER UPDATE OF title, description, deleted_at ON tasks
  WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO task_index_pending (indexable_type, id) VALUES ('task', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER task_index_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM task_words WHERE rowid = old.id;
  DELETE FROM task_stems WHERE rowid = old.id;
  DELETE FROM task_index_pending WHERE indexable_type = 'task' AND id = old.id;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)
  VALUES ('task_index', 0, 0, 0, 1, NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO task_index_pending (indexable_type, id) SELECT 'task', id FROM tasks;
