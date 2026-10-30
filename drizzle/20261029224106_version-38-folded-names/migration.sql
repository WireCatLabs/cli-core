ALTER TABLE `chats` ADD `title_folded` text;--> statement-breakpoint
ALTER TABLE `email_threads` ADD `subject_folded` text;--> statement-breakpoint
ALTER TABLE `identities` ADD `name_folded` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `name_folded` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `name_folded` text;--> statement-breakpoint
CREATE INDEX `chats_title_to_fold` ON `chats` (`id`) WHERE title IS NOT NULL AND title_folded IS NULL;--> statement-breakpoint
CREATE INDEX `email_threads_subject_to_fold` ON `email_threads` (`id`) WHERE subject IS NOT NULL AND subject_folded IS NULL;--> statement-breakpoint
CREATE INDEX `identities_name_to_fold` ON `identities` (`id`) WHERE name IS NOT NULL AND name_folded IS NULL;--> statement-breakpoint
CREATE INDEX `mailboxes_by_name_folded` ON `mailboxes` (`name_folded`);--> statement-breakpoint
CREATE INDEX `mailboxes_name_to_fold` ON `mailboxes` (`id`) WHERE name_folded IS NULL;--> statement-breakpoint
CREATE INDEX `projects_by_name_folded` ON `projects` (`name_folded`);--> statement-breakpoint
CREATE INDEX `projects_name_to_fold` ON `projects` (`id`) WHERE name_folded IS NULL;