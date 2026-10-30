ALTER TABLE `projects` ADD `name_folded` text;--> statement-breakpoint
CREATE INDEX `projects_name_to_fold` ON `projects` (`id`) WHERE name_folded IS NULL;