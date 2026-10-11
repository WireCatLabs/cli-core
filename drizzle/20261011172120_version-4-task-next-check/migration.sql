ALTER TABLE `tasks` ADD `next_check_at` integer;--> statement-breakpoint
CREATE INDEX `tasks_by_project_id_status_next_check_at` ON `tasks` (`project_id`,`status`,`next_check_at`);