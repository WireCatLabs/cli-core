ALTER TABLE `attachments` ADD `name_folded` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `local_path_folded` text;--> statement-breakpoint
ALTER TABLE `meetings` ADD `title_folded` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `title_folded` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `close_reason_folded` text;--> statement-breakpoint
CREATE INDEX `attachments_by_name_folded` ON `attachments` (`name_folded`);--> statement-breakpoint
CREATE INDEX `meetings_by_account_id_title_folded` ON `meetings` (`account_id`,`title_folded`);--> statement-breakpoint
CREATE INDEX `tasks_by_title_folded` ON `tasks` (`title_folded`);