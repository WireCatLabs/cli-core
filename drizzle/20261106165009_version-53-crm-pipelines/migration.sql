ALTER TABLE `pipeline_stages` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `deleted_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `pipelines_by_account_id_external_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_account_id_kind_external_id` ON `pipelines` (`account_id`,`kind`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;