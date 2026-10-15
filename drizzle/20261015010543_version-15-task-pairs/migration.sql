CREATE TABLE `task_pairs` (
	`id` integer PRIMARY KEY,
	`task_id` integer,
	`source_locator` text,
	`other_id` integer NOT NULL,
	`score` integer NOT NULL,
	`band` text NOT NULL,
	`levels` text NOT NULL,
	`reasons` text NOT NULL,
	`decision` text NOT NULL,
	`decided_by_type` text,
	`decided_by_id` integer,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_task_pairs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_task_pairs_other_id_tasks_id_fk` FOREIGN KEY (`other_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `task_pairs_task_id_other_id_unique` UNIQUE(`task_id`,`other_id`)
);
--> statement-breakpoint
CREATE INDEX `task_pairs_by_decision_created_at` ON `task_pairs` (`decision`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_pairs_by_other_id` ON `task_pairs` (`other_id`);--> statement-breakpoint
CREATE INDEX `task_pairs_by_decided_by_type_decided_by_id` ON `task_pairs` (`decided_by_type`,`decided_by_id`);