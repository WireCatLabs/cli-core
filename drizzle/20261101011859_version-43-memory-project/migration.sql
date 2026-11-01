ALTER TABLE `memories` ADD `project_id` integer REFERENCES projects(id);--> statement-breakpoint
CREATE INDEX `memories_by_project_id` ON `memories` (`project_id`);