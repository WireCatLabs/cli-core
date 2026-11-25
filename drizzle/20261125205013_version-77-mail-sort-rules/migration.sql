CREATE TABLE `mail_sort_effects` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`rule_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`created_at` integer NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE TABLE `mail_sort_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`scope` text NOT NULL,
	`value` text NOT NULL,
	`mail_type` text,
	`sender` text,
	`organization_id` integer,
	`over_addresses` integer NOT NULL,
	`past` integer NOT NULL,
	`author` text NOT NULL,
	`decided_by` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	`undone_at` integer
);
--> statement-breakpoint
ALTER TABLE `emails` ADD `sort_checked` integer;--> statement-breakpoint
CREATE INDEX `emails_sort_to_check` ON `emails` (`id`) WHERE mail_type IS NOT NULL AND sort_checked IS NULL;--> statement-breakpoint
CREATE INDEX `mail_sort_effects_by_rule_id` ON `mail_sort_effects` (`rule_id`);--> statement-breakpoint
CREATE INDEX `mail_sort_effects_by_identity_id` ON `mail_sort_effects` (`identity_id`);--> statement-breakpoint
CREATE INDEX `mail_sort_rules_by_scope_value` ON `mail_sort_rules` (`scope`,`value`);