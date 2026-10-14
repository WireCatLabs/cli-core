CREATE TABLE `task_key_counters` (
	`prefix` text PRIMARY KEY,
	`tasks_count` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `category` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `claimed_until` integer;