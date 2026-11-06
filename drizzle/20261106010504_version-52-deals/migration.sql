CREATE TABLE `opportunities` (
	`id` integer PRIMARY KEY,
	`kind` text DEFAULT 'deal' NOT NULL,
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
	CONSTRAINT `fk_opportunities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_opportunities_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_opportunities_stage_id_pipeline_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `pipeline_stages`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_stages` (
	`id` integer PRIMARY KEY,
	`pipeline_id` integer NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`position` integer NOT NULL,
	`outcome` text DEFAULT 'open' NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_pipeline_stages_pipeline_id_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`),
	CONSTRAINT `pipeline_stages_pipeline_id_name_folded_unique` UNIQUE(`pipeline_id`,`name_folded`)
);
--> statement-breakpoint
CREATE TABLE `pipelines` (
	`id` integer PRIMARY KEY,
	`account_id` integer,
	`external_id` text,
	`kind` text DEFAULT 'deal' NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_pipelines_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `opportunities_by_organization_id` ON `opportunities` (`organization_id`);--> statement-breakpoint
CREATE INDEX `opportunities_by_project_id` ON `opportunities` (`project_id`);--> statement-breakpoint
CREATE INDEX `opportunities_by_stage_id` ON `opportunities` (`stage_id`);--> statement-breakpoint
CREATE INDEX `opportunities_by_author_type_author_id` ON `opportunities` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `opportunities_by_confirmed_by_type_confirmed_by_id` ON `opportunities` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_stages_by_pipeline_id_external_id` ON `pipeline_stages` (`pipeline_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pipeline_stages_by_pipeline_id_position` ON `pipeline_stages` (`pipeline_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_account_id_external_id` ON `pipelines` (`account_id`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_name_folded_kind` ON `pipelines` (`name_folded`,`kind`) WHERE account_id IS NULL;