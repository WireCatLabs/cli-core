CREATE TABLE `__new_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`settings` text,
	`status` text,
	`updated_at` integer NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`organization_id` integer,
	CONSTRAINT `fk_accounts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `accounts_provider_external_id_unique` UNIQUE(`provider`,`external_id`),
	CONSTRAINT "accounts_settings_json" CHECK("settings" IS NULL OR json_valid("settings"))
);
--> statement-breakpoint
INSERT INTO `__new_accounts`(`id`, `provider`, `external_id`, `name`, `created_at`, `settings`, `status`, `updated_at`, `scope`, `organization_id`) SELECT `id`, `provider`, `external_id`, `name`, `created_at`, `settings`, `status`, `updated_at`, `scope`, `organization_id` FROM `accounts`;--> statement-breakpoint
DROP TABLE `accounts`;--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;--> statement-breakpoint
CREATE TABLE `__new_agent_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`actor_type` text NOT NULL,
	`actor_id` integer NOT NULL,
	`tool` text NOT NULL,
	`tier` text NOT NULL,
	`target_type` text,
	`target_id` integer,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "agent_actions_target_pair" CHECK(("target_type" IS NULL) = ("target_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agent_actions`(`id`, `actor_type`, `actor_id`, `tool`, `tier`, `target_type`, `target_id`, `status`, `error`, `started_at`, `finished_at`, `created_at`) SELECT `id`, `actor_type`, `actor_id`, `tool`, `tier`, `target_type`, `target_id`, `status`, `error`, `started_at`, `finished_at`, `created_at` FROM `agent_actions`;--> statement-breakpoint
DROP TABLE `agent_actions`;--> statement-breakpoint
ALTER TABLE `__new_agent_actions` RENAME TO `agent_actions`;--> statement-breakpoint
CREATE TABLE `__new_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`attachable_type` text NOT NULL,
	`attachable_id` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`mime` text,
	`name` text,
	`title` text,
	`url` text,
	`size` integer,
	`width` integer,
	`height` integer,
	`duration` real,
	`provider_ref` text,
	`local_path` text,
	`text` text,
	`normalized_text` text,
	`extraction` text,
	`extractor` text,
	`extraction_error` text,
	`content_sha256` text,
	`extracted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name_folded` text,
	`local_path_folded` text,
	`contact` text,
	CONSTRAINT `attachments_attachable_type_attachable_id_position_unique` UNIQUE(`attachable_type`,`attachable_id`,`position`),
	CONSTRAINT "attachments_provider_ref_json" CHECK("provider_ref" IS NULL OR json_valid("provider_ref")),
	CONSTRAINT "attachments_contact_json" CHECK("contact" IS NULL OR json_valid("contact"))
);
--> statement-breakpoint
INSERT INTO `__new_attachments`(`id`, `attachable_type`, `attachable_id`, `position`, `kind`, `mime`, `name`, `title`, `url`, `size`, `width`, `height`, `duration`, `provider_ref`, `local_path`, `text`, `normalized_text`, `extraction`, `extractor`, `extraction_error`, `content_sha256`, `extracted_at`, `created_at`, `updated_at`, `name_folded`, `local_path_folded`, `contact`) SELECT `id`, `attachable_type`, `attachable_id`, `position`, `kind`, `mime`, `name`, `title`, `url`, `size`, `width`, `height`, `duration`, `provider_ref`, `local_path`, `text`, `normalized_text`, `extraction`, `extractor`, `extraction_error`, `content_sha256`, `extracted_at`, `created_at`, `updated_at`, `name_folded`, `local_path_folded`, `contact` FROM `attachments`;--> statement-breakpoint
DROP TABLE `attachments`;--> statement-breakpoint
ALTER TABLE `__new_attachments` RENAME TO `attachments`;--> statement-breakpoint
CREATE TABLE `__new_bot_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`handled_at` integer,
	`error` text,
	`replayed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_bot_updates_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `bot_updates_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "bot_updates_payload_json" CHECK("payload" IS NULL OR json_valid("payload"))
);
--> statement-breakpoint
INSERT INTO `__new_bot_updates`(`id`, `account_id`, `external_id`, `kind`, `payload`, `received_at`, `handled_at`, `error`, `replayed_at`, `created_at`) SELECT `id`, `account_id`, `external_id`, `kind`, `payload`, `received_at`, `handled_at`, `error`, `replayed_at`, `created_at` FROM `bot_updates`;--> statement-breakpoint
DROP TABLE `bot_updates`;--> statement-breakpoint
ALTER TABLE `__new_bot_updates` RENAME TO `bot_updates`;--> statement-breakpoint
CREATE TABLE `__new_bots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL UNIQUE,
	`kind` text NOT NULL,
	`description` text,
	`owner_person_id` integer,
	`model` text,
	`token_digest` text,
	`last_seen_at` integer,
	`disabled_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_bots_owner_person_id_persons_id_fk` FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT "bots_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_bots`(`id`, `name`, `kind`, `description`, `owner_person_id`, `model`, `token_digest`, `last_seen_at`, `disabled_at`, `metadata`, `created_at`, `updated_at`) SELECT `id`, `name`, `kind`, `description`, `owner_person_id`, `model`, `token_digest`, `last_seen_at`, `disabled_at`, `metadata`, `created_at`, `updated_at` FROM `bots`;--> statement-breakpoint
DROP TABLE `bots`;--> statement-breakpoint
ALTER TABLE `__new_bots` RENAME TO `bots`;--> statement-breakpoint
CREATE TABLE `__new_calendar_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
	`series_external_id` text,
	CONSTRAINT `fk_calendar_entries_calendar_id_calendars_id_fk` FOREIGN KEY (`calendar_id`) REFERENCES `calendars`(`id`),
	CONSTRAINT `fk_calendar_entries_series_entry_id_calendar_entries_id_fk` FOREIGN KEY (`series_entry_id`) REFERENCES `calendar_entries`(`id`),
	CONSTRAINT `fk_calendar_entries_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
	CONSTRAINT `fk_calendar_entries_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),
	CONSTRAINT `fk_calendar_entries_organizer_identity_id_identities_id_fk` FOREIGN KEY (`organizer_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `calendar_entries_calendar_id_external_id_unique` UNIQUE(`calendar_id`,`external_id`),
	CONSTRAINT `calendar_entries_series_entry_id_original_starts_at_unique` UNIQUE(`series_entry_id`,`original_starts_at`),
	CONSTRAINT "calendar_entries_recurrence_json" CHECK("recurrence" IS NULL OR json_valid("recurrence")),
	CONSTRAINT "calendar_entries_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_calendar_entries`(`id`, `calendar_id`, `kind`, `series_entry_id`, `event_id`, `event_series_id`, `external_id`, `ical_uid`, `original_starts_at`, `exception`, `status`, `title`, `description`, `location`, `starts_at`, `ends_at`, `all_day`, `start_date`, `end_date`, `timezone`, `recurrence`, `recurrence_ends_at`, `event_type`, `transparency`, `visibility`, `own_response`, `organizer_identity_id`, `join_url`, `join_key`, `conference`, `url`, `sequence`, `etag`, `external_updated_at`, `metadata`, `seen_at`, `created_at`, `updated_at`, `deleted_at`, `series_external_id`) SELECT `id`, `calendar_id`, `kind`, `series_entry_id`, `event_id`, `event_series_id`, `external_id`, `ical_uid`, `original_starts_at`, `exception`, `status`, `title`, `description`, `location`, `starts_at`, `ends_at`, `all_day`, `start_date`, `end_date`, `timezone`, `recurrence`, `recurrence_ends_at`, `event_type`, `transparency`, `visibility`, `own_response`, `organizer_identity_id`, `join_url`, `join_key`, `conference`, `url`, `sequence`, `etag`, `external_updated_at`, `metadata`, `seen_at`, `created_at`, `updated_at`, `deleted_at`, `series_external_id` FROM `calendar_entries`;--> statement-breakpoint
DROP TABLE `calendar_entries`;--> statement-breakpoint
ALTER TABLE `__new_calendar_entries` RENAME TO `calendar_entries`;--> statement-breakpoint
CREATE TABLE `__new_catalog_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`sku` text,
	`supplier_type` text,
	`supplier_id` integer,
	`unit` text,
	`unit_price` integer,
	`currency` text,
	`description` text,
	`archived_date` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "catalog_items_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "catalog_items_supplier_pair" CHECK(("supplier_type" IS NULL) = ("supplier_id" IS NULL)),
	CONSTRAINT "catalog_items_unit_price_not_negative" CHECK("unit_price" IS NULL OR "unit_price" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_catalog_items`(`id`, `kind`, `name`, `name_folded`, `sku`, `supplier_type`, `supplier_id`, `unit`, `unit_price`, `currency`, `description`, `archived_date`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `kind`, `name`, `name_folded`, `sku`, `supplier_type`, `supplier_id`, `unit`, `unit_price`, `currency`, `description`, `archived_date`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `catalog_items`;--> statement-breakpoint
DROP TABLE `catalog_items`;--> statement-breakpoint
ALTER TABLE `__new_catalog_items` RENAME TO `catalog_items`;--> statement-breakpoint
CREATE TABLE `__new_chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`unread_count` integer,
	`last_message_at` integer,
	`participants_count` integer,
	`metadata` text,
	`updated_at` integer NOT NULL,
	`username` text,
	`membership_state` text,
	`searchable` integer DEFAULT 1 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`members_tracked_at` integer,
	`description` text,
	`details_fetched_at` integer,
	`created_at` integer NOT NULL,
	`parent_chat_id` integer,
	`scope` text,
	`muted` integer,
	`muted_until` integer,
	`archived` integer,
	`marked_unread` integer,
	`unread_counted_at` integer,
	`title_folded` text,
	CONSTRAINT `fk_chats_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_chats_parent_chat_id_chats_id_fk` FOREIGN KEY (`parent_chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `chats_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "chats_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_chats`(`id`, `account_id`, `external_id`, `kind`, `title`, `unread_count`, `last_message_at`, `participants_count`, `metadata`, `updated_at`, `username`, `membership_state`, `searchable`, `message_count`, `members_tracked_at`, `description`, `details_fetched_at`, `created_at`, `parent_chat_id`, `scope`, `muted`, `muted_until`, `archived`, `marked_unread`, `unread_counted_at`, `title_folded`) SELECT `id`, `account_id`, `external_id`, `kind`, `title`, `unread_count`, `last_message_at`, `participants_count`, `metadata`, `updated_at`, `username`, `membership_state`, `searchable`, `message_count`, `members_tracked_at`, `description`, `details_fetched_at`, `created_at`, `parent_chat_id`, `scope`, `muted`, `muted_until`, `archived`, `marked_unread`, `unread_counted_at`, `title_folded` FROM `chats`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
ALTER TABLE `__new_chats` RENAME TO `chats`;--> statement-breakpoint
CREATE TABLE `__new_content_authors` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`data` text NOT NULL,
	`source_updated_at` integer,
	`deleted_at` integer,
	`synced_at` integer NOT NULL,
	CONSTRAINT `fk_content_authors_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `content_authors_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "content_authors_data_json" CHECK("data" IS NULL OR json_valid("data"))
);
--> statement-breakpoint
INSERT INTO `__new_content_authors`(`id`, `account_id`, `external_id`, `name`, `email`, `data`, `source_updated_at`, `deleted_at`, `synced_at`) SELECT `id`, `account_id`, `external_id`, `name`, `email`, `data`, `source_updated_at`, `deleted_at`, `synced_at` FROM `content_authors`;--> statement-breakpoint
DROP TABLE `content_authors`;--> statement-breakpoint
ALTER TABLE `__new_content_authors` RENAME TO `content_authors`;--> statement-breakpoint
CREATE TABLE `__new_content_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`post_id` integer NOT NULL,
	`at` integer NOT NULL,
	`views` integer,
	`reactions` integer,
	`comments` integer,
	`shares` integer,
	`clicks` integer,
	`raw` text,
	CONSTRAINT `fk_content_metrics_post_id_content_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `content_posts`(`id`),
	CONSTRAINT "content_metrics_raw_json" CHECK("raw" IS NULL OR json_valid("raw"))
);
--> statement-breakpoint
INSERT INTO `__new_content_metrics`(`id`, `post_id`, `at`, `views`, `reactions`, `comments`, `shares`, `clicks`, `raw`) SELECT `id`, `post_id`, `at`, `views`, `reactions`, `comments`, `shares`, `clicks`, `raw` FROM `content_metrics`;--> statement-breakpoint
DROP TABLE `content_metrics`;--> statement-breakpoint
ALTER TABLE `__new_content_metrics` RENAME TO `content_metrics`;--> statement-breakpoint
CREATE TABLE `__new_content_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`channel_id` text,
	`type` text NOT NULL,
	`title` text,
	`title_folded` text NOT NULL,
	`body` text,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`published_at` integer,
	`scheduled_for` integer,
	`source_created_at` integer,
	`source_updated_at` integer,
	`version` text,
	`normalized_text` text NOT NULL,
	`data` text NOT NULL,
	`deleted_at` integer,
	`synced_at` integer NOT NULL,
	CONSTRAINT `fk_content_posts_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `content_posts_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "content_posts_data_json" CHECK("data" IS NULL OR json_valid("data"))
);
--> statement-breakpoint
INSERT INTO `__new_content_posts`(`id`, `account_id`, `external_id`, `channel_id`, `type`, `title`, `title_folded`, `body`, `content_hash`, `status`, `published_at`, `scheduled_for`, `source_created_at`, `source_updated_at`, `version`, `normalized_text`, `data`, `deleted_at`, `synced_at`) SELECT `id`, `account_id`, `external_id`, `channel_id`, `type`, `title`, `title_folded`, `body`, `content_hash`, `status`, `published_at`, `scheduled_for`, `source_created_at`, `source_updated_at`, `version`, `normalized_text`, `data`, `deleted_at`, `synced_at` FROM `content_posts`;--> statement-breakpoint
DROP TABLE `content_posts`;--> statement-breakpoint
ALTER TABLE `__new_content_posts` RENAME TO `content_posts`;--> statement-breakpoint
CREATE TABLE `__new_content_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`parent_id` text,
	`tag_id` integer,
	`data` text NOT NULL,
	`source_updated_at` integer,
	`deleted_at` integer,
	`synced_at` integer NOT NULL,
	CONSTRAINT `fk_content_terms_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_content_terms_tag_id_canonical_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `canonical_tags`(`id`),
	CONSTRAINT `content_terms_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "content_terms_data_json" CHECK("data" IS NULL OR json_valid("data"))
);
--> statement-breakpoint
INSERT INTO `__new_content_terms`(`id`, `account_id`, `external_id`, `kind`, `name`, `slug`, `parent_id`, `tag_id`, `data`, `source_updated_at`, `deleted_at`, `synced_at`) SELECT `id`, `account_id`, `external_id`, `kind`, `name`, `slug`, `parent_id`, `tag_id`, `data`, `source_updated_at`, `deleted_at`, `synced_at` FROM `content_terms`;--> statement-breakpoint
DROP TABLE `content_terms`;--> statement-breakpoint
ALTER TABLE `__new_content_terms` RENAME TO `content_terms`;--> statement-breakpoint
CREATE TABLE `__new_contracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`number` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`signed_date` text,
	`effective_date` text,
	`expiration_date` text,
	`auto_renew` integer DEFAULT 0 NOT NULL,
	`renewal_count` integer,
	`renewal_unit` text,
	`notice_days` integer,
	`terms` text,
	`value` integer,
	`currency` text,
	`project_id` integer,
	`deal_id` integer,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_contracts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_contracts_deal_id_deals_id_fk` FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`),
	CONSTRAINT "contracts_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "contracts_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL)),
	CONSTRAINT "contracts_value_not_negative" CHECK("value" IS NULL OR "value" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_contracts`(`id`, `name`, `number`, `kind`, `status`, `signed_date`, `effective_date`, `expiration_date`, `auto_renew`, `renewal_count`, `renewal_unit`, `notice_days`, `terms`, `value`, `currency`, `project_id`, `deal_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `name`, `number`, `kind`, `status`, `signed_date`, `effective_date`, `expiration_date`, `auto_renew`, `renewal_count`, `renewal_unit`, `notice_days`, `terms`, `value`, `currency`, `project_id`, `deal_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `contracts`;--> statement-breakpoint
DROP TABLE `contracts`;--> statement-breakpoint
ALTER TABLE `__new_contracts` RENAME TO `contracts`;--> statement-breakpoint
CREATE TABLE `__new_crm_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
	CONSTRAINT `crm_fields_account_id_kind_code_unique` UNIQUE(`account_id`,`kind`,`code`),
	CONSTRAINT "crm_fields_options_json" CHECK("options" IS NULL OR json_valid("options"))
);
--> statement-breakpoint
INSERT INTO `__new_crm_fields`(`id`, `account_id`, `kind`, `code`, `label`, `type`, `multiple`, `filterable`, `options`, `position`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `account_id`, `kind`, `code`, `label`, `type`, `multiple`, `filterable`, `options`, `position`, `created_at`, `updated_at`, `deleted_at` FROM `crm_fields`;--> statement-breakpoint
DROP TABLE `crm_fields`;--> statement-breakpoint
ALTER TABLE `__new_crm_fields` RENAME TO `crm_fields`;--> statement-breakpoint
CREATE TABLE `__new_deals` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`organization_id` integer,
	`project_id` integer,
	`stage_id` integer NOT NULL,
	`status` text NOT NULL,
	`currency` text,
	`amount` integer,
	`close_date` text,
	`closed_date` text,
	`rank` real,
	`account_id` integer,
	`external_id` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_deals_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_deals_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_deals_stage_id_pipeline_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `pipeline_stages`(`id`),
	CONSTRAINT `fk_deals_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT "deals_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "deals_amount_not_negative" CHECK("amount" IS NULL OR "amount" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_deals`(`id`, `title`, `organization_id`, `project_id`, `stage_id`, `status`, `currency`, `amount`, `close_date`, `closed_date`, `rank`, `account_id`, `external_id`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `title`, `organization_id`, `project_id`, `stage_id`, `status`, `currency`, `amount`, `close_date`, `closed_date`, `rank`, `account_id`, `external_id`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `deals`;--> statement-breakpoint
DROP TABLE `deals`;--> statement-breakpoint
ALTER TABLE `__new_deals` RENAME TO `deals`;--> statement-breakpoint
CREATE TABLE `__new_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` integer,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`decided_at` integer,
	`supersedes_id` integer,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_decisions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_decisions_supersedes_id_decisions_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `decisions`(`id`),
	CONSTRAINT "decisions_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "decisions_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_decisions`(`id`, `project_id`, `statement`, `status`, `decided_at`, `supersedes_id`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `project_id`, `statement`, `status`, `decided_at`, `supersedes_id`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `decisions`;--> statement-breakpoint
DROP TABLE `decisions`;--> statement-breakpoint
ALTER TABLE `__new_decisions` RENAME TO `decisions`;--> statement-breakpoint
CREATE TABLE `__new_document_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`document_id` integer NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`title` text,
	`front_matter` text,
	`reason` text,
	CONSTRAINT `fk_document_revisions_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`),
	CONSTRAINT "document_revisions_front_matter_json" CHECK("front_matter" IS NULL OR json_valid("front_matter"))
);
--> statement-breakpoint
INSERT INTO `__new_document_revisions`(`id`, `document_id`, `body`, `revision`, `created_at`, `title`, `front_matter`, `reason`) SELECT `id`, `document_id`, `body`, `revision`, `created_at`, `title`, `front_matter`, `reason` FROM `document_revisions`;--> statement-breakpoint
DROP TABLE `document_revisions`;--> statement-breakpoint
ALTER TABLE `__new_document_revisions` RENAME TO `document_revisions`;--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`location` text,
	`file_name` text,
	`extension` text,
	`url` text,
	`storage` text,
	`local_path` text,
	`mime` text,
	`size` integer,
	`content_hash` text,
	`front_matter` text,
	`body` text,
	`normalized_text` text,
	`extraction` text,
	`extraction_error` text,
	`language` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`export_path` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`pinned_file_id` integer,
	`removal` text,
	CONSTRAINT `fk_documents_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `documents_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "documents_front_matter_json" CHECK("front_matter" IS NULL OR json_valid("front_matter")),
	CONSTRAINT "documents_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_documents`(`id`, `account_id`, `external_id`, `kind`, `title`, `location`, `file_name`, `extension`, `url`, `storage`, `local_path`, `mime`, `size`, `content_hash`, `front_matter`, `body`, `normalized_text`, `extraction`, `extraction_error`, `language`, `revision`, `export_path`, `external_created_at`, `external_updated_at`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `pinned_file_id`, `removal`) SELECT `id`, `account_id`, `external_id`, `kind`, `title`, `location`, `file_name`, `extension`, `url`, `storage`, `local_path`, `mime`, `size`, `content_hash`, `front_matter`, `body`, `normalized_text`, `extraction`, `extraction_error`, `language`, `revision`, `export_path`, `external_created_at`, `external_updated_at`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `pinned_file_id`, `removal` FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
