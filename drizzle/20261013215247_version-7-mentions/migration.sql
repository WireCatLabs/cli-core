CREATE TABLE `mention_pending` (
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	CONSTRAINT `mention_pending_pk` PRIMARY KEY(`source_type`, `source_id`)
);
--> statement-breakpoint
CREATE TABLE `mentions` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`source_field` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`value` text NOT NULL,
	`domain` text,
	`method` text NOT NULL,
	`version` integer NOT NULL,
	`confidence` real NOT NULL,
	`status` text NOT NULL,
	`target_type` text,
	`target_id` integer,
	`author` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `mentions_source_type_source_id_source_field_start_offset_kind_unique` UNIQUE(`source_type`,`source_id`,`source_field`,`start_offset`,`kind`)
);
--> statement-breakpoint
CREATE INDEX `mentions_by_kind_value` ON `mentions` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `mentions_by_domain` ON `mentions` (`domain`) WHERE domain IS NOT NULL;--> statement-breakpoint
CREATE INDEX `mentions_by_status_kind` ON `mentions` (`status`,`kind`);--> statement-breakpoint
CREATE INDEX `mentions_by_target_type_target_id` ON `mentions` (`target_type`,`target_id`) WHERE target_id IS NOT NULL;