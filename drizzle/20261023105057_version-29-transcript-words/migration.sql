CREATE TABLE `transcript_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `transcript_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
