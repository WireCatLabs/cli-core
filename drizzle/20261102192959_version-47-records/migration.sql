CREATE TABLE `record_relations` (
	`id` integer PRIMARY KEY,
	`record_id` integer NOT NULL,
	`role` text NOT NULL,
	`target_type` text NOT NULL,
	`target_external_id` text NOT NULL,
	`target_id` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_record_relations_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`),
	CONSTRAINT `fk_record_relations_target_id_records_id_fk` FOREIGN KEY (`target_id`) REFERENCES `records`(`id`),
	CONSTRAINT `record_relations_record_id_role_target_type_target_external_id_unique` UNIQUE(`record_id`,`role`,`target_type`,`target_external_id`)
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`fields` text NOT NULL,
	`revision` integer,
	`fingerprint` text NOT NULL,
	`entity_type` text,
	`entity_id` integer,
	`projected_fingerprint` text,
	`batch_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_records_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `records_account_id_type_external_id_unique` UNIQUE(`account_id`,`type`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `record_relations_by_target_type_target_external_id` ON `record_relations` (`target_type`,`target_external_id`);--> statement-breakpoint
CREATE INDEX `record_relations_by_target_id` ON `record_relations` (`target_id`);--> statement-breakpoint
CREATE INDEX `records_by_entity_type_entity_id` ON `records` (`entity_type`,`entity_id`);