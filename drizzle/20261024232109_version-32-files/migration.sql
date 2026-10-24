CREATE TABLE `entity_link_events` (
	`id` integer PRIMARY KEY,
	`linkable_type` text NOT NULL,
	`linkable_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`from_entity_id` integer,
	`to_entity_id` integer,
	`method` text NOT NULL,
	`confidence` real,
	`author` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`path_folded` text,
	`parent_id` integer,
	`document_id` integer,
	`mime` text,
	`size` integer,
	`content_hash` text,
	`url` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_files_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_files_parent_id_files_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `files`(`id`),
	CONSTRAINT `fk_files_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`),
	CONSTRAINT `files_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `link_reviews` (
	`id` integer PRIMARY KEY,
	`linkable_type` text NOT NULL,
	`linkable_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`candidates` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`chosen_id` integer,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `link_reviews_linkable_type_linkable_id_entity_type_unique` UNIQUE(`linkable_type`,`linkable_id`,`entity_type`)
);
--> statement-breakpoint
ALTER TABLE `identities` ADD `email` text;--> statement-breakpoint
CREATE INDEX `entity_link_events_by_linkable_type_linkable_id` ON `entity_link_events` (`linkable_type`,`linkable_id`);--> statement-breakpoint
CREATE INDEX `entity_link_events_by_entity_type_to_entity_id` ON `entity_link_events` (`entity_type`,`to_entity_id`);--> statement-breakpoint
CREATE INDEX `files_by_account_id_path_folded` ON `files` (`account_id`,`path_folded`);--> statement-breakpoint
CREATE INDEX `files_path_to_fold` ON `files` (`id`) WHERE path_folded IS NULL;--> statement-breakpoint
CREATE INDEX `files_by_parent_id` ON `files` (`parent_id`);--> statement-breakpoint
CREATE INDEX `files_by_document_id` ON `files` (`document_id`);--> statement-breakpoint
CREATE INDEX `identities_by_email` ON `identities` (`email`) WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX `link_reviews_by_status_created_at` ON `link_reviews` (`status`,`created_at`);