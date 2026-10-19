CREATE TABLE `chat_revision_source` (
	`id` integer PRIMARY KEY,
	`source` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_revisions` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_revisions_by_chat_id_created_at` ON `chat_revisions` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_revisions_by_account_id_old_value` ON `chat_revisions` (`account_id`,`old_value`) WHERE field = 'external_id';