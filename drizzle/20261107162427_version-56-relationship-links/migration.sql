CREATE TABLE `link_revisions` (
	`id` integer PRIMARY KEY,
	`link_id` integer NOT NULL,
	`change` text NOT NULL,
	`before` text,
	`after` text,
	`author` text,
	`account_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `links` ADD `account_id` integer;--> statement-breakpoint
ALTER TABLE `links` ADD `starts_at` integer;--> statement-breakpoint
ALTER TABLE `links` ADD `ends_at` integer;--> statement-breakpoint
ALTER TABLE `links` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `link_revisions_by_link_id_created_at` ON `link_revisions` (`link_id`,`created_at`);