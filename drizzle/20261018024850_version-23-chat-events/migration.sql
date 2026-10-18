CREATE TABLE `chat_event_people` (
	`chat_event_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	CONSTRAINT `chat_event_people_pk` PRIMARY KEY(`chat_event_id`, `identity_id`),
	CONSTRAINT `fk_chat_event_people_chat_event_id_chat_events_id_fk` FOREIGN KEY (`chat_event_id`) REFERENCES `chat_events`(`id`),
	CONSTRAINT `fk_chat_event_people_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_events` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_identity_id` integer,
	`title` text,
	`happened_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_chat_events_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_chat_events_actor_identity_id_identities_id_fk` FOREIGN KEY (`actor_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `chat_events_chat_id_source_id_unique` UNIQUE(`chat_id`,`source_id`)
);
--> statement-breakpoint
CREATE INDEX `chat_event_people_by_identity_id` ON `chat_event_people` (`identity_id`);--> statement-breakpoint
CREATE INDEX `chat_events_by_chat_id_happened_at` ON `chat_events` (`chat_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `chat_events_by_actor_identity_id` ON `chat_events` (`actor_identity_id`);