CREATE TABLE `enrichments` (
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`source_hash` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`text` text NOT NULL,
	`tokens` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `enrichments_pk` PRIMARY KEY(`subject_type`, `subject_id`)
);