CREATE TABLE `tag_consolidations` (
	`id` integer PRIMARY KEY,
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
	CONSTRAINT `fk_tag_consolidations_survivor_id_canonical_tags_id_fk` FOREIGN KEY (`survivor_id`) REFERENCES `canonical_tags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tag_redirects` (
	`source_id` integer PRIMARY KEY,
	`survivor_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_tag_redirects_source_id_canonical_tags_id_fk` FOREIGN KEY (`source_id`) REFERENCES `canonical_tags`(`id`),
	CONSTRAINT `fk_tag_redirects_survivor_id_canonical_tags_id_fk` FOREIGN KEY (`survivor_id`) REFERENCES `canonical_tags`(`id`)
);
--> statement-breakpoint
ALTER TABLE `auto_tag_claims` RENAME TO `canonical_auto_tag_claims`;--> statement-breakpoint
ALTER TABLE `tags` RENAME TO `canonical_tags`;--> statement-breakpoint
DROP INDEX IF EXISTS `auto_tag_claims_by_tag_id`;--> statement-breakpoint
CREATE INDEX `canonical_auto_tag_claims_by_tag_id` ON `canonical_auto_tag_claims` (`tag_id`);--> statement-breakpoint
CREATE INDEX `tag_consolidations_by_source_id` ON `tag_consolidations` (`source_id`);--> statement-breakpoint
CREATE INDEX `tag_consolidations_by_survivor_id` ON `tag_consolidations` (`survivor_id`);--> statement-breakpoint
CREATE INDEX `tag_consolidations_by_actor_type_actor_id` ON `tag_consolidations` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `tag_redirects_by_survivor_id` ON `tag_redirects` (`survivor_id`);