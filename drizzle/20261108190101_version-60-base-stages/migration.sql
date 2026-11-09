ALTER TABLE `pipeline_stages` ADD `base_stage_id` integer REFERENCES pipeline_stages(id);--> statement-breakpoint
ALTER TABLE `pipeline_stages` ADD `base_confirmed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `pipeline_stages_by_base_stage_id` ON `pipeline_stages` (`base_stage_id`);