CREATE TABLE `__new_email_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`subject` text,
	`last_email_at` integer,
	`emails_count` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`subject_folded` text,
	CONSTRAINT `fk_email_threads_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `email_threads_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "email_threads_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_email_threads`(`id`, `account_id`, `external_id`, `subject`, `last_email_at`, `emails_count`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `subject_folded`) SELECT `id`, `account_id`, `external_id`, `subject`, `last_email_at`, `emails_count`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `subject_folded` FROM `email_threads`;--> statement-breakpoint
DROP TABLE `email_threads`;--> statement-breakpoint
ALTER TABLE `__new_email_threads` RENAME TO `email_threads`;--> statement-breakpoint
CREATE TABLE `__new_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`email_thread_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`subject` text,
	`from_identity_id` integer,
	`from_address` text,
	`from_name` text,
	`sent_at` integer,
	`received_at` integer,
	`in_reply_to` text,
	`references` text,
	`body_text` text,
	`body_html` text,
	`snippet` text,
	`outgoing` integer,
	`read` integer,
	`flagged` integer,
	`draft` integer,
	`size` integer,
	`headers` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`mail_rule_id` integer,
	CONSTRAINT `fk_emails_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_emails_email_thread_id_email_threads_id_fk` FOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`),
	CONSTRAINT `fk_emails_from_identity_id_identities_id_fk` FOREIGN KEY (`from_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `emails_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "emails_references_json" CHECK("references" IS NULL OR json_valid("references")),
	CONSTRAINT "emails_headers_json" CHECK("headers" IS NULL OR json_valid("headers")),
	CONSTRAINT "emails_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_emails`(`id`, `account_id`, `email_thread_id`, `external_id`, `subject`, `from_identity_id`, `from_address`, `from_name`, `sent_at`, `received_at`, `in_reply_to`, `references`, `body_text`, `body_html`, `snippet`, `outgoing`, `read`, `flagged`, `draft`, `size`, `headers`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `mail_rule_id`) SELECT `id`, `account_id`, `email_thread_id`, `external_id`, `subject`, `from_identity_id`, `from_address`, `from_name`, `sent_at`, `received_at`, `in_reply_to`, `references`, `body_text`, `body_html`, `snippet`, `outgoing`, `read`, `flagged`, `draft`, `size`, `headers`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `mail_rule_id` FROM `emails`;--> statement-breakpoint
