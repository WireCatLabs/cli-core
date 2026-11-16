CREATE TABLE `crm_files` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_assignee` text,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`mime` text,
	`size` integer,
	`external_created_at` integer,
	`local_path` text,
	`content_sha256` text,
	`text` text,
	`normalized_text` text,
	`extraction` text,
	`extraction_error` text,
	`downloaded_by` text,
	`downloaded_at` integer NOT NULL,
	CONSTRAINT `fk_crm_files_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `crm_files_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `crm_files_by_account_id_owner_kind_owner_id` ON `crm_files` (`account_id`,`owner_kind`,`owner_id`);