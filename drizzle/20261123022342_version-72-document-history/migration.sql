CREATE TABLE `document_changes` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`document_id` integer NOT NULL,
	`path` text NOT NULL,
	`title` text,
	`event` text NOT NULL,
	`revision` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `document_revisions` ADD `title` text;--> statement-breakpoint
ALTER TABLE `document_revisions` ADD `front_matter` text;--> statement-breakpoint
ALTER TABLE `document_revisions` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `removal` text;--> statement-breakpoint
CREATE INDEX `document_changes_by_account_id_at` ON `document_changes` (`account_id`,`at`);