DROP TABLE `emails`;--> statement-breakpoint
ALTER TABLE `__new_emails` RENAME TO `emails`;--> statement-breakpoint
CREATE TABLE `__new_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`project_id` integer,
	`subject_type` text,
	`subject_id` integer,
	`occurred_at` integer,
	`supersedes_id` integer,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`scope` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_facts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_facts_supersedes_id_facts_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `facts`(`id`),
	CONSTRAINT "facts_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "facts_subject_pair" CHECK(("subject_type" IS NULL) = ("subject_id" IS NULL)),
	CONSTRAINT "facts_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_facts`(`id`, `type`, `statement`, `status`, `project_id`, `subject_type`, `subject_id`, `occurred_at`, `supersedes_id`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `scope`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `type`, `statement`, `status`, `project_id`, `subject_type`, `subject_id`, `occurred_at`, `supersedes_id`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `scope`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `facts`;--> statement-breakpoint
DROP TABLE `facts`;--> statement-breakpoint
ALTER TABLE `__new_facts` RENAME TO `facts`;--> statement-breakpoint
CREATE TABLE `__new_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
	CONSTRAINT `files_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "files_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_files`(`id`, `account_id`, `external_id`, `kind`, `name`, `path`, `path_folded`, `parent_id`, `document_id`, `mime`, `size`, `content_hash`, `url`, `external_created_at`, `external_updated_at`, `metadata`, `seen_at`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `account_id`, `external_id`, `kind`, `name`, `path`, `path_folded`, `parent_id`, `document_id`, `mime`, `size`, `content_hash`, `url`, `external_created_at`, `external_updated_at`, `metadata`, `seen_at`, `created_at`, `updated_at`, `deleted_at` FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
CREATE TABLE `__new_financial_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`institution` text,
	`number_hint` text,
	`holder_type` text,
	`holder_id` integer,
	`opening_balance` integer,
	`opening_date` text,
	`closed_date` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "financial_accounts_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "financial_accounts_holder_pair" CHECK(("holder_type" IS NULL) = ("holder_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_financial_accounts`(`id`, `name`, `name_folded`, `kind`, `currency`, `institution`, `number_hint`, `holder_type`, `holder_id`, `opening_balance`, `opening_date`, `closed_date`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `name`, `name_folded`, `kind`, `currency`, `institution`, `number_hint`, `holder_type`, `holder_id`, `opening_balance`, `opening_date`, `closed_date`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `financial_accounts`;--> statement-breakpoint
DROP TABLE `financial_accounts`;--> statement-breakpoint
ALTER TABLE `__new_financial_accounts` RENAME TO `financial_accounts`;--> statement-breakpoint
CREATE TABLE `__new_financial_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`financial_account_id` integer NOT NULL,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`statement_date` text NOT NULL,
	`booked_date` text,
	`description` text,
	`counterparty_name` text,
	`counterparty_type` text,
	`counterparty_id` integer,
	`reference` text,
	`payment_id` integer,
	`project_id` integer,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_financial_transactions_financial_account_id_financial_accounts_id_fk` FOREIGN KEY (`financial_account_id`) REFERENCES `financial_accounts`(`id`),
	CONSTRAINT `fk_financial_transactions_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_financial_transactions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "financial_transactions_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "financial_transactions_counterparty_pair" CHECK(("counterparty_type" IS NULL) = ("counterparty_id" IS NULL)),
	CONSTRAINT "financial_transactions_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_financial_transactions`(`id`, `financial_account_id`, `direction`, `amount`, `currency`, `status`, `statement_date`, `booked_date`, `description`, `counterparty_name`, `counterparty_type`, `counterparty_id`, `reference`, `payment_id`, `project_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `financial_account_id`, `direction`, `amount`, `currency`, `status`, `statement_date`, `booked_date`, `description`, `counterparty_name`, `counterparty_type`, `counterparty_id`, `reference`, `payment_id`, `project_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `financial_transactions`;--> statement-breakpoint
DROP TABLE `financial_transactions`;--> statement-breakpoint
ALTER TABLE `__new_financial_transactions` RENAME TO `financial_transactions`;--> statement-breakpoint
CREATE TABLE `__new_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`username` text,
	`name` text,
	`bot` integer,
	`phone_hmac` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`description` text,
	`email` text,
	`phone` text,
	`name_folded` text,
	CONSTRAINT `identities_provider_external_id_unique` UNIQUE(`provider`,`external_id`),
	CONSTRAINT "identities_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_identities`(`id`, `provider`, `external_id`, `username`, `name`, `bot`, `phone_hmac`, `metadata`, `created_at`, `updated_at`, `description`, `email`, `phone`, `name_folded`) SELECT `id`, `provider`, `external_id`, `username`, `name`, `bot`, `phone_hmac`, `metadata`, `created_at`, `updated_at`, `description`, `email`, `phone`, `name_folded` FROM `identities`;--> statement-breakpoint
DROP TABLE `identities`;--> statement-breakpoint
ALTER TABLE `__new_identities` RENAME TO `identities`;--> statement-breakpoint
CREATE TABLE `__new_identity_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`identity_id` integer NOT NULL,
	`name` text,
	`username` text,
	`description` text,
	`marks` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_identity_revisions_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT "identity_revisions_marks_json" CHECK("marks" IS NULL OR json_valid("marks"))
);
--> statement-breakpoint
INSERT INTO `__new_identity_revisions`(`id`, `identity_id`, `name`, `username`, `description`, `marks`, `created_at`) SELECT `id`, `identity_id`, `name`, `username`, `description`, `marks`, `created_at` FROM `identity_revisions`;--> statement-breakpoint
DROP TABLE `identity_revisions`;--> statement-breakpoint
ALTER TABLE `__new_identity_revisions` RENAME TO `identity_revisions`;--> statement-breakpoint
CREATE TABLE `__new_invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`invoice_id` integer NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` integer,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`catalog_item_id` integer,
	CONSTRAINT `fk_invoice_lines_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`),
	CONSTRAINT `fk_invoice_lines_catalog_item_id_catalog_items_id_fk` FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`),
	CONSTRAINT `invoice_lines_invoice_id_position_unique` UNIQUE(`invoice_id`,`position`),
	CONSTRAINT "invoice_lines_amount_not_negative" CHECK("amount" IS NULL OR "amount" >= 0),
	CONSTRAINT "invoice_lines_unit_price_not_negative" CHECK("unit_price" IS NULL OR "unit_price" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_invoice_lines`(`id`, `invoice_id`, `position`, `description`, `quantity`, `unit_price`, `amount`, `created_at`, `updated_at`, `catalog_item_id`) SELECT `id`, `invoice_id`, `position`, `description`, `quantity`, `unit_price`, `amount`, `created_at`, `updated_at`, `catalog_item_id` FROM `invoice_lines`;--> statement-breakpoint
DROP TABLE `invoice_lines`;--> statement-breakpoint
ALTER TABLE `__new_invoice_lines` RENAME TO `invoice_lines`;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`direction` text NOT NULL,
	`number` text,
	`issuer_type` text,
	`issuer_id` integer,
	`counterparty_type` text NOT NULL,
	`counterparty_id` integer NOT NULL,
	`project_id` integer,
	`currency` text NOT NULL,
	`total` integer NOT NULL,
	`issue_date` text,
	`due_date` text,
	`status` text NOT NULL,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`contract_id` integer,
	`subscription_id` integer,
	CONSTRAINT `fk_invoices_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_invoices_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`),
	CONSTRAINT `fk_invoices_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`),
	CONSTRAINT "invoices_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "invoices_issuer_pair" CHECK(("issuer_type" IS NULL) = ("issuer_id" IS NULL)),
	CONSTRAINT "invoices_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL)),
	CONSTRAINT "invoices_total_not_negative" CHECK("total" IS NULL OR "total" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_invoices`(`id`, `direction`, `number`, `issuer_type`, `issuer_id`, `counterparty_type`, `counterparty_id`, `project_id`, `currency`, `total`, `issue_date`, `due_date`, `status`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `contract_id`, `subscription_id`) SELECT `id`, `direction`, `number`, `issuer_type`, `issuer_id`, `counterparty_type`, `counterparty_id`, `project_id`, `currency`, `total`, `issue_date`, `due_date`, `status`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `contract_id`, `subscription_id` FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
CREATE TABLE `__new_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`organization_id` integer,
	`project_id` integer,
	`stage_id` integer NOT NULL,
	`status` text NOT NULL,
	`currency` text,
	`amount` integer,
	`close_date` text,
	`closed_date` text,
	`rank` real,
	`deal_id` integer,
	`account_id` integer,
	`external_id` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_leads_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_leads_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_leads_stage_id_pipeline_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `pipeline_stages`(`id`),
	CONSTRAINT `fk_leads_deal_id_deals_id_fk` FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`),
	CONSTRAINT `fk_leads_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT "leads_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "leads_amount_not_negative" CHECK("amount" IS NULL OR "amount" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_leads`(`id`, `title`, `organization_id`, `project_id`, `stage_id`, `status`, `currency`, `amount`, `close_date`, `closed_date`, `rank`, `deal_id`, `account_id`, `external_id`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `title`, `organization_id`, `project_id`, `stage_id`, `status`, `currency`, `amount`, `close_date`, `closed_date`, `rank`, `deal_id`, `account_id`, `external_id`, `author_type`, `author_id`, `model`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `leads`;--> statement-breakpoint
DROP TABLE `leads`;--> statement-breakpoint
ALTER TABLE `__new_leads` RENAME TO `leads`;--> statement-breakpoint
CREATE TABLE `__new_link_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
	CONSTRAINT `link_reviews_linkable_type_linkable_id_entity_type_unique` UNIQUE(`linkable_type`,`linkable_id`,`entity_type`),
	CONSTRAINT "link_reviews_candidates_json" CHECK("candidates" IS NULL OR json_valid("candidates"))
);
--> statement-breakpoint
INSERT INTO `__new_link_reviews`(`id`, `linkable_type`, `linkable_id`, `entity_type`, `candidates`, `reason`, `status`, `chosen_id`, `decided_by`, `decided_at`, `created_at`, `updated_at`) SELECT `id`, `linkable_type`, `linkable_id`, `entity_type`, `candidates`, `reason`, `status`, `chosen_id`, `decided_by`, `decided_at`, `created_at`, `updated_at` FROM `link_reviews`;--> statement-breakpoint
DROP TABLE `link_reviews`;--> statement-breakpoint
ALTER TABLE `__new_link_reviews` RENAME TO `link_reviews`;--> statement-breakpoint
CREATE TABLE `__new_link_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`link_id` integer NOT NULL,
	`change` text NOT NULL,
	`before` text,
	`after` text,
	`author` text,
	`account_id` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "link_revisions_before_json" CHECK("before" IS NULL OR json_valid("before"))
);
--> statement-breakpoint
INSERT INTO `__new_link_revisions`(`id`, `link_id`, `change`, `before`, `after`, `author`, `account_id`, `created_at`) SELECT `id`, `link_id`, `change`, `before`, `after`, `author`, `account_id`, `created_at` FROM `link_revisions`;--> statement-breakpoint
DROP TABLE `link_revisions`;--> statement-breakpoint
ALTER TABLE `__new_link_revisions` RENAME TO `link_revisions`;--> statement-breakpoint
CREATE TABLE `__new_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`from_type` text NOT NULL,
	`from_id` integer NOT NULL,
	`to_type` text,
	`to_id` integer,
	`kind` text NOT NULL,
	`anchor` text,
	`source` text NOT NULL,
	`target_text` text,
	`target_folded` text,
	`role` text,
	`evidence` text,
	`metadata` text,
	`confirmed` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`author` text,
	`updated_at` integer NOT NULL,
	`purpose` text,
	`account_id` integer,
	`starts_at` integer,
	`ends_at` integer,
	`deleted_at` integer,
	CONSTRAINT "links_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_links`(`id`, `from_type`, `from_id`, `to_type`, `to_id`, `kind`, `anchor`, `source`, `target_text`, `target_folded`, `role`, `evidence`, `metadata`, `confirmed`, `created_at`, `author`, `updated_at`, `purpose`, `account_id`, `starts_at`, `ends_at`, `deleted_at`) SELECT `id`, `from_type`, `from_id`, `to_type`, `to_id`, `kind`, `anchor`, `source`, `target_text`, `target_folded`, `role`, `evidence`, `metadata`, `confirmed`, `created_at`, `author`, `updated_at`, `purpose`, `account_id`, `starts_at`, `ends_at`, `deleted_at` FROM `links`;--> statement-breakpoint
DROP TABLE `links`;--> statement-breakpoint
ALTER TABLE `__new_links` RENAME TO `links`;--> statement-breakpoint
CREATE TABLE `__new_mail_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`protected` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`reason` text,
	`decided_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_mail_rules_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `mail_rules_account_id_conditions_unique` UNIQUE(`account_id`,`conditions`),
	CONSTRAINT "mail_rules_conditions_json" CHECK("conditions" IS NULL OR json_valid("conditions")),
	CONSTRAINT "mail_rules_actions_json" CHECK("actions" IS NULL OR json_valid("actions"))
);
--> statement-breakpoint
INSERT INTO `__new_mail_rules`(`id`, `account_id`, `conditions`, `actions`, `protected`, `source`, `reason`, `decided_at`, `created_at`, `updated_at`) SELECT `id`, `account_id`, `conditions`, `actions`, `protected`, `source`, `reason`, `decided_at`, `created_at`, `updated_at` FROM `mail_rules`;--> statement-breakpoint
DROP TABLE `mail_rules`;--> statement-breakpoint
ALTER TABLE `__new_mail_rules` RENAME TO `mail_rules`;--> statement-breakpoint
CREATE TABLE `__new_meeting_chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`meeting_id` integer NOT NULL,
	`external_id` text,
	`sent_at` integer NOT NULL,
	`sender_participant_id` integer,
	`sender_name` text,
	`recipient` text,
	`text` text NOT NULL,
	`normalized_text` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_chat_messages_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `fk_meeting_chat_messages_sender_participant_id_meeting_participants_id_fk` FOREIGN KEY (`sender_participant_id`) REFERENCES `meeting_participants`(`id`),
	CONSTRAINT "meeting_chat_messages_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_chat_messages`(`id`, `meeting_id`, `external_id`, `sent_at`, `sender_participant_id`, `sender_name`, `recipient`, `text`, `normalized_text`, `metadata`, `created_at`, `updated_at`) SELECT `id`, `meeting_id`, `external_id`, `sent_at`, `sender_participant_id`, `sender_name`, `recipient`, `text`, `normalized_text`, `metadata`, `created_at`, `updated_at` FROM `meeting_chat_messages`;--> statement-breakpoint
DROP TABLE `meeting_chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_meeting_chat_messages` RENAME TO `meeting_chat_messages`;--> statement-breakpoint
CREATE TABLE `__new_meeting_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`meeting_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`display_name` text,
	`email` text,
	`role` text,
	`joined_at` integer,
	`left_at` integer,
	`duration_ms` integer,
	`sessions` text,
	`external_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_participants_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `fk_meeting_participants_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meeting_participants_meeting_id_identity_id_unique` UNIQUE(`meeting_id`,`identity_id`),
	CONSTRAINT "meeting_participants_sessions_json" CHECK("sessions" IS NULL OR json_valid("sessions")),
	CONSTRAINT "meeting_participants_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_participants`(`id`, `meeting_id`, `identity_id`, `display_name`, `email`, `role`, `joined_at`, `left_at`, `duration_ms`, `sessions`, `external_id`, `metadata`, `created_at`, `updated_at`) SELECT `id`, `meeting_id`, `identity_id`, `display_name`, `email`, `role`, `joined_at`, `left_at`, `duration_ms`, `sessions`, `external_id`, `metadata`, `created_at`, `updated_at` FROM `meeting_participants`;--> statement-breakpoint
DROP TABLE `meeting_participants`;--> statement-breakpoint
ALTER TABLE `__new_meeting_participants` RENAME TO `meeting_participants`;--> statement-breakpoint
CREATE TABLE `__new_meeting_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`event_series_id` integer,
	`title` text,
	`description` text,
	`kind` text,
	`recurrence` text,
	`host_identity_id` integer,
	`join_url` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meeting_series_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_meeting_series_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),
	CONSTRAINT `fk_meeting_series_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meeting_series_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "meeting_series_recurrence_json" CHECK("recurrence" IS NULL OR json_valid("recurrence")),
	CONSTRAINT "meeting_series_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_series`(`id`, `account_id`, `external_id`, `event_series_id`, `title`, `description`, `kind`, `recurrence`, `host_identity_id`, `join_url`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `account_id`, `external_id`, `event_series_id`, `title`, `description`, `kind`, `recurrence`, `host_identity_id`, `join_url`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `meeting_series`;--> statement-breakpoint
DROP TABLE `meeting_series`;--> statement-breakpoint
ALTER TABLE `__new_meeting_series` RENAME TO `meeting_series`;--> statement-breakpoint
CREATE TABLE `__new_meeting_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`title` text,
	`overview` text,
	`sections` text,
	`next_steps` text,
	`content` text,
	`doc_url` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_summaries_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `meeting_summaries_meeting_id_source_unique` UNIQUE(`meeting_id`,`source`),
	CONSTRAINT "meeting_summaries_sections_json" CHECK("sections" IS NULL OR json_valid("sections")),
	CONSTRAINT "meeting_summaries_next_steps_json" CHECK("next_steps" IS NULL OR json_valid("next_steps")),
	CONSTRAINT "meeting_summaries_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_summaries`(`id`, `meeting_id`, `source`, `title`, `overview`, `sections`, `next_steps`, `content`, `doc_url`, `external_created_at`, `external_updated_at`, `metadata`, `created_at`, `updated_at`) SELECT `id`, `meeting_id`, `source`, `title`, `overview`, `sections`, `next_steps`, `content`, `doc_url`, `external_created_at`, `external_updated_at`, `metadata`, `created_at`, `updated_at` FROM `meeting_summaries`;--> statement-breakpoint
DROP TABLE `meeting_summaries`;--> statement-breakpoint
ALTER TABLE `__new_meeting_summaries` RENAME TO `meeting_summaries`;--> statement-breakpoint
CREATE TABLE `__new_meeting_transcript_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`meeting_transcript_id` integer NOT NULL,
	`position` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`speaker_participant_id` integer,
	`speaker_name` text,
	`text` text NOT NULL,
	`normalized_text` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_transcript_rows_meeting_transcript_id_meeting_transcripts_id_fk` FOREIGN KEY (`meeting_transcript_id`) REFERENCES `meeting_transcripts`(`id`),
	CONSTRAINT `fk_meeting_transcript_rows_speaker_participant_id_meeting_participants_id_fk` FOREIGN KEY (`speaker_participant_id`) REFERENCES `meeting_participants`(`id`),
	CONSTRAINT `meeting_transcript_rows_meeting_transcript_id_position_unique` UNIQUE(`meeting_transcript_id`,`position`),
	CONSTRAINT "meeting_transcript_rows_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_transcript_rows`(`id`, `meeting_transcript_id`, `position`, `start_ms`, `end_ms`, `speaker_participant_id`, `speaker_name`, `text`, `normalized_text`, `metadata`, `created_at`) SELECT `id`, `meeting_transcript_id`, `position`, `start_ms`, `end_ms`, `speaker_participant_id`, `speaker_name`, `text`, `normalized_text`, `metadata`, `created_at` FROM `meeting_transcript_rows`;--> statement-breakpoint
DROP TABLE `meeting_transcript_rows`;--> statement-breakpoint
ALTER TABLE `__new_meeting_transcript_rows` RENAME TO `meeting_transcript_rows`;--> statement-breakpoint
CREATE TABLE `__new_meeting_transcripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`format` text,
	`language` text,
	`content_hash` text,
	`external_created_at` integer,
	`superseded_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meeting_transcripts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT "meeting_transcripts_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_transcripts`(`id`, `meeting_id`, `source`, `format`, `language`, `content_hash`, `external_created_at`, `superseded_at`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `meeting_id`, `source`, `format`, `language`, `content_hash`, `external_created_at`, `superseded_at`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `meeting_transcripts`;--> statement-breakpoint
DROP TABLE `meeting_transcripts`;--> statement-breakpoint
ALTER TABLE `__new_meeting_transcripts` RENAME TO `meeting_transcripts`;--> statement-breakpoint
CREATE TABLE `__new_meetings` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`meeting_series_id` integer,
	`event_id` integer,
	`external_id` text NOT NULL,
	`title` text,
	`description` text,
	`location` text,
	`join_url` text,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`timezone` text,
	`host_identity_id` integer,
	`participants_count` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`title_folded` text,
	`join_key` text,
	`direction` text,
	`client_phone` text,
	CONSTRAINT `fk_meetings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_meetings_meeting_series_id_meeting_series_id_fk` FOREIGN KEY (`meeting_series_id`) REFERENCES `meeting_series`(`id`),
	CONSTRAINT `fk_meetings_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
	CONSTRAINT `fk_meetings_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meetings_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT "meetings_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_meetings`(`id`, `account_id`, `meeting_series_id`, `event_id`, `external_id`, `title`, `description`, `location`, `join_url`, `started_at`, `ended_at`, `duration_ms`, `timezone`, `host_identity_id`, `participants_count`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `title_folded`, `join_key`, `direction`, `client_phone`) SELECT `id`, `account_id`, `meeting_series_id`, `event_id`, `external_id`, `title`, `description`, `location`, `join_url`, `started_at`, `ended_at`, `duration_ms`, `timezone`, `host_identity_id`, `participants_count`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `title_folded`, `join_key`, `direction`, `client_phone` FROM `meetings`;--> statement-breakpoint
DROP TABLE `meetings`;--> statement-breakpoint
ALTER TABLE `__new_meetings` RENAME TO `meetings`;--> statement-breakpoint
CREATE TABLE `__new_memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`subject_type` text,
	`subject_id` integer,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confidence` real,
	`status` text NOT NULL,
	`last_verified_at` integer,
	`supersedes_id` integer,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`project_id` integer,
	CONSTRAINT `fk_memories_supersedes_id_memories_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`),
	CONSTRAINT `fk_memories_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "memories_subject_pair" CHECK(("subject_type" IS NULL) = ("subject_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_memories`(`id`, `kind`, `body`, `subject_type`, `subject_id`, `author_type`, `author_id`, `model`, `confidence`, `status`, `last_verified_at`, `supersedes_id`, `scope`, `created_at`, `updated_at`, `deleted_at`, `project_id`) SELECT `id`, `kind`, `body`, `subject_type`, `subject_id`, `author_type`, `author_id`, `model`, `confidence`, `status`, `last_verified_at`, `supersedes_id`, `scope`, `created_at`, `updated_at`, `deleted_at`, `project_id` FROM `memories`;--> statement-breakpoint
DROP TABLE `memories`;--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`thread_external_id` text,
	`sender_identity_id` integer,
	`sender_chat_external_id` text,
	`sender_name` text,
	`sent_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`text` text NOT NULL,
	`reply_to_external_id` text,
	`reply_to` text,
	`forward` text,
	`outgoing` integer,
	`reactions` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	`normalized_text` text,
	`normalizer_version` integer,
	`mentions` text,
	`updated_at` integer NOT NULL,
	`thread_root_id` integer,
	`starred` integer,
	`delivery` integer,
	CONSTRAINT `fk_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_messages_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_messages_sender_identity_id_identities_id_fk` FOREIGN KEY (`sender_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_messages_thread_root_id_messages_id_fk` FOREIGN KEY (`thread_root_id`) REFERENCES `messages`(`id`),
	CONSTRAINT `messages_chat_id_external_id_unique` UNIQUE(`chat_id`,`external_id`),
	CONSTRAINT "messages_reply_to_json" CHECK("reply_to" IS NULL OR json_valid("reply_to")),
	CONSTRAINT "messages_forward_json" CHECK("forward" IS NULL OR json_valid("forward")),
	CONSTRAINT "messages_reactions_json" CHECK("reactions" IS NULL OR json_valid("reactions")),
	CONSTRAINT "messages_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "messages_mentions_json" CHECK("mentions" IS NULL OR json_valid("mentions"))
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `chat_id`, `account_id`, `external_id`, `thread_external_id`, `sender_identity_id`, `sender_chat_external_id`, `sender_name`, `sent_at`, `edited_at`, `deleted_at`, `text`, `reply_to_external_id`, `reply_to`, `forward`, `outgoing`, `reactions`, `metadata`, `created_at`, `source`, `normalized_text`, `normalizer_version`, `mentions`, `updated_at`, `thread_root_id`, `starred`, `delivery`) SELECT `id`, `chat_id`, `account_id`, `external_id`, `thread_external_id`, `sender_identity_id`, `sender_chat_external_id`, `sender_name`, `sent_at`, `edited_at`, `deleted_at`, `text`, `reply_to_external_id`, `reply_to`, `forward`, `outgoing`, `reactions`, `metadata`, `created_at`, `source`, `normalized_text`, `normalizer_version`, `mentions`, `updated_at`, `thread_root_id`, `starred`, `delivery` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
CREATE TABLE `__new_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`notable_type` text NOT NULL,
	`notable_id` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`author_type` text,
	`author_id` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "notes_author_pair" CHECK(("author_type" IS NULL) = ("author_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_notes`(`id`, `notable_type`, `notable_id`, `title`, `body`, `author_type`, `author_id`, `revision`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `notable_type`, `notable_id`, `title`, `body`, `author_type`, `author_id`, `revision`, `created_at`, `updated_at`, `deleted_at` FROM `notes`;--> statement-breakpoint
DROP TABLE `notes`;--> statement-breakpoint
ALTER TABLE `__new_notes` RENAME TO `notes`;--> statement-breakpoint
CREATE TABLE `__new_order_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`order_id` integer NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` integer,
	`amount` integer NOT NULL,
	`catalog_item_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_order_lines_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`),
	CONSTRAINT `fk_order_lines_catalog_item_id_catalog_items_id_fk` FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`),
	CONSTRAINT `order_lines_order_id_position_unique` UNIQUE(`order_id`,`position`),
	CONSTRAINT "order_lines_amount_not_negative" CHECK("amount" IS NULL OR "amount" >= 0),
	CONSTRAINT "order_lines_unit_price_not_negative" CHECK("unit_price" IS NULL OR "unit_price" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_order_lines`(`id`, `order_id`, `position`, `description`, `quantity`, `unit_price`, `amount`, `catalog_item_id`, `created_at`, `updated_at`) SELECT `id`, `order_id`, `position`, `description`, `quantity`, `unit_price`, `amount`, `catalog_item_id`, `created_at`, `updated_at` FROM `order_lines`;--> statement-breakpoint
DROP TABLE `order_lines`;--> statement-breakpoint
ALTER TABLE `__new_order_lines` RENAME TO `order_lines`;--> statement-breakpoint
CREATE TABLE `__new_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`customer_type` text NOT NULL,
	`customer_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`supplier_type` text,
	`supplier_id` integer,
	`supplier_name` text NOT NULL,
	`number` text,
	`currency` text,
	`total` integer,
	`status` text NOT NULL,
	`order_date` text,
	`fulfilled_date` text,
	`invoice_id` integer,
	`payment_id` integer,
	`project_id` integer,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`source_url` text,
	`contract_id` integer,
	`deal_id` integer,
	`direction` text DEFAULT 'purchase' NOT NULL,
	CONSTRAINT `fk_orders_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`),
	CONSTRAINT `fk_orders_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_orders_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_orders_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`),
	CONSTRAINT `fk_orders_deal_id_deals_id_fk` FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`),
	CONSTRAINT "orders_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "orders_supplier_pair" CHECK(("supplier_type" IS NULL) = ("supplier_id" IS NULL)),
	CONSTRAINT "orders_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL)),
	CONSTRAINT "orders_total_not_negative" CHECK("total" IS NULL OR "total" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_orders`(`id`, `customer_type`, `customer_id`, `purpose`, `supplier_type`, `supplier_id`, `supplier_name`, `number`, `currency`, `total`, `status`, `order_date`, `fulfilled_date`, `invoice_id`, `payment_id`, `project_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `source_url`, `contract_id`, `deal_id`, `direction`) SELECT `id`, `customer_type`, `customer_id`, `purpose`, `supplier_type`, `supplier_id`, `supplier_name`, `number`, `currency`, `total`, `status`, `order_date`, `fulfilled_date`, `invoice_id`, `payment_id`, `project_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `source_url`, `contract_id`, `deal_id`, `direction` FROM `orders`;--> statement-breakpoint
DROP TABLE `orders`;--> statement-breakpoint
ALTER TABLE `__new_orders` RENAME TO `orders`;--> statement-breakpoint
CREATE TABLE `__new_organizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "organizations_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata"))
);
--> statement-breakpoint
INSERT INTO `__new_organizations`(`id`, `kind`, `name`, `scope`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `kind`, `name`, `scope`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `organizations`;--> statement-breakpoint
DROP TABLE `organizations`;--> statement-breakpoint
ALTER TABLE `__new_organizations` RENAME TO `organizations`;--> statement-breakpoint
CREATE TABLE `__new_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`direction` text NOT NULL,
	`payer_type` text,
	`payer_id` integer,
	`payee_type` text,
	`payee_id` integer,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`payment_date` text NOT NULL,
	`reference` text,
	`project_id` integer,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`refund_of` integer,
	`subscription_id` integer,
	CONSTRAINT `fk_payments_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_payments_refund_of_payments_id_fk` FOREIGN KEY (`refund_of`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_payments_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`),
	CONSTRAINT "payments_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "payments_payer_pair" CHECK(("payer_type" IS NULL) = ("payer_id" IS NULL)),
	CONSTRAINT "payments_payee_pair" CHECK(("payee_type" IS NULL) = ("payee_id" IS NULL)),
	CONSTRAINT "payments_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_payments`(`id`, `direction`, `payer_type`, `payer_id`, `payee_type`, `payee_id`, `amount`, `currency`, `payment_date`, `reference`, `project_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `refund_of`, `subscription_id`) SELECT `id`, `direction`, `payer_type`, `payer_id`, `payee_type`, `payee_id`, `amount`, `currency`, `payment_date`, `reference`, `project_id`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `refund_of`, `subscription_id` FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
CREATE TABLE `__new_poll_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`message_external_id` text NOT NULL,
	`identity_id` integer NOT NULL,
	`answers` text NOT NULL,
	`voted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_poll_votes_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_poll_votes_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `poll_votes_chat_id_message_external_id_identity_id_unique` UNIQUE(`chat_id`,`message_external_id`,`identity_id`),
	CONSTRAINT "poll_votes_answers_json" CHECK("answers" IS NULL OR json_valid("answers"))
);
--> statement-breakpoint
INSERT INTO `__new_poll_votes`(`id`, `chat_id`, `message_external_id`, `identity_id`, `answers`, `voted_at`, `created_at`, `updated_at`) SELECT `id`, `chat_id`, `message_external_id`, `identity_id`, `answers`, `voted_at`, `created_at`, `updated_at` FROM `poll_votes`;--> statement-breakpoint
DROP TABLE `poll_votes`;--> statement-breakpoint
ALTER TABLE `__new_poll_votes` RENAME TO `poll_votes`;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`organization_id` integer,
	`account_id` integer,
	`scope` text DEFAULT 'personal' NOT NULL,
	`owner_type` text,
	`owner_id` integer,
	`tasks_count` integer DEFAULT 0 NOT NULL,
	`status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`name_folded` text,
	CONSTRAINT `fk_projects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_projects_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT "projects_owner_pair" CHECK(("owner_type" IS NULL) = ("owner_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `key`, `name`, `description`, `type`, `organization_id`, `account_id`, `scope`, `owner_type`, `owner_id`, `tasks_count`, `status`, `created_at`, `updated_at`, `deleted_at`, `name_folded`) SELECT `id`, `key`, `name`, `description`, `type`, `organization_id`, `account_id`, `scope`, `owner_type`, `owner_id`, `tasks_count`, `status`, `created_at`, `updated_at`, `deleted_at`, `name_folded` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE TABLE `__new_proposed_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`account_id` integer,
	`target_type` text,
	`target_id` integer,
	`payload` text,
	`reason` text,
	`status` text NOT NULL,
	`proposed_by_type` text NOT NULL,
	`proposed_by_id` integer NOT NULL,
	`decided_by_type` text,
	`decided_by_id` integer,
	`decided_at` integer,
	`executed_at` integer,
	`result` text,
	`error` text,
	`verdict` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_proposed_actions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT "proposed_actions_payload_json" CHECK("payload" IS NULL OR json_valid("payload")),
	CONSTRAINT "proposed_actions_result_json" CHECK("result" IS NULL OR json_valid("result")),
	CONSTRAINT "proposed_actions_target_pair" CHECK(("target_type" IS NULL) = ("target_id" IS NULL)),
	CONSTRAINT "proposed_actions_decided_by_pair" CHECK(("decided_by_type" IS NULL) = ("decided_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_proposed_actions`(`id`, `kind`, `account_id`, `target_type`, `target_id`, `payload`, `reason`, `status`, `proposed_by_type`, `proposed_by_id`, `decided_by_type`, `decided_by_id`, `decided_at`, `executed_at`, `result`, `error`, `verdict`, `created_at`, `updated_at`) SELECT `id`, `kind`, `account_id`, `target_type`, `target_id`, `payload`, `reason`, `status`, `proposed_by_type`, `proposed_by_id`, `decided_by_type`, `decided_by_id`, `decided_at`, `executed_at`, `result`, `error`, `verdict`, `created_at`, `updated_at` FROM `proposed_actions`;--> statement-breakpoint
DROP TABLE `proposed_actions`;--> statement-breakpoint
ALTER TABLE `__new_proposed_actions` RENAME TO `proposed_actions`;--> statement-breakpoint
CREATE TABLE `__new_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
	`created_entity` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_records_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `records_account_id_type_external_id_unique` UNIQUE(`account_id`,`type`,`external_id`),
	CONSTRAINT "records_fields_json" CHECK("fields" IS NULL OR json_valid("fields")),
	CONSTRAINT "records_entity_pair" CHECK(("entity_type" IS NULL) = ("entity_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_records`(`id`, `account_id`, `type`, `external_id`, `fields`, `revision`, `fingerprint`, `entity_type`, `entity_id`, `projected_fingerprint`, `batch_id`, `created_at`, `updated_at`, `deleted_at`, `created_entity`) SELECT `id`, `account_id`, `type`, `external_id`, `fields`, `revision`, `fingerprint`, `entity_type`, `entity_id`, `projected_fingerprint`, `batch_id`, `created_at`, `updated_at`, `deleted_at`, `created_entity` FROM `records`;--> statement-breakpoint
DROP TABLE `records`;--> statement-breakpoint
ALTER TABLE `__new_records` RENAME TO `records`;--> statement-breakpoint
CREATE TABLE `__new_searches` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text UNIQUE,
	`command` text NOT NULL,
	`params` text NOT NULL,
	`language` text NOT NULL,
	`version` integer NOT NULL,
	`fields_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_run_at` integer,
	`runs` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "searches_params_json" CHECK("params" IS NULL OR json_valid("params"))
);
--> statement-breakpoint
INSERT INTO `__new_searches`(`id`, `name`, `command`, `params`, `language`, `version`, `fields_version`, `created_at`, `last_run_at`, `runs`, `updated_at`) SELECT `id`, `name`, `command`, `params`, `language`, `version`, `fields_version`, `created_at`, `last_run_at`, `runs`, `updated_at` FROM `searches`;--> statement-breakpoint
DROP TABLE `searches`;--> statement-breakpoint
ALTER TABLE `__new_searches` RENAME TO `searches`;--> statement-breakpoint
CREATE TABLE `__new_subscription_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`subscription_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`effective_from` text NOT NULL,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_subscription_prices_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`),
	CONSTRAINT "subscription_prices_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "subscription_prices_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL)),
	CONSTRAINT "subscription_prices_amount_not_negative" CHECK("amount" IS NULL OR "amount" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_subscription_prices`(`id`, `subscription_id`, `amount`, `currency`, `effective_from`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`) SELECT `id`, `subscription_id`, `amount`, `currency`, `effective_from`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at` FROM `subscription_prices`;--> statement-breakpoint
DROP TABLE `subscription_prices`;--> statement-breakpoint
ALTER TABLE `__new_subscription_prices` RENAME TO `subscription_prices`;--> statement-breakpoint
CREATE TABLE `__new_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`supplier_type` text NOT NULL,
	`supplier_id` integer NOT NULL,
	`customer_type` text NOT NULL,
	`customer_id` integer NOT NULL,
	`catalog_item_id` integer,
	`contract_id` integer,
	`project_id` integer,
	`status` text NOT NULL,
	`interval_count` integer NOT NULL,
	`interval_unit` text NOT NULL,
	`start_date` text NOT NULL,
	`trial_end_date` text,
	`next_renewal_date` text,
	`cancelled_date` text,
	`end_date` text,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_subscriptions_catalog_item_id_catalog_items_id_fk` FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`),
	CONSTRAINT `fk_subscriptions_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`),
	CONSTRAINT `fk_subscriptions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "subscriptions_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "subscriptions_confirmed_by_pair" CHECK(("confirmed_by_type" IS NULL) = ("confirmed_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_subscriptions`(`id`, `name`, `direction`, `supplier_type`, `supplier_id`, `customer_type`, `customer_id`, `catalog_item_id`, `contract_id`, `project_id`, `status`, `interval_count`, `interval_unit`, `start_date`, `trial_end_date`, `next_renewal_date`, `cancelled_date`, `end_date`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `name`, `direction`, `supplier_type`, `supplier_id`, `customer_type`, `customer_id`, `catalog_item_id`, `contract_id`, `project_id`, `status`, `interval_count`, `interval_unit`, `start_date`, `trial_end_date`, `next_renewal_date`, `cancelled_date`, `end_date`, `review`, `author_type`, `author_id`, `model`, `confirmed_by_type`, `confirmed_by_id`, `source`, `metadata`, `created_at`, `updated_at`, `deleted_at` FROM `subscriptions`;--> statement-breakpoint
DROP TABLE `subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_subscriptions` RENAME TO `subscriptions`;--> statement-breakpoint
CREATE TABLE `__new_syncs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`counts` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_syncs_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT "syncs_counts_json" CHECK("counts" IS NULL OR json_valid("counts"))
);
--> statement-breakpoint
INSERT INTO `__new_syncs`(`id`, `account_id`, `kind`, `started_at`, `finished_at`, `status`, `counts`, `error`, `created_at`, `updated_at`) SELECT `id`, `account_id`, `kind`, `started_at`, `finished_at`, `status`, `counts`, `error`, `created_at`, `updated_at` FROM `syncs`;--> statement-breakpoint
DROP TABLE `syncs`;--> statement-breakpoint
ALTER TABLE `__new_syncs` RENAME TO `syncs`;--> statement-breakpoint
CREATE TABLE `__new_tag_consolidations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_id` integer NOT NULL,
	`survivor_id` integer NOT NULL,
	`source_member_ids` text NOT NULL,
	`survivor_member_ids` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`idempotency_key` text NOT NULL UNIQUE,
	`vocabulary_fingerprint` text NOT NULL,
	`preview_fingerprint` text NOT NULL,
	`counts` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	CONSTRAINT `fk_tag_consolidations_source_id_canonical_tags_id_fk` FOREIGN KEY (`source_id`) REFERENCES `canonical_tags`(`id`),
	CONSTRAINT `fk_tag_consolidations_survivor_id_canonical_tags_id_fk` FOREIGN KEY (`survivor_id`) REFERENCES `canonical_tags`(`id`),
	CONSTRAINT "tag_consolidations_source_member_ids_json" CHECK("source_member_ids" IS NULL OR json_valid("source_member_ids")),
	CONSTRAINT "tag_consolidations_survivor_member_ids_json" CHECK("survivor_member_ids" IS NULL OR json_valid("survivor_member_ids")),
	CONSTRAINT "tag_consolidations_counts_json" CHECK("counts" IS NULL OR json_valid("counts"))
);
--> statement-breakpoint
INSERT INTO `__new_tag_consolidations`(`id`, `source_id`, `survivor_id`, `source_member_ids`, `survivor_member_ids`, `actor_type`, `actor_id`, `created_at`, `idempotency_key`, `vocabulary_fingerprint`, `preview_fingerprint`, `counts`, `request_fingerprint`) SELECT `id`, `source_id`, `survivor_id`, `source_member_ids`, `survivor_member_ids`, `actor_type`, `actor_id`, `created_at`, `idempotency_key`, `vocabulary_fingerprint`, `preview_fingerprint`, `counts`, `request_fingerprint` FROM `tag_consolidations`;--> statement-breakpoint
DROP TABLE `tag_consolidations`;--> statement-breakpoint
ALTER TABLE `__new_tag_consolidations` RENAME TO `tag_consolidations`;--> statement-breakpoint
CREATE TABLE `__new_taggings` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`tag_id` integer NOT NULL,
	`taggable_type` text NOT NULL,
	`taggable_id` integer NOT NULL,
	`main` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`author_type` text,
	`author_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_taggings_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `canonical_tags`(`id`),
	CONSTRAINT `taggings_tag_id_taggable_type_taggable_id_unique` UNIQUE(`tag_id`,`taggable_type`,`taggable_id`),
	CONSTRAINT "taggings_author_pair" CHECK(("author_type" IS NULL) = ("author_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_taggings`(`id`, `tag_id`, `taggable_type`, `taggable_id`, `main`, `source`, `author_type`, `author_id`, `created_at`, `updated_at`) SELECT `id`, `tag_id`, `taggable_type`, `taggable_id`, `main`, `source`, `author_type`, `author_id`, `created_at`, `updated_at` FROM `taggings`;--> statement-breakpoint
DROP TABLE `taggings`;--> statement-breakpoint
ALTER TABLE `__new_taggings` RENAME TO `taggings`;--> statement-breakpoint
CREATE TABLE `__new_task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`actor_type` text,
	`actor_id` integer,
	`kind` text NOT NULL,
	`changes` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT "task_events_changes_json" CHECK("changes" IS NULL OR json_valid("changes")),
	CONSTRAINT "task_events_actor_pair" CHECK(("actor_type" IS NULL) = ("actor_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_task_events`(`id`, `task_id`, `actor_type`, `actor_id`, `kind`, `changes`, `created_at`) SELECT `id`, `task_id`, `actor_type`, `actor_id`, `kind`, `changes`, `created_at` FROM `task_events`;--> statement-breakpoint
DROP TABLE `task_events`;--> statement-breakpoint
ALTER TABLE `__new_task_events` RENAME TO `task_events`;--> statement-breakpoint
CREATE TABLE `__new_task_pairs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer,
	`source_locator` text,
	`other_id` integer NOT NULL,
	`score` integer NOT NULL,
	`band` text NOT NULL,
	`levels` text NOT NULL,
	`reasons` text NOT NULL,
	`decision` text NOT NULL,
	`decided_by_type` text,
	`decided_by_id` integer,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_task_pairs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_task_pairs_other_id_tasks_id_fk` FOREIGN KEY (`other_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `task_pairs_task_id_other_id_unique` UNIQUE(`task_id`,`other_id`),
	CONSTRAINT "task_pairs_levels_json" CHECK("levels" IS NULL OR json_valid("levels")),
	CONSTRAINT "task_pairs_reasons_json" CHECK("reasons" IS NULL OR json_valid("reasons")),
	CONSTRAINT "task_pairs_decided_by_pair" CHECK(("decided_by_type" IS NULL) = ("decided_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_task_pairs`(`id`, `task_id`, `source_locator`, `other_id`, `score`, `band`, `levels`, `reasons`, `decision`, `decided_by_type`, `decided_by_id`, `decided_at`, `created_at`, `updated_at`) SELECT `id`, `task_id`, `source_locator`, `other_id`, `score`, `band`, `levels`, `reasons`, `decision`, `decided_by_type`, `decided_by_id`, `decided_at`, `created_at`, `updated_at` FROM `task_pairs`;--> statement-breakpoint
DROP TABLE `task_pairs`;--> statement-breakpoint
ALTER TABLE `__new_task_pairs` RENAME TO `task_pairs`;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer,
	`parent_id` integer,
	`due_at` integer,
	`started_at` integer,
	`closed_at` integer,
	`closed_by_type` text,
	`closed_by_id` integer,
	`close_reason` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`source` text NOT NULL,
	`package_id` text UNIQUE,
	`source_locator` text,
	`source_kind` text,
	`source_group` text,
	`resolution` text,
	`verdict` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`next_check_at` integer,
	`title_folded` text,
	`close_reason_folded` text,
	`category` text,
	`claimed_by` text,
	`claimed_until` integer,
	`close_certainty` real,
	`close_suggested_as` text,
	`close_suggested_by_type` text,
	`close_suggested_by_id` integer,
	`close_suggested_certainty` real,
	`close_suggested_reason` text,
	`close_suggested_at` integer,
	`priority_score` real,
	`agent` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`provider` text,
	`external_id` text,
	`source_url` text,
	CONSTRAINT `fk_tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `tasks_project_id_number_unique` UNIQUE(`project_id`,`number`),
	CONSTRAINT "tasks_metadata_json" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "tasks_closed_by_pair" CHECK(("closed_by_type" IS NULL) = ("closed_by_id" IS NULL)),
	CONSTRAINT "tasks_close_suggested_by_pair" CHECK(("close_suggested_by_type" IS NULL) = ("close_suggested_by_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(`id`, `project_id`, `number`, `key`, `title`, `description`, `type`, `status`, `priority`, `parent_id`, `due_at`, `started_at`, `closed_at`, `closed_by_type`, `closed_by_id`, `close_reason`, `author_type`, `author_id`, `source`, `package_id`, `source_locator`, `source_kind`, `source_group`, `resolution`, `verdict`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `next_check_at`, `title_folded`, `close_reason_folded`, `category`, `claimed_by`, `claimed_until`, `close_certainty`, `close_suggested_as`, `close_suggested_by_type`, `close_suggested_by_id`, `close_suggested_certainty`, `close_suggested_reason`, `close_suggested_at`, `priority_score`, `agent`, `revision`, `provider`, `external_id`, `source_url`) SELECT `id`, `project_id`, `number`, `key`, `title`, `description`, `type`, `status`, `priority`, `parent_id`, `due_at`, `started_at`, `closed_at`, `closed_by_type`, `closed_by_id`, `close_reason`, `author_type`, `author_id`, `source`, `package_id`, `source_locator`, `source_kind`, `source_group`, `resolution`, `verdict`, `metadata`, `created_at`, `updated_at`, `deleted_at`, `next_check_at`, `title_folded`, `close_reason_folded`, `category`, `claimed_by`, `claimed_until`, `close_certainty`, `close_suggested_as`, `close_suggested_by_type`, `close_suggested_by_id`, `close_suggested_certainty`, `close_suggested_reason`, `close_suggested_at`, `priority_score`, `agent`, `revision`, `provider`, `external_id`, `source_url` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE TABLE `__new_tracker_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
	CONSTRAINT `tracker_items_account_id_kind_external_id_unique` UNIQUE(`account_id`,`kind`,`external_id`),
	CONSTRAINT "tracker_items_data_json" CHECK("data" IS NULL OR json_valid("data"))
);
--> statement-breakpoint
INSERT INTO `__new_tracker_items`(`id`, `account_id`, `kind`, `external_id`, `parent_id`, `title`, `title_folded`, `body`, `normalized_text`, `data`, `source_created_at`, `source_updated_at`, `archived_at`, `deleted_at`, `synced_at`) SELECT `id`, `account_id`, `kind`, `external_id`, `parent_id`, `title`, `title_folded`, `body`, `normalized_text`, `data`, `source_created_at`, `source_updated_at`, `archived_at`, `deleted_at`, `synced_at` FROM `tracker_items`;--> statement-breakpoint
DROP TABLE `tracker_items`;--> statement-breakpoint
ALTER TABLE `__new_tracker_items` RENAME TO `tracker_items`;--> statement-breakpoint
CREATE TABLE `__new_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`aliasable_type` text NOT NULL,
	`aliasable_id` integer NOT NULL,
	`account_id` integer,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`display` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_aliases_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_aliases`(`id`, `aliasable_type`, `aliasable_id`, `account_id`, `name`, `name_folded`, `display`, `source`, `created_at`, `updated_at`) SELECT `id`, `aliasable_type`, `aliasable_id`, `account_id`, `name`, `name_folded`, `display`, `source`, `created_at`, `updated_at` FROM `aliases`;--> statement-breakpoint
DROP TABLE `aliases`;--> statement-breakpoint
ALTER TABLE `__new_aliases` RENAME TO `aliases`;--> statement-breakpoint
CREATE TABLE `__new_calendar_entry_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO `__new_calendar_entry_participants`(`id`, `entry_id`, `identity_id`, `email`, `name`, `response`, `optional`, `organizer`, `self`, `resource`, `created_at`, `updated_at`) SELECT `id`, `entry_id`, `identity_id`, `email`, `name`, `response`, `optional`, `organizer`, `self`, `resource`, `created_at`, `updated_at` FROM `calendar_entry_participants`;--> statement-breakpoint
DROP TABLE `calendar_entry_participants`;--> statement-breakpoint
ALTER TABLE `__new_calendar_entry_participants` RENAME TO `calendar_entry_participants`;--> statement-breakpoint
CREATE TABLE `__new_calendar_entry_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO `__new_calendar_entry_revisions`(`id`, `entry_id`, `title`, `starts_at`, `ends_at`, `location`, `status`, `recurrence`, `recurrence_ends_at`, `external_updated_at`, `created_at`) SELECT `id`, `entry_id`, `title`, `starts_at`, `ends_at`, `location`, `status`, `recurrence`, `recurrence_ends_at`, `external_updated_at`, `created_at` FROM `calendar_entry_revisions`;--> statement-breakpoint
DROP TABLE `calendar_entry_revisions`;--> statement-breakpoint
ALTER TABLE `__new_calendar_entry_revisions` RENAME TO `calendar_entry_revisions`;--> statement-breakpoint
CREATE TABLE `__new_calendars` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO `__new_calendars`(`id`, `account_id`, `external_id`, `title`, `timezone`, `access_role`, `primary_calendar`, `synced`, `seen_at`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `account_id`, `external_id`, `title`, `timezone`, `access_role`, `primary_calendar`, `synced`, `seen_at`, `created_at`, `updated_at`, `deleted_at` FROM `calendars`;--> statement-breakpoint
DROP TABLE `calendars`;--> statement-breakpoint
ALTER TABLE `__new_calendars` RENAME TO `calendars`;--> statement-breakpoint
CREATE TABLE `__new_canonical_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL UNIQUE,
	`kind` text DEFAULT 'tag' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_canonical_tags`(`id`, `name`, `kind`, `created_at`, `updated_at`) SELECT `id`, `name`, `kind`, `created_at`, `updated_at` FROM `canonical_tags`;--> statement-breakpoint
DROP TABLE `canonical_tags`;--> statement-breakpoint
ALTER TABLE `__new_canonical_tags` RENAME TO `canonical_tags`;--> statement-breakpoint
CREATE TABLE `__new_chat_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO `__new_chat_events`(`id`, `chat_id`, `source_id`, `action`, `actor_identity_id`, `title`, `happened_at`, `created_at`, `updated_at`) SELECT `id`, `chat_id`, `source_id`, `action`, `actor_identity_id`, `title`, `happened_at`, `created_at`, `updated_at` FROM `chat_events`;--> statement-breakpoint
DROP TABLE `chat_events`;--> statement-breakpoint
ALTER TABLE `__new_chat_events` RENAME TO `chat_events`;--> statement-breakpoint
CREATE TABLE `__new_chat_revision_source` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_chat_revision_source`(`id`, `source`, `at`) SELECT `id`, `source`, `at` FROM `chat_revision_source`;--> statement-breakpoint
DROP TABLE `chat_revision_source`;--> statement-breakpoint
ALTER TABLE `__new_chat_revision_source` RENAME TO `chat_revision_source`;--> statement-breakpoint
CREATE TABLE `__new_chat_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_chat_revisions`(`id`, `chat_id`, `account_id`, `field`, `old_value`, `new_value`, `source`, `created_at`) SELECT `id`, `chat_id`, `account_id`, `field`, `old_value`, `new_value`, `source`, `created_at` FROM `chat_revisions`;--> statement-breakpoint
DROP TABLE `chat_revisions`;--> statement-breakpoint
ALTER TABLE `__new_chat_revisions` RENAME TO `chat_revisions`;--> statement-breakpoint
CREATE TABLE `__new_content_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`network` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`handle` text,
	`deleted_at` integer,
	`synced_at` integer NOT NULL,
	CONSTRAINT `fk_content_channels_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `content_channels_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
INSERT INTO `__new_content_channels`(`id`, `account_id`, `external_id`, `kind`, `network`, `name`, `url`, `handle`, `deleted_at`, `synced_at`) SELECT `id`, `account_id`, `external_id`, `kind`, `network`, `name`, `url`, `handle`, `deleted_at`, `synced_at` FROM `content_channels`;--> statement-breakpoint
DROP TABLE `content_channels`;--> statement-breakpoint
ALTER TABLE `__new_content_channels` RENAME TO `content_channels`;--> statement-breakpoint
CREATE TABLE `__new_content_post_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`post_id` integer NOT NULL,
	`title` text,
	`body` text,
	`status` text NOT NULL,
	`content_hash` text NOT NULL,
	`version` text,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_content_post_revisions_post_id_content_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `content_posts`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_content_post_revisions`(`id`, `post_id`, `title`, `body`, `status`, `content_hash`, `version`, `reason`, `created_at`) SELECT `id`, `post_id`, `title`, `body`, `status`, `content_hash`, `version`, `reason`, `created_at` FROM `content_post_revisions`;--> statement-breakpoint
DROP TABLE `content_post_revisions`;--> statement-breakpoint
ALTER TABLE `__new_content_post_revisions` RENAME TO `content_post_revisions`;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`first_message_id` integer NOT NULL,
	`build` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`message_count` integer NOT NULL,
	`built_at` integer NOT NULL,
	`algorithm_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_conversations`(`id`, `chat_id`, `first_message_id`, `build`, `first_at`, `last_at`, `message_count`, `built_at`, `algorithm_version`, `created_at`, `updated_at`) SELECT `id`, `chat_id`, `first_message_id`, `build`, `first_at`, `last_at`, `message_count`, `built_at`, `algorithm_version`, `created_at`, `updated_at` FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
CREATE TABLE `__new_crm_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO `__new_crm_files`(`id`, `account_id`, `external_id`, `owner_kind`, `owner_id`, `owner_assignee`, `source`, `name`, `name_folded`, `mime`, `size`, `external_created_at`, `local_path`, `content_sha256`, `text`, `normalized_text`, `extraction`, `extraction_error`, `downloaded_by`, `downloaded_at`) SELECT `id`, `account_id`, `external_id`, `owner_kind`, `owner_id`, `owner_assignee`, `source`, `name`, `name_folded`, `mime`, `size`, `external_created_at`, `local_path`, `content_sha256`, `text`, `normalized_text`, `extraction`, `extraction_error`, `downloaded_by`, `downloaded_at` FROM `crm_files`;--> statement-breakpoint
DROP TABLE `crm_files`;--> statement-breakpoint
ALTER TABLE `__new_crm_files` RENAME TO `crm_files`;--> statement-breakpoint
CREATE TABLE `__new_decision_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`token_digest` text NOT NULL UNIQUE,
	`proposal_id` text NOT NULL,
	`action` text NOT NULL,
	`batch_digest` text NOT NULL,
	`channel` text NOT NULL,
	`bot_profile` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`cancelled_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_decision_requests`(`id`, `token_digest`, `proposal_id`, `action`, `batch_digest`, `channel`, `bot_profile`, `chat_id`, `message_id`, `owner_user_id`, `created_at`, `expires_at`, `used_at`, `cancelled_at`) SELECT `id`, `token_digest`, `proposal_id`, `action`, `batch_digest`, `channel`, `bot_profile`, `chat_id`, `message_id`, `owner_user_id`, `created_at`, `expires_at`, `used_at`, `cancelled_at` FROM `decision_requests`;--> statement-breakpoint
DROP TABLE `decision_requests`;--> statement-breakpoint
ALTER TABLE `__new_decision_requests` RENAME TO `decision_requests`;--> statement-breakpoint
CREATE TABLE `__new_document_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`document_id` integer NOT NULL,
	`path` text NOT NULL,
	`title` text,
	`event` text NOT NULL,
	`revision` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_document_changes`(`id`, `account_id`, `document_id`, `path`, `title`, `event`, `revision`, `at`) SELECT `id`, `account_id`, `document_id`, `path`, `title`, `event`, `revision`, `at` FROM `document_changes`;--> statement-breakpoint
DROP TABLE `document_changes`;--> statement-breakpoint
ALTER TABLE `__new_document_changes` RENAME TO `document_changes`;--> statement-breakpoint
CREATE TABLE `__new_email_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`email_id` integer NOT NULL,
	`identity_id` integer,
	`address` text NOT NULL,
	`name` text,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_email_recipients_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),
	CONSTRAINT `fk_email_recipients_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_email_recipients`(`id`, `email_id`, `identity_id`, `address`, `name`, `role`, `position`, `created_at`, `updated_at`) SELECT `id`, `email_id`, `identity_id`, `address`, `name`, `role`, `position`, `created_at`, `updated_at` FROM `email_recipients`;--> statement-breakpoint
DROP TABLE `email_recipients`;--> statement-breakpoint
ALTER TABLE `__new_email_recipients` RENAME TO `email_recipients`;--> statement-breakpoint
CREATE TABLE `__new_entity_link_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO `__new_entity_link_events`(`id`, `linkable_type`, `linkable_id`, `entity_type`, `from_entity_id`, `to_entity_id`, `method`, `confidence`, `author`, `created_at`) SELECT `id`, `linkable_type`, `linkable_id`, `entity_type`, `from_entity_id`, `to_entity_id`, `method`, `confidence`, `author`, `created_at` FROM `entity_link_events`;--> statement-breakpoint
DROP TABLE `entity_link_events`;--> statement-breakpoint
ALTER TABLE `__new_entity_link_events` RENAME TO `entity_link_events`;--> statement-breakpoint
CREATE TABLE `__new_event_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text,
	`recurrence` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_event_series`(`id`, `title`, `recurrence`, `origin`, `created_at`, `updated_at`) SELECT `id`, `title`, `recurrence`, `origin`, `created_at`, `updated_at` FROM `event_series`;--> statement-breakpoint
DROP TABLE `event_series`;--> statement-breakpoint
ALTER TABLE `__new_event_series` RENAME TO `event_series`;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`event_series_id` integer,
	`title` text,
	`description` text,
	`location` text,
	`starts_at` integer,
	`ends_at` integer,
	`timezone` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`status` text,
	`all_day` integer,
	`source_deleted_at` integer,
	CONSTRAINT `fk_events_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_events`(`id`, `event_series_id`, `title`, `description`, `location`, `starts_at`, `ends_at`, `timezone`, `origin`, `created_at`, `updated_at`, `deleted_at`, `status`, `all_day`, `source_deleted_at`) SELECT `id`, `event_series_id`, `title`, `description`, `location`, `starts_at`, `ends_at`, `timezone`, `origin`, `created_at`, `updated_at`, `deleted_at`, `status`, `all_day`, `source_deleted_at` FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
CREATE TABLE `__new_fact_removals` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`fact_id` integer NOT NULL,
	`subject` text,
	`removed_by` text NOT NULL,
	`bot` text,
	`reason` text,
	`removed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_fact_removals`(`id`, `fact_id`, `subject`, `removed_by`, `bot`, `reason`, `removed_at`) SELECT `id`, `fact_id`, `subject`, `removed_by`, `bot`, `reason`, `removed_at` FROM `fact_removals`;--> statement-breakpoint
DROP TABLE `fact_removals`;--> statement-breakpoint
ALTER TABLE `__new_fact_removals` RENAME TO `fact_removals`;--> statement-breakpoint
CREATE TABLE `__new_identity_link_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`identity_id` integer NOT NULL,
	`from_person_id` integer,
	`to_person_id` integer NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	CONSTRAINT `fk_identity_link_events_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_link_events_from_person_id_persons_id_fk` FOREIGN KEY (`from_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_identity_link_events_to_person_id_persons_id_fk` FOREIGN KEY (`to_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_identity_link_events`(`id`, `identity_id`, `from_person_id`, `to_person_id`, `method`, `created_at`, `author`) SELECT `id`, `identity_id`, `from_person_id`, `to_person_id`, `method`, `created_at`, `author` FROM `identity_link_events`;--> statement-breakpoint
DROP TABLE `identity_link_events`;--> statement-breakpoint
ALTER TABLE `__new_identity_link_events` RENAME TO `identity_link_events`;--> statement-breakpoint
CREATE TABLE `__new_mailboxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name_folded` text,
	CONSTRAINT `fk_mailboxes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `mailboxes_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
INSERT INTO `__new_mailboxes`(`id`, `account_id`, `external_id`, `name`, `kind`, `created_at`, `updated_at`, `name_folded`) SELECT `id`, `account_id`, `external_id`, `name`, `kind`, `created_at`, `updated_at`, `name_folded` FROM `mailboxes`;--> statement-breakpoint
DROP TABLE `mailboxes`;--> statement-breakpoint
ALTER TABLE `__new_mailboxes` RENAME TO `mailboxes`;--> statement-breakpoint
CREATE TABLE `__new_member_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`started_at` integer,
	`complete` integer NOT NULL,
	`reported_count` integer,
	`listed_count` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_member_observations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_member_observations`(`id`, `chat_id`, `observed_at`, `started_at`, `complete`, `reported_count`, `listed_count`, `source`, `created_at`, `updated_at`) SELECT `id`, `chat_id`, `observed_at`, `started_at`, `complete`, `reported_count`, `listed_count`, `source`, `created_at`, `updated_at` FROM `member_observations`;--> statement-breakpoint
DROP TABLE `member_observations`;--> statement-breakpoint
ALTER TABLE `__new_member_observations` RENAME TO `member_observations`;--> statement-breakpoint
CREATE TABLE `__new_member_stays` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`joined_at` integer,
	`invited_by_identity_id` integer,
	`role` text,
	`left_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_member_stays_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_member_stays_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_member_stays_invited_by_identity_id_identities_id_fk` FOREIGN KEY (`invited_by_identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_member_stays`(`id`, `chat_id`, `identity_id`, `first_seen_at`, `last_seen_at`, `joined_at`, `invited_by_identity_id`, `role`, `left_at`, `created_at`, `updated_at`) SELECT `id`, `chat_id`, `identity_id`, `first_seen_at`, `last_seen_at`, `joined_at`, `invited_by_identity_id`, `role`, `left_at`, `created_at`, `updated_at` FROM `member_stays`;--> statement-breakpoint
DROP TABLE `member_stays`;--> statement-breakpoint
ALTER TABLE `__new_member_stays` RENAME TO `member_stays`;--> statement-breakpoint
CREATE TABLE `__new_message_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`parent_id` integer,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`version` text,
	`batch` text,
	`build` integer,
	`created_at` integer NOT NULL,
	`stale_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_links_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_parent_id_messages_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_message_links`(`id`, `chat_id`, `message_id`, `parent_id`, `source`, `kind`, `confidence`, `method`, `version`, `batch`, `build`, `created_at`, `stale_at`, `updated_at`) SELECT `id`, `chat_id`, `message_id`, `parent_id`, `source`, `kind`, `confidence`, `method`, `version`, `batch`, `build`, `created_at`, `stale_at`, `updated_at` FROM `message_links`;--> statement-breakpoint
DROP TABLE `message_links`;--> statement-breakpoint
ALTER TABLE `__new_message_links` RENAME TO `message_links`;--> statement-breakpoint
CREATE TABLE `__new_message_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`message_external_id` text NOT NULL,
	`identity_id` integer NOT NULL,
	`own` integer NOT NULL,
	`reaction` text,
	`reacted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_reactions_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_message_reactions_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `message_reactions_chat_id_message_external_id_identity_id_unique` UNIQUE(`chat_id`,`message_external_id`,`identity_id`)
);
--> statement-breakpoint
INSERT INTO `__new_message_reactions`(`id`, `chat_id`, `message_external_id`, `identity_id`, `own`, `reaction`, `reacted_at`, `created_at`, `updated_at`) SELECT `id`, `chat_id`, `message_external_id`, `identity_id`, `own`, `reaction`, `reacted_at`, `created_at`, `updated_at` FROM `message_reactions`;--> statement-breakpoint
DROP TABLE `message_reactions`;--> statement-breakpoint
ALTER TABLE `__new_message_reactions` RENAME TO `message_reactions`;--> statement-breakpoint
CREATE TABLE `__new_message_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`message_id` integer NOT NULL,
	`text` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_message_revisions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_message_revisions`(`id`, `message_id`, `text`, `edited_at`, `created_at`) SELECT `id`, `message_id`, `text`, `edited_at`, `created_at` FROM `message_revisions`;--> statement-breakpoint
DROP TABLE `message_revisions`;--> statement-breakpoint
ALTER TABLE `__new_message_revisions` RENAME TO `message_revisions`;--> statement-breakpoint
CREATE TABLE `__new_message_transcripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`message_id` integer,
	`chat_id` integer NOT NULL,
	`message_external_id` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`heard_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_transcripts_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`),
	CONSTRAINT `fk_message_transcripts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `message_transcripts_chat_id_message_external_id_unique` UNIQUE(`chat_id`,`message_external_id`)
);
--> statement-breakpoint
INSERT INTO `__new_message_transcripts`(`id`, `message_id`, `chat_id`, `message_external_id`, `text`, `source`, `heard_at`, `created_at`, `updated_at`) SELECT `id`, `message_id`, `chat_id`, `message_external_id`, `text`, `source`, `heard_at`, `created_at`, `updated_at` FROM `message_transcripts`;--> statement-breakpoint
DROP TABLE `message_transcripts`;--> statement-breakpoint
ALTER TABLE `__new_message_transcripts` RENAME TO `message_transcripts`;--> statement-breakpoint
CREATE TABLE `__new_note_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`note_id` integer NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_note_revisions_note_id_notes_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_note_revisions`(`id`, `note_id`, `body`, `revision`, `created_at`) SELECT `id`, `note_id`, `body`, `revision`, `created_at` FROM `note_revisions`;--> statement-breakpoint
DROP TABLE `note_revisions`;--> statement-breakpoint
ALTER TABLE `__new_note_revisions` RENAME TO `note_revisions`;--> statement-breakpoint
CREATE TABLE `__new_organization_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`identity_id` integer NOT NULL,
	`organization_id` integer NOT NULL,
	`method` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_organization_identities_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_organization_identities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `organization_identities_identity_id_organization_id_unique` UNIQUE(`identity_id`,`organization_id`)
);
--> statement-breakpoint
INSERT INTO `__new_organization_identities`(`id`, `identity_id`, `organization_id`, `method`, `author`, `created_at`, `updated_at`) SELECT `id`, `identity_id`, `organization_id`, `method`, `author`, `created_at`, `updated_at` FROM `organization_identities`;--> statement-breakpoint
DROP TABLE `organization_identities`;--> statement-breakpoint
ALTER TABLE `__new_organization_identities` RENAME TO `organization_identities`;--> statement-breakpoint
CREATE TABLE `__new_payment_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`payment_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_payment_allocations_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_payment_allocations_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`),
	CONSTRAINT `payment_allocations_payment_id_invoice_id_unique` UNIQUE(`payment_id`,`invoice_id`)
);
--> statement-breakpoint
INSERT INTO `__new_payment_allocations`(`id`, `payment_id`, `invoice_id`, `amount`, `author_type`, `author_id`, `created_at`, `updated_at`) SELECT `id`, `payment_id`, `invoice_id`, `amount`, `author_type`, `author_id`, `created_at`, `updated_at` FROM `payment_allocations`;--> statement-breakpoint
DROP TABLE `payment_allocations`;--> statement-breakpoint
ALTER TABLE `__new_payment_allocations` RENAME TO `payment_allocations`;--> statement-breakpoint
CREATE TABLE `__new_persons` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text,
	`owner` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`kind` text,
	`name_order` text,
	`messages_from` integer,
	`task_count` integer,
	`last_contact` integer
);
--> statement-breakpoint
INSERT INTO `__new_persons`(`id`, `name`, `owner`, `created_at`, `updated_at`, `kind`, `name_order`, `messages_from`, `task_count`, `last_contact`) SELECT `id`, `name`, `owner`, `created_at`, `updated_at`, `kind`, `name_order`, `messages_from`, `task_count`, `last_contact` FROM `persons`;--> statement-breakpoint
DROP TABLE `persons`;--> statement-breakpoint
ALTER TABLE `__new_persons` RENAME TO `persons`;--> statement-breakpoint
CREATE TABLE `__new_pipeline_stage_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`item_type` text NOT NULL,
	`item_id` integer NOT NULL,
	`pipeline_id` integer NOT NULL,
	`from_stage_id` integer,
	`to_stage_id` integer NOT NULL,
	`changed_at` integer NOT NULL,
	CONSTRAINT `fk_pipeline_stage_changes_pipeline_id_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`),
	CONSTRAINT `fk_pipeline_stage_changes_from_stage_id_pipeline_stages_id_fk` FOREIGN KEY (`from_stage_id`) REFERENCES `pipeline_stages`(`id`),
	CONSTRAINT `fk_pipeline_stage_changes_to_stage_id_pipeline_stages_id_fk` FOREIGN KEY (`to_stage_id`) REFERENCES `pipeline_stages`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_pipeline_stage_changes`(`id`, `item_type`, `item_id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `changed_at`) SELECT `id`, `item_type`, `item_id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `changed_at` FROM `pipeline_stage_changes`;--> statement-breakpoint
DROP TABLE `pipeline_stage_changes`;--> statement-breakpoint
ALTER TABLE `__new_pipeline_stage_changes` RENAME TO `pipeline_stage_changes`;--> statement-breakpoint
CREATE TABLE `__new_pipeline_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`pipeline_id` integer NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`position` integer NOT NULL,
	`outcome` text DEFAULT 'open' NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`base_stage_id` integer,
	`base_confirmed` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_pipeline_stages_pipeline_id_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`),
	CONSTRAINT `fk_pipeline_stages_base_stage_id_pipeline_stages_id_fk` FOREIGN KEY (`base_stage_id`) REFERENCES `pipeline_stages`(`id`),
	CONSTRAINT `pipeline_stages_pipeline_id_name_folded_unique` UNIQUE(`pipeline_id`,`name_folded`)
);
--> statement-breakpoint
INSERT INTO `__new_pipeline_stages`(`id`, `pipeline_id`, `name`, `name_folded`, `position`, `outcome`, `external_id`, `created_at`, `updated_at`, `deleted_at`, `base_stage_id`, `base_confirmed`) SELECT `id`, `pipeline_id`, `name`, `name_folded`, `position`, `outcome`, `external_id`, `created_at`, `updated_at`, `deleted_at`, `base_stage_id`, `base_confirmed` FROM `pipeline_stages`;--> statement-breakpoint
DROP TABLE `pipeline_stages`;--> statement-breakpoint
ALTER TABLE `__new_pipeline_stages` RENAME TO `pipeline_stages`;--> statement-breakpoint
CREATE TABLE `__new_pipelines` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer,
	`external_id` text,
	`kind` text DEFAULT 'deal' NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_pipelines_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_pipelines`(`id`, `account_id`, `external_id`, `kind`, `name`, `name_folded`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `account_id`, `external_id`, `kind`, `name`, `name_folded`, `created_at`, `updated_at`, `deleted_at` FROM `pipelines`;--> statement-breakpoint
DROP TABLE `pipelines`;--> statement-breakpoint
ALTER TABLE `__new_pipelines` RENAME TO `pipelines`;--> statement-breakpoint
CREATE TABLE `__new_places` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`address` text NOT NULL,
	`folded` text NOT NULL UNIQUE,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_places`(`id`, `address`, `folded`, `author`, `created_at`, `updated_at`) SELECT `id`, `address`, `folded`, `author`, `created_at`, `updated_at` FROM `places`;--> statement-breakpoint
DROP TABLE `places`;--> statement-breakpoint
ALTER TABLE `__new_places` RENAME TO `places`;--> statement-breakpoint
CREATE TABLE `__new_record_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`record_id` integer NOT NULL,
	`role` text NOT NULL,
	`target_type` text NOT NULL,
	`target_external_id` text NOT NULL,
	`target_id` integer,
	`created_at` integer NOT NULL,
	`amount` text,
	`as_role` text,
	CONSTRAINT `fk_record_relations_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`),
	CONSTRAINT `fk_record_relations_target_id_records_id_fk` FOREIGN KEY (`target_id`) REFERENCES `records`(`id`),
	CONSTRAINT `record_relations_record_id_role_target_type_target_external_id_unique` UNIQUE(`record_id`,`role`,`target_type`,`target_external_id`)
);
--> statement-breakpoint
INSERT INTO `__new_record_relations`(`id`, `record_id`, `role`, `target_type`, `target_external_id`, `target_id`, `created_at`, `amount`, `as_role`) SELECT `id`, `record_id`, `role`, `target_type`, `target_external_id`, `target_id`, `created_at`, `amount`, `as_role` FROM `record_relations`;--> statement-breakpoint
DROP TABLE `record_relations`;--> statement-breakpoint
ALTER TABLE `__new_record_relations` RENAME TO `record_relations`;--> statement-breakpoint
CREATE TABLE `__new_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`due_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_until` integer,
	`receipt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_reminders_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_reminders_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_reminders`(`id`, `task_id`, `account_id`, `due_at`, `timezone`, `state`, `revision`, `lease_until`, `receipt`, `created_at`, `updated_at`) SELECT `id`, `task_id`, `account_id`, `due_at`, `timezone`, `state`, `revision`, `lease_until`, `receipt`, `created_at`, `updated_at` FROM `reminders`;--> statement-breakpoint
DROP TABLE `reminders`;--> statement-breakpoint
ALTER TABLE `__new_reminders` RENAME TO `reminders`;--> statement-breakpoint
CREATE TABLE `__new_task_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`assignee_type` text NOT NULL,
	`assignee_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_task_assignments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `task_assignments_task_id_assignee_type_assignee_id_role_unique` UNIQUE(`task_id`,`assignee_type`,`assignee_id`,`role`)
);
--> statement-breakpoint
INSERT INTO `__new_task_assignments`(`id`, `task_id`, `assignee_type`, `assignee_id`, `role`, `created_at`, `updated_at`) SELECT `id`, `task_id`, `assignee_type`, `assignee_id`, `role`, `created_at`, `updated_at` FROM `task_assignments`;--> statement-breakpoint
DROP TABLE `task_assignments`;--> statement-breakpoint
ALTER TABLE `__new_task_assignments` RENAME TO `task_assignments`;--> statement-breakpoint
CREATE TABLE `__new_templates_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`key` text NOT NULL,
	`channel` text NOT NULL,
	`language` text NOT NULL,
	`body` text NOT NULL,
	`saved_at` integer NOT NULL,
	`saved_by` text NOT NULL,
	`replaced_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_templates_history`(`id`, `key`, `channel`, `language`, `body`, `saved_at`, `saved_by`, `replaced_at`) SELECT `id`, `key`, `channel`, `language`, `body`, `saved_at`, `saved_by`, `replaced_at` FROM `templates_history`;--> statement-breakpoint
DROP TABLE `templates_history`;--> statement-breakpoint
ALTER TABLE `__new_templates_history` RENAME TO `templates_history`;--> statement-breakpoint
CREATE TABLE `__new_transaction_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`transaction_id` integer NOT NULL,
	`position` integer NOT NULL,
	`category` text NOT NULL,
	`category_folded` text NOT NULL,
	`amount` integer NOT NULL,
	`project_id` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_transaction_splits_transaction_id_financial_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `financial_transactions`(`id`),
	CONSTRAINT `fk_transaction_splits_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `transaction_splits_transaction_id_position_unique` UNIQUE(`transaction_id`,`position`)
);
--> statement-breakpoint
INSERT INTO `__new_transaction_splits`(`id`, `transaction_id`, `position`, `category`, `category_folded`, `amount`, `project_id`, `note`, `created_at`, `updated_at`) SELECT `id`, `transaction_id`, `position`, `category`, `category_folded`, `amount`, `project_id`, `note`, `created_at`, `updated_at` FROM `transaction_splits`;--> statement-breakpoint
DROP TABLE `transaction_splits`;--> statement-breakpoint
ALTER TABLE `__new_transaction_splits` RENAME TO `transaction_splits`;--> statement-breakpoint
CREATE INDEX `accounts_by_organization_id` ON `accounts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `agent_actions_by_started_at_desc` ON `agent_actions` ("started_at" desc);--> statement-breakpoint
CREATE INDEX `agent_actions_by_actor_type_actor_id` ON `agent_actions` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `agent_actions_by_target_type_target_id` ON `agent_actions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `attachments_by_name_folded` ON `attachments` (`name_folded`);--> statement-breakpoint
CREATE INDEX `attachments_local_path_to_fold` ON `attachments` (`id`) WHERE local_path IS NOT NULL AND local_path_folded IS NULL;--> statement-breakpoint
CREATE INDEX `bot_updates_by_account_id_received_at_desc` ON `bot_updates` (`account_id`,"received_at" desc);--> statement-breakpoint
CREATE INDEX `bots_by_owner_person_id` ON `bots` (`owner_person_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_calendar_id_starts_at` ON `calendar_entries` (`calendar_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_ical_uid` ON `calendar_entries` (`ical_uid`) WHERE ical_uid IS NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_entries_by_join_key` ON `calendar_entries` (`join_key`) WHERE join_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_entries_by_calendar_id_series_external_id` ON `calendar_entries` (`calendar_id`,`series_external_id`) WHERE series_external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_entries_by_event_id` ON `calendar_entries` (`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_event_series_id` ON `calendar_entries` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_event_type_event_id` ON `calendar_entries` (`event_type`,`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_entries_by_organizer_identity_id` ON `calendar_entries` (`organizer_identity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_by_supplier_type_supplier_id_sku` ON `catalog_items` (`supplier_type`,`supplier_id`,`sku`) WHERE supplier_id IS NOT NULL AND sku IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_by_sku` ON `catalog_items` (`sku`) WHERE supplier_id IS NULL AND sku IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `catalog_items_by_name_folded` ON `catalog_items` (`name_folded`);--> statement-breakpoint
CREATE INDEX `catalog_items_by_author_type_author_id` ON `catalog_items` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `chats_by_recency` ON `chats` (`account_id`,"last_message_at" desc);--> statement-breakpoint
CREATE INDEX `chats_title_to_fold` ON `chats` (`id`) WHERE title IS NOT NULL AND title_folded IS NULL;--> statement-breakpoint
CREATE INDEX `chats_by_parent_chat_id` ON `chats` (`parent_chat_id`);--> statement-breakpoint
CREATE INDEX `content_metrics_by_post_id_at` ON `content_metrics` (`post_id`,`at`);--> statement-breakpoint
CREATE INDEX `content_posts_by_account_id_status` ON `content_posts` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `content_posts_by_account_id_published_at` ON `content_posts` (`account_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `content_terms_by_tag_id` ON `content_terms` (`tag_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_project_id` ON `contracts` (`project_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_deal_id` ON `contracts` (`deal_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_author_type_author_id` ON `contracts` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_confirmed_by_type_confirmed_by_id` ON `contracts` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deals_by_account_id_external_id` ON `deals` (`account_id`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `deals_by_organization_id` ON `deals` (`organization_id`);--> statement-breakpoint
CREATE INDEX `deals_by_project_id` ON `deals` (`project_id`);--> statement-breakpoint
CREATE INDEX `deals_by_stage_id` ON `deals` (`stage_id`);--> statement-breakpoint
CREATE INDEX `deals_by_author_type_author_id` ON `deals` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `decisions_by_project_id` ON `decisions` (`project_id`);--> statement-breakpoint
CREATE INDEX `decisions_by_supersedes_id` ON `decisions` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `decisions_by_confirmed_by_type_confirmed_by_id` ON `decisions` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `document_revisions_by_document_id` ON `document_revisions` (`document_id`);--> statement-breakpoint
CREATE INDEX `email_threads_subject_to_fold` ON `email_threads` (`id`) WHERE subject IS NOT NULL AND subject_folded IS NULL;--> statement-breakpoint
CREATE INDEX `emails_by_time` ON `emails` (`account_id`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `emails_by_mail_rule_id` ON `emails` (`mail_rule_id`) WHERE mail_rule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `emails_by_email_thread_id` ON `emails` (`email_thread_id`);--> statement-breakpoint
CREATE INDEX `emails_by_from_identity_id` ON `emails` (`from_identity_id`);--> statement-breakpoint
CREATE INDEX `facts_by_project_id` ON `facts` (`project_id`);--> statement-breakpoint
CREATE INDEX `facts_by_subject_type_subject_id` ON `facts` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `facts_by_supersedes_id` ON `facts` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `facts_by_author_type_author_id` ON `facts` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `facts_by_confirmed_by_type_confirmed_by_id` ON `facts` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `files_by_account_id_path_folded` ON `files` (`account_id`,`path_folded`);--> statement-breakpoint
CREATE INDEX `files_path_to_fold` ON `files` (`id`) WHERE path_folded IS NULL;--> statement-breakpoint
CREATE INDEX `files_by_parent_id` ON `files` (`parent_id`);--> statement-breakpoint
CREATE INDEX `files_by_document_id` ON `files` (`document_id`);--> statement-breakpoint
CREATE INDEX `financial_accounts_by_name_folded` ON `financial_accounts` (`name_folded`);--> statement-breakpoint
CREATE INDEX `financial_accounts_by_holder_type_holder_id` ON `financial_accounts` (`holder_type`,`holder_id`);--> statement-breakpoint
CREATE INDEX `financial_accounts_by_author_type_author_id` ON `financial_accounts` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_financial_account_id_booked_date` ON `financial_transactions` (`financial_account_id`,`booked_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `financial_transactions_by_payment_id` ON `financial_transactions` (`payment_id`) WHERE payment_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `financial_transactions_by_counterparty_type_counterparty_id` ON `financial_transactions` (`counterparty_type`,`counterparty_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_project_id` ON `financial_transactions` (`project_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_author_type_author_id` ON `financial_transactions` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_confirmed_by_type_confirmed_by_id` ON `financial_transactions` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `identities_by_email` ON `identities` (`email`) WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX `identities_name_to_fold` ON `identities` (`id`) WHERE name IS NOT NULL AND name_folded IS NULL;--> statement-breakpoint
CREATE INDEX `identity_revisions_by_identity` ON `identity_revisions` (`identity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `invoice_lines_by_catalog_item_id` ON `invoice_lines` (`catalog_item_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_issuer_type_issuer_id` ON `invoices` (`issuer_type`,`issuer_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_counterparty_type_counterparty_id` ON `invoices` (`counterparty_type`,`counterparty_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_project_id` ON `invoices` (`project_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_author_type_author_id` ON `invoices` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_confirmed_by_type_confirmed_by_id` ON `invoices` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_contract_id` ON `invoices` (`contract_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_subscription_id` ON `invoices` (`subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `leads_by_account_id_external_id` ON `leads` (`account_id`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `leads_by_organization_id` ON `leads` (`organization_id`);--> statement-breakpoint
CREATE INDEX `leads_by_project_id` ON `leads` (`project_id`);--> statement-breakpoint
CREATE INDEX `leads_by_stage_id` ON `leads` (`stage_id`);--> statement-breakpoint
CREATE INDEX `leads_by_deal_id` ON `leads` (`deal_id`);--> statement-breakpoint
CREATE INDEX `leads_by_author_type_author_id` ON `leads` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `link_reviews_by_status_created_at` ON `link_reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `link_revisions_by_link_id_created_at` ON `link_revisions` (`link_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `links_unresolved` ON `links` (`target_folded`) WHERE to_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `links_relationship_key` ON `links` (`kind`,`from_type`,`from_id`,`to_type`,`to_id`,ifnull("anchor", ''),ifnull("role", ''),ifnull("account_id", 0)) WHERE kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND to_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `links_by_from_type_from_id` ON `links` (`from_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `links_by_to_type_to_id` ON `links` (`to_type`,`to_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_chat_messages_by_meeting_id_external_id` ON `meeting_chat_messages` (`meeting_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `meeting_chat_messages_by_meeting_id` ON `meeting_chat_messages` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_chat_messages_by_sender_participant_id` ON `meeting_chat_messages` (`sender_participant_id`);--> statement-breakpoint
CREATE INDEX `meeting_participants_by_identity_id` ON `meeting_participants` (`identity_id`);--> statement-breakpoint
CREATE INDEX `meeting_series_by_event_series_id` ON `meeting_series` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `meeting_series_by_host_identity_id` ON `meeting_series` (`host_identity_id`);--> statement-breakpoint
CREATE INDEX `meeting_transcript_rows_by_speaker_participant_id` ON `meeting_transcript_rows` (`speaker_participant_id`);--> statement-breakpoint
CREATE INDEX `meeting_transcripts_by_meeting_id` ON `meeting_transcripts` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_join_key` ON `meetings` (`join_key`) WHERE join_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `meetings_join_key_to_fill` ON `meetings` (`id`) WHERE join_url IS NOT NULL AND join_key IS NULL;--> statement-breakpoint
CREATE INDEX `meetings_by_time` ON `meetings` (`account_id`,"started_at" desc);--> statement-breakpoint
CREATE INDEX `meetings_by_account_id_title_folded` ON `meetings` (`account_id`,`title_folded`);--> statement-breakpoint
CREATE INDEX `meetings_title_to_fold` ON `meetings` (`id`) WHERE title IS NOT NULL AND title_folded IS NULL;--> statement-breakpoint
CREATE INDEX `meetings_by_meeting_series_id` ON `meetings` (`meeting_series_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_event_id` ON `meetings` (`event_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_host_identity_id` ON `meetings` (`host_identity_id`);--> statement-breakpoint
CREATE INDEX `memories_by_subject_type_subject_id` ON `memories` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `memories_by_author_type_author_id` ON `memories` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `memories_by_supersedes_id` ON `memories` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `memories_by_project_id` ON `memories` (`project_id`);--> statement-breakpoint
CREATE INDEX `messages_by_time` ON `messages` (`chat_id`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `messages_starred_by_time` ON `messages` (`chat_id`,"sent_at" desc) WHERE starred = 1;--> statement-breakpoint
CREATE INDEX `messages_by_reply` ON `messages` (`chat_id`,`reply_to_external_id`) WHERE reply_to_external_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `messages_by_account` ON `messages` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `messages_to_normalize` ON `messages` (`id`) WHERE normalized_text IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `messages_by_sender_identity_id` ON `messages` (`sender_identity_id`);--> statement-breakpoint
CREATE INDEX `messages_by_thread_root_id` ON `messages` (`thread_root_id`);--> statement-breakpoint
CREATE INDEX `messages_by_thread_external_id` ON `messages` (`chat_id`,`thread_external_id`) WHERE thread_root_id IS NULL AND thread_external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notes_by_notable_type_notable_id` ON `notes` (`notable_type`,`notable_id`);--> statement-breakpoint
CREATE INDEX `notes_by_author_type_author_id` ON `notes` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `order_lines_by_catalog_item_id` ON `order_lines` (`catalog_item_id`);--> statement-breakpoint
CREATE INDEX `orders_by_customer_type_customer_id` ON `orders` (`customer_type`,`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_by_supplier_type_supplier_id` ON `orders` (`supplier_type`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `orders_by_invoice_id` ON `orders` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `orders_by_payment_id` ON `orders` (`payment_id`);--> statement-breakpoint
CREATE INDEX `orders_by_project_id` ON `orders` (`project_id`);--> statement-breakpoint
CREATE INDEX `orders_by_author_type_author_id` ON `orders` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `orders_by_confirmed_by_type_confirmed_by_id` ON `orders` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `orders_by_contract_id` ON `orders` (`contract_id`);--> statement-breakpoint
CREATE INDEX `orders_by_deal_id` ON `orders` (`deal_id`);--> statement-breakpoint
CREATE INDEX `payments_by_payer_type_payer_id` ON `payments` (`payer_type`,`payer_id`);--> statement-breakpoint
CREATE INDEX `payments_by_payee_type_payee_id` ON `payments` (`payee_type`,`payee_id`);--> statement-breakpoint
CREATE INDEX `payments_by_project_id` ON `payments` (`project_id`);--> statement-breakpoint
CREATE INDEX `payments_by_author_type_author_id` ON `payments` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `payments_by_confirmed_by_type_confirmed_by_id` ON `payments` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `payments_by_refund_of` ON `payments` (`refund_of`);--> statement-breakpoint
CREATE INDEX `payments_by_subscription_id` ON `payments` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `poll_votes_by_identity_id` ON `poll_votes` (`identity_id`);--> statement-breakpoint
CREATE INDEX `projects_by_name_folded` ON `projects` (`name_folded`);--> statement-breakpoint
CREATE INDEX `projects_name_to_fold` ON `projects` (`id`) WHERE name_folded IS NULL;--> statement-breakpoint
CREATE INDEX `projects_by_organization_id` ON `projects` (`organization_id`);--> statement-breakpoint
CREATE INDEX `projects_by_account_id` ON `projects` (`account_id`);--> statement-breakpoint
CREATE INDEX `projects_by_owner_type_owner_id` ON `projects` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_status_created_at` ON `proposed_actions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_account_id` ON `proposed_actions` (`account_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_target_type_target_id` ON `proposed_actions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_proposed_by_type_proposed_by_id` ON `proposed_actions` (`proposed_by_type`,`proposed_by_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_decided_by_type_decided_by_id` ON `proposed_actions` (`decided_by_type`,`decided_by_id`);--> statement-breakpoint
CREATE INDEX `records_by_account_id_batch_id` ON `records` (`account_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `records_by_entity_type_entity_id` ON `records` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `searches_history` ON `searches` (`command`,`params`) WHERE name IS NULL;--> statement-breakpoint
CREATE INDEX `searches_by_last_run` ON `searches` ("last_run_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_prices_by_subscription_id_effective_from` ON `subscription_prices` (`subscription_id`,`effective_from`) WHERE review <> 'rejected';--> statement-breakpoint
CREATE INDEX `subscription_prices_by_author_type_author_id` ON `subscription_prices` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `subscription_prices_by_confirmed_by_type_confirmed_by_id` ON `subscription_prices` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_supplier_type_supplier_id` ON `subscriptions` (`supplier_type`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_customer_type_customer_id` ON `subscriptions` (`customer_type`,`customer_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_catalog_item_id` ON `subscriptions` (`catalog_item_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_contract_id` ON `subscriptions` (`contract_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_project_id` ON `subscriptions` (`project_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_author_type_author_id` ON `subscriptions` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_confirmed_by_type_confirmed_by_id` ON `subscriptions` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `syncs_by_account_id` ON `syncs` (`account_id`);--> statement-breakpoint
CREATE INDEX `tag_consolidations_by_source_id` ON `tag_consolidations` (`source_id`);--> statement-breakpoint
CREATE INDEX `tag_consolidations_by_survivor_id` ON `tag_consolidations` (`survivor_id`);--> statement-breakpoint
CREATE INDEX `tag_consolidations_by_actor_type_actor_id` ON `tag_consolidations` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `taggings_main_topic` ON `taggings` (`taggable_type`,`taggable_id`) WHERE main = 1;--> statement-breakpoint
CREATE INDEX `taggings_by_taggable_type_taggable_id` ON `taggings` (`taggable_type`,`taggable_id`);--> statement-breakpoint
CREATE INDEX `taggings_by_author_type_author_id` ON `taggings` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `task_events_by_task_id` ON `task_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_events_by_actor_type_actor_id` ON `task_events` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `task_pairs_by_decision_created_at` ON `task_pairs` (`decision`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_pairs_by_other_id` ON `task_pairs` (`other_id`);--> statement-breakpoint
CREATE INDEX `task_pairs_by_decided_by_type_decided_by_id` ON `task_pairs` (`decided_by_type`,`decided_by_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_title_folded` ON `tasks` (`title_folded`);--> statement-breakpoint
CREATE INDEX `tasks_close_reason_to_fold` ON `tasks` (`id`) WHERE close_reason IS NOT NULL AND close_reason_folded IS NULL;--> statement-breakpoint
CREATE INDEX `tasks_by_status` ON `tasks` (`project_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_by_project_id_status_next_check_at` ON `tasks` (`project_id`,`status`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `tasks_by_project_id_source_locator` ON `tasks` (`project_id`,`source_locator`);--> statement-breakpoint
CREATE INDEX `tasks_by_source_group` ON `tasks` (`source_group`);--> statement-breakpoint
CREATE INDEX `tasks_by_provider_external_id` ON `tasks` (`provider`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_by_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_closed_by_type_closed_by_id` ON `tasks` (`closed_by_type`,`closed_by_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_author_type_author_id` ON `tasks` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_close_suggested_by_type_close_suggested_by_id` ON `tasks` (`close_suggested_by_type`,`close_suggested_by_id`);--> statement-breakpoint
CREATE INDEX `tracker_items_by_account_id_kind_parent_id` ON `tracker_items` (`account_id`,`kind`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `aliases_displayed` ON `aliases` (`aliasable_type`,`aliasable_id`,ifnull("account_id", 0)) WHERE display = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `aliases_by_aliasable_type_aliasable_id_name_folded` ON `aliases` (`aliasable_type`,`aliasable_id`,`name_folded`) WHERE account_id IS NULL AND aliasable_type = 'project' OR account_id IS NULL AND aliasable_type = 'tag';--> statement-breakpoint
CREATE INDEX `aliases_by_aliasable_type_aliasable_id` ON `aliases` (`aliasable_type`,`aliasable_id`);--> statement-breakpoint
CREATE INDEX `aliases_by_account_id` ON `aliases` (`account_id`);--> statement-breakpoint
CREATE INDEX `calendar_entry_participants_by_identity_id` ON `calendar_entry_participants` (`identity_id`);--> statement-breakpoint
CREATE INDEX `calendar_entry_revisions_by_entry_id_created_at` ON `calendar_entry_revisions` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_events_by_chat_id_happened_at` ON `chat_events` (`chat_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `chat_events_by_actor_identity_id` ON `chat_events` (`actor_identity_id`);--> statement-breakpoint
CREATE INDEX `chat_revisions_by_chat_id_created_at` ON `chat_revisions` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_revisions_by_account_id_old_value` ON `chat_revisions` (`account_id`,`old_value`) WHERE field = 'external_id';--> statement-breakpoint
CREATE INDEX `content_post_revisions_by_post_id_created_at` ON `content_post_revisions` (`post_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversations_by_chat` ON `conversations` (`chat_id`,`build`,`first_at`);--> statement-breakpoint
CREATE INDEX `conversations_by_first_message_id` ON `conversations` (`first_message_id`);--> statement-breakpoint
CREATE INDEX `crm_files_by_account_id_owner_kind_owner_id` ON `crm_files` (`account_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE INDEX `decision_requests_by_channel_bot_profile_chat_id_message_id` ON `decision_requests` (`channel`,`bot_profile`,`chat_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `document_changes_by_account_id_at` ON `document_changes` (`account_id`,`at`);--> statement-breakpoint
CREATE INDEX `email_recipients_by_email_id` ON `email_recipients` (`email_id`);--> statement-breakpoint
CREATE INDEX `email_recipients_by_identity_id` ON `email_recipients` (`identity_id`);--> statement-breakpoint
CREATE INDEX `entity_link_events_by_linkable_type_linkable_id` ON `entity_link_events` (`linkable_type`,`linkable_id`);--> statement-breakpoint
CREATE INDEX `entity_link_events_by_entity_type_to_entity_id` ON `entity_link_events` (`entity_type`,`to_entity_id`);--> statement-breakpoint
CREATE INDEX `events_by_time` ON `events` (`starts_at`);--> statement-breakpoint
CREATE INDEX `events_by_event_series_id` ON `events` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `fact_removals_by_removed_at` ON `fact_removals` (`removed_at`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_identity_id` ON `identity_link_events` (`identity_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_from_person_id` ON `identity_link_events` (`from_person_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_to_person_id` ON `identity_link_events` (`to_person_id`);--> statement-breakpoint
CREATE INDEX `mailboxes_by_name_folded` ON `mailboxes` (`name_folded`);--> statement-breakpoint
CREATE INDEX `mailboxes_name_to_fold` ON `mailboxes` (`id`) WHERE name_folded IS NULL;--> statement-breakpoint
CREATE INDEX `member_observations_by_chat_id_observed_at_id` ON `member_observations` (`chat_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_stays_open` ON `member_stays` (`chat_id`,`identity_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX `member_stays_by_identity_id` ON `member_stays` (`identity_id`);--> statement-breakpoint
CREATE INDEX `member_stays_by_invited_by_identity_id` ON `member_stays` (`invited_by_identity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_links_unique` ON `message_links` (`message_id`,ifnull("parent_id", 0),`source`,`kind`,ifnull("build", 0));--> statement-breakpoint
CREATE INDEX `message_links_by_build` ON `message_links` (`chat_id`,`build`);--> statement-breakpoint
CREATE INDEX `message_links_by_parent_id` ON `message_links` (`parent_id`);--> statement-breakpoint
CREATE INDEX `message_reactions_by_identity_id` ON `message_reactions` (`identity_id`);--> statement-breakpoint
CREATE INDEX `message_revisions_by_message_id` ON `message_revisions` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_transcripts_by_message_id` ON `message_transcripts` (`message_id`);--> statement-breakpoint
CREATE INDEX `note_revisions_by_note_id` ON `note_revisions` (`note_id`);--> statement-breakpoint
CREATE INDEX `organization_identities_by_organization_id` ON `organization_identities` (`organization_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_by_invoice_id` ON `payment_allocations` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_by_author_type_author_id` ON `payment_allocations` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `persons_by_kind` ON `persons` (`kind`);--> statement-breakpoint
CREATE INDEX `persons_kind_to_work_out` ON `persons` (`id`) WHERE kind IS NULL;--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_item_type_item_id` ON `pipeline_stage_changes` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_pipeline_id` ON `pipeline_stage_changes` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_from_stage_id` ON `pipeline_stage_changes` (`from_stage_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_to_stage_id` ON `pipeline_stage_changes` (`to_stage_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_stages_by_pipeline_id_external_id` ON `pipeline_stages` (`pipeline_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pipeline_stages_by_pipeline_id_position` ON `pipeline_stages` (`pipeline_id`,`position`);--> statement-breakpoint
CREATE INDEX `pipeline_stages_by_base_stage_id` ON `pipeline_stages` (`base_stage_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_account_id_kind_external_id` ON `pipelines` (`account_id`,`kind`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_name_folded_kind` ON `pipelines` (`name_folded`,`kind`) WHERE account_id IS NULL;--> statement-breakpoint
CREATE INDEX `record_relations_by_target_type_target_external_id` ON `record_relations` (`target_type`,`target_external_id`);--> statement-breakpoint
CREATE INDEX `record_relations_by_target_id` ON `record_relations` (`target_id`);--> statement-breakpoint
CREATE INDEX `reminders_due` ON `reminders` (`account_id`,`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `reminders_by_task_id` ON `reminders` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_assignments_by_assignee_type_assignee_id` ON `task_assignments` (`assignee_type`,`assignee_id`);--> statement-breakpoint
CREATE INDEX `templates_history_by_key_channel_language_id` ON `templates_history` (`key`,`channel`,`language`,`id`);--> statement-breakpoint
CREATE INDEX `transaction_splits_by_category_folded` ON `transaction_splits` (`category_folded`);--> statement-breakpoint
CREATE INDEX `transaction_splits_by_project_id` ON `transaction_splits` (`project_id`);