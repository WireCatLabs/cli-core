CREATE TABLE `places` (
	`id` integer PRIMARY KEY,
	`address` text NOT NULL,
	`folded` text NOT NULL UNIQUE,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
