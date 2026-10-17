CREATE TABLE `poll_votes` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`message_external_id` text NOT NULL,
	`identity_id` integer NOT NULL,
	`answers` text NOT NULL,
	`voted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_poll_votes_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_poll_votes_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `poll_votes_chat_id_message_external_id_identity_id_unique` UNIQUE(`chat_id`,`message_external_id`,`identity_id`)
);
--> statement-breakpoint
CREATE INDEX `poll_votes_by_identity_id` ON `poll_votes` (`identity_id`);