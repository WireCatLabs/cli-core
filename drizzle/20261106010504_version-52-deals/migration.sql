CREATE TABLE `deals` (
	`id` integer PRIMARY KEY,
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
	CONSTRAINT `fk_deals_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY,
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
	CONSTRAINT `fk_leads_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_stage_changes` (
	`id` integer PRIMARY KEY,
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
CREATE UNIQUE INDEX `deals_by_account_id_external_id` ON `deals` (`account_id`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `deals_by_organization_id` ON `deals` (`organization_id`);--> statement-breakpoint
CREATE INDEX `deals_by_project_id` ON `deals` (`project_id`);--> statement-breakpoint
CREATE INDEX `deals_by_stage_id` ON `deals` (`stage_id`);--> statement-breakpoint
CREATE INDEX `deals_by_author_type_author_id` ON `deals` (`author_type`,`author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `leads_by_account_id_external_id` ON `leads` (`account_id`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `leads_by_organization_id` ON `leads` (`organization_id`);--> statement-breakpoint
CREATE INDEX `leads_by_project_id` ON `leads` (`project_id`);--> statement-breakpoint
CREATE INDEX `leads_by_stage_id` ON `leads` (`stage_id`);--> statement-breakpoint
CREATE INDEX `leads_by_deal_id` ON `leads` (`deal_id`);--> statement-breakpoint
CREATE INDEX `leads_by_author_type_author_id` ON `leads` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_item_type_item_id` ON `pipeline_stage_changes` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_pipeline_id` ON `pipeline_stage_changes` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_from_stage_id` ON `pipeline_stage_changes` (`from_stage_id`);--> statement-breakpoint
CREATE INDEX `pipeline_stage_changes_by_to_stage_id` ON `pipeline_stage_changes` (`to_stage_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_stages_by_pipeline_id_external_id` ON `pipeline_stages` (`pipeline_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pipeline_stages_by_pipeline_id_position` ON `pipeline_stages` (`pipeline_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_account_id_external_id` ON `pipelines` (`account_id`,`external_id`) WHERE account_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_by_name_folded_kind` ON `pipelines` (`name_folded`,`kind`) WHERE account_id IS NULL;