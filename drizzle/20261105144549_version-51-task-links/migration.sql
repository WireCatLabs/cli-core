ALTER TABLE `orders` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_url` text;--> statement-breakpoint
CREATE INDEX `tasks_by_provider_external_id` ON `tasks` (`provider`,`external_id`) WHERE external_id IS NOT NULL;