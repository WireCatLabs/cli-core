CREATE TABLE `templates` (
	`key` text NOT NULL,
	`channel` text NOT NULL,
	`language` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT `templates_pk` PRIMARY KEY(`key`, `channel`, `language`)
);
--> statement-breakpoint
CREATE TABLE `templates_history` (
	`id` integer PRIMARY KEY,
	`key` text NOT NULL,
	`channel` text NOT NULL,
	`language` text NOT NULL,
	`body` text NOT NULL,
	`saved_at` integer NOT NULL,
	`saved_by` text NOT NULL,
	`replaced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `templates_history_by_key_channel_language_id` ON `templates_history` (`key`,`channel`,`language`,`id`);