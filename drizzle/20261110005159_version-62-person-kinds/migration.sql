ALTER TABLE `persons` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `persons` ADD `name_order` text;--> statement-breakpoint
ALTER TABLE `persons` ADD `messages_from` integer;--> statement-breakpoint
ALTER TABLE `persons` ADD `task_count` integer;--> statement-breakpoint
ALTER TABLE `persons` ADD `last_contact` integer;--> statement-breakpoint
CREATE INDEX `persons_by_kind` ON `persons` (`kind`);--> statement-breakpoint
CREATE INDEX `persons_kind_to_work_out` ON `persons` (`id`) WHERE kind IS NULL;