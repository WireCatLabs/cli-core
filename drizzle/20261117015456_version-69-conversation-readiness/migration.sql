CREATE TABLE `conversation_readiness` (
	`chat_id` integer NOT NULL,
	`model` text NOT NULL,
	`new_count` integer NOT NULL,
	`edited_count` integer NOT NULL,
	`deleted_count` integer NOT NULL,
	`chunks` integer NOT NULL,
	`embedded_count` integer NOT NULL,
	`current` integer NOT NULL,
	`stale` integer NOT NULL,
	`counted_at` integer NOT NULL,
	CONSTRAINT `conversation_readiness_pk` PRIMARY KEY(`chat_id`, `model`),
	CONSTRAINT `fk_conversation_readiness_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `conversation_readiness_by_model` ON `conversation_readiness` (`model`);