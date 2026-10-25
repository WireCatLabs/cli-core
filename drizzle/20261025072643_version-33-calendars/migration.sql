CREATE TABLE `calendar_entries` (
	`id` integer PRIMARY KEY,
	`calendar_id` integer NOT NULL,
	`kind` text NOT NULL,
	`series_entry_id` integer,
	`event_id` integer,
	`event_series_id` integer,
	`external_id` text NOT NULL,
	`ical_uid` text,
	`original_starts_at` integer,
	`exception` integer NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`description` text,
	`location` text,
	`starts_at` integer,
	`ends_at` integer,
	`all_day` integer NOT NULL,
	`start_date` text,
	`end_date` text,
	`timezone` text,
	`recurrence` text,
	`recurrence_ends_at` integer,
	`event_type` text,
	`transparency` text,
	`visibility` text,
	`own_response` text,
	`organizer_identity_id` integer,
	`join_url` text,
	`join_key` text,
	`conference` text,
	`url` text,
	`sequence` integer,
	`etag` text,
	`external_updated_at` integer,
	`metadata` text,
	`seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_calendar_entries_calendar_id_calendars_id_fk` FOREIGN KEY (`calendar_id`) REFERENCES `calendars`(`id`),
	CONSTRAINT `fk_calendar_entries_series_entry_id_calendar_entries_id_fk` FOREIGN KEY (`series_entry_id`) REFERENCES `calendar_entries`(`id`),
	CONSTRAINT `fk_calendar_entries_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
	CONSTRAINT `fk_calendar_entries_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),
	CONSTRAINT `fk_calendar_entries_organizer_identity_id_identities_id_fk` FOREIGN KEY (`organizer_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `calendar_entries_calendar_id_external_id_unique` UNIQUE(`calendar_id`,`external_id`),
	CONSTRAINT `calendar_entries_series_entry_id_original_starts_at_unique` UNIQUE(`series_entry_id`,`original_starts_at`)
);
--> statement-breakpoint
CREATE TABLE `calendar_entry_participants` (
	`id` integer PRIMARY KEY,
	`entry_id` integer NOT NULL,
	`identity_id` integer,
	`email` text NOT NULL,
	`name` text,
	`response` text,
	`optional` integer NOT NULL,
	`organizer` integer NOT NULL,
	`self` integer NOT NULL,
	`resource` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_calendar_entry_participants_entry_id_calendar_entries_id_fk` FOREIGN KEY (`entry_id`) REFERENCES `calendar_entries`(`id`),
	CONSTRAINT `fk_calendar_entry_participants_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `calendar_entry_participants_entry_id_email_unique` UNIQUE(`entry_id`,`email`)
);
--> statement-breakpoint
CREATE TABLE `calendar_entry_revisions` (
	`id` integer PRIMARY KEY,
	`entry_id` integer NOT NULL,
	`title` text,
	`starts_at` integer,
	`ends_at` integer,
	`location` text,
	`status` text,
	`recurrence` text,
	`recurrence_ends_at` integer,
	`external_updated_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_calendar_entry_revisions_entry_id_calendar_entries_id_fk` FOREIGN KEY (`entry_id`) REFERENCES `calendar_entries`(`id`)
);
--> statement-breakpoint
CREATE TABLE `calendars` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`title` text,
	`timezone` text,
	`access_role` text,
	`primary_calendar` integer NOT NULL,
	`synced` integer NOT NULL,
	`seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_calendars_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `calendars_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `event_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `event_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
ALTER TABLE `events` ADD `status` text;--> statement-breakpoint
ALTER TABLE `events` ADD `all_day` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `source_deleted_at` integer;--> statement-breakpoint
ALTER TABLE `meetings` ADD `join_key` text;--> statement-breakpoint
CREATE INDEX `calendar_entries_by_calendar_id_starts_at` ON `calendar_entries` (`calendar_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_ical_uid` ON `calendar_entries` (`ical_uid`) WHERE ical_uid IS NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_entries_by_join_key` ON `calendar_entries` (`join_key`) WHERE join_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_entries_by_event_id` ON `calendar_entries` (`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_event_series_id` ON `calendar_entries` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_event_type_event_id` ON `calendar_entries` (`event_type`,`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_organizer_identity_id` ON `calendar_entries` (`organizer_identity_id`);--> statement-breakpoint
CREATE INDEX `calendar_entry_participants_by_identity_id` ON `calendar_entry_participants` (`identity_id`);--> statement-breakpoint
CREATE INDEX `calendar_entry_revisions_by_entry_id_created_at` ON `calendar_entry_revisions` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meetings_by_join_key` ON `meetings` (`join_key`) WHERE join_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `meetings_join_key_to_fill` ON `meetings` (`id`) WHERE join_url IS NOT NULL AND join_key IS NULL;