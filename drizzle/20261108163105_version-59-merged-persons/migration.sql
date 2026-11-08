ALTER TABLE `persons` ADD `merged_into` integer;--> statement-breakpoint
CREATE INDEX `persons_by_merged_into` ON `persons` (`merged_into`) WHERE merged_into IS NOT NULL;