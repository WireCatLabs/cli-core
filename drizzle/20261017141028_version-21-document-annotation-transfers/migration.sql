CREATE TABLE `document_annotation_transfers` (
	`source_key` text NOT NULL,
	`collection` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`bindings_hash` text NOT NULL,
	`reference_map` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `document_annotation_transfers_pk` PRIMARY KEY(`source_key`, `collection`)
);
