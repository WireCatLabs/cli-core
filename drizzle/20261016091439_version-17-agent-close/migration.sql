ALTER TABLE `tasks` ADD `close_certainty` real;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_suggested_as` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_suggested_by_type` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_suggested_by_id` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_suggested_certainty` real;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_suggested_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_suggested_at` integer;--> statement-breakpoint
CREATE INDEX `tasks_by_close_suggested_by_type_close_suggested_by_id` ON `tasks` (`close_suggested_by_type`,`close_suggested_by_id`);