CREATE TABLE `crm_fields` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`code` text NOT NULL,
	`label` text,
	`type` text NOT NULL,
	`multiple` integer NOT NULL,
	`filterable` integer NOT NULL,
	`options` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_crm_fields_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `crm_fields_account_id_kind_code_unique` UNIQUE(`account_id`,`kind`,`code`)
);
