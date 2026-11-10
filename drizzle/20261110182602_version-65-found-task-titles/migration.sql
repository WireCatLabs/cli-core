-- A found task's title was its message's first line only while reading, so it went blank when the message was deleted.
-- The line comes from displayTitleOf in code, so the next writable open stores it for the tasks still titled
-- `<kind> — <source>` and deletes this key (fillFoundTaskTitles). A store with no such task gets no key.
INSERT OR REPLACE INTO store_settings (key, value, at)
SELECT 'found_task_titles_to_fill', '1', unixepoch() * 1000 WHERE EXISTS (
  SELECT 1 FROM tasks WHERE package_id IS NOT NULL AND deleted_at IS NULL AND source_locator LIKE 'msg:%'
    AND title = type || ' — ' || source_locator
);
