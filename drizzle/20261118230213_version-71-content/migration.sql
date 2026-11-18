CREATE TABLE `content_authors` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`data` text NOT NULL,
	`source_updated_at` integer,
	`deleted_at` integer,
	`synced_at` integer NOT NULL,
	CONSTRAINT `fk_content_authors_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `content_authors_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `content_channels` (
	`id` integer PRIMARY KEY,
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
CREATE TABLE `content_metrics` (
	`id` integer PRIMARY KEY,
	`post_id` integer NOT NULL,
	`at` integer NOT NULL,
	`views` integer,
	`reactions` integer,
	`comments` integer,
	`shares` integer,
	`clicks` integer,
	`raw` text,
	CONSTRAINT `fk_content_metrics_post_id_content_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `content_posts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `content_post_revisions` (
	`id` integer PRIMARY KEY,
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
CREATE TABLE `content_posts` (
	`id` integer PRIMARY KEY,
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
	CONSTRAINT `content_posts_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `content_terms` (
	`id` integer PRIMARY KEY,
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
	CONSTRAINT `content_terms_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `content_metrics_by_post_id_at` ON `content_metrics` (`post_id`,`at`);--> statement-breakpoint
CREATE INDEX `content_post_revisions_by_post_id_created_at` ON `content_post_revisions` (`post_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_posts_by_account_id_status` ON `content_posts` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `content_posts_by_account_id_published_at` ON `content_posts` (`account_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `content_terms_by_tag_id` ON `content_terms` (`tag_id`);