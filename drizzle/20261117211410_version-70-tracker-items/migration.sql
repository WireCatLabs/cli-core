CREATE TABLE `tracker_items` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`title_folded` text NOT NULL,
	`body` text,
	`normalized_text` text NOT NULL,
	`data` text NOT NULL,
	`source_created_at` integer,
	`source_updated_at` integer,
	`archived_at` integer,
	`deleted_at` integer,
	`synced_at` integer NOT NULL,
	CONSTRAINT `fk_tracker_items_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `tracker_items_account_id_kind_external_id_unique` UNIQUE(`account_id`,`kind`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `tracker_items_by_account_id_kind_parent_id` ON `tracker_items` (`account_id`,`kind`,`parent_id`);