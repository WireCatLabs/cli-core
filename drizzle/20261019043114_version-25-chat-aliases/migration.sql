CREATE TABLE `chat_aliases` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_chat_aliases_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_chat_aliases_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `chat_aliases_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `chat_aliases_by_chat_id` ON `chat_aliases` (`chat_id`);