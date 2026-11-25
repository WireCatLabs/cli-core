ALTER TABLE `emails` ADD `mail_type` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `reach` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `type_signal` text;--> statement-breakpoint
CREATE INDEX `emails_by_mail_type` ON `emails` (`mail_type`);--> statement-breakpoint
CREATE INDEX `emails_type_to_work_out` ON `emails` (`id`) WHERE mail_type IS NULL;