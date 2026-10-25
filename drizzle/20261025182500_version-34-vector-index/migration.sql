CREATE TABLE `vector_index_redo` (
	`chunk_id` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vector_indexes` (
	`id` integer PRIMARY KEY,
	`model` text NOT NULL UNIQUE,
	`dims` integer NOT NULL,
	`ready` integer NOT NULL,
	`filled_through` text NOT NULL
);
