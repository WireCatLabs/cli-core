CREATE TABLE `sender_bot_identities` (
	`identity_id` integer PRIMARY KEY,
	`bot_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sender_bot_identities_by_bot_id` ON `sender_bot_identities` (`bot_id`);--> statement-breakpoint
CREATE INDEX `sender_bot_moves_by_from_person_id` ON `sender_bot_moves` (`from_person_id`);