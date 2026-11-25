CREATE TABLE `sender_bot_moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`identity_id` integer NOT NULL,
	`from_person_id` integer,
	`from_bot_id` integer,
	`to_person_id` integer,
	`to_bot_id` integer,
	`author` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sender_bots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`person_id` integer NOT NULL UNIQUE,
	`name` text,
	`organization_id` integer,
	`author` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `emails_by_list_id` ON `emails` (coalesce(json_extract(headers, '$."list-id"'), json_extract(metadata, '$.listId')));--> statement-breakpoint
CREATE INDEX `sender_bot_moves_by_identity_id` ON `sender_bot_moves` (`identity_id`);