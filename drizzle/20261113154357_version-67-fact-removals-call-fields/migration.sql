CREATE TABLE `fact_removals` (
	`id` integer PRIMARY KEY,
	`fact_id` integer NOT NULL,
	`subject` text,
	`removed_by` text NOT NULL,
	`bot` text,
	`reason` text,
	`removed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `meetings` ADD `direction` text;--> statement-breakpoint
ALTER TABLE `meetings` ADD `client_phone` text;--> statement-breakpoint
CREATE INDEX `fact_removals_by_removed_at` ON `fact_removals` (`removed_at`);