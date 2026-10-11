CREATE TABLE `facts` (
	`id` integer PRIMARY KEY,
	`type` text NOT NULL,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`project_id` integer,
	`subject_type` text,
	`subject_id` integer,
	`occurred_at` integer,
	`supersedes_id` integer,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`scope` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_facts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_facts_supersedes_id_facts_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `facts`(`id`)
);
--> statement-breakpoint
ALTER TABLE `memories` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `facts_by_project_id` ON `facts` (`project_id`);--> statement-breakpoint
CREATE INDEX `facts_by_subject_type_subject_id` ON `facts` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `facts_by_supersedes_id` ON `facts` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `facts_by_author_type_author_id` ON `facts` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `facts_by_confirmed_by_type_confirmed_by_id` ON `facts` (`confirmed_by_type`,`confirmed_by_id`);