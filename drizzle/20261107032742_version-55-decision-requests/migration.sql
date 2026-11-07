CREATE TABLE `decision_requests` (
	`id` integer PRIMARY KEY,
	`token_digest` text NOT NULL UNIQUE,
	`proposal_id` text NOT NULL,
	`action` text NOT NULL,
	`batch_digest` text NOT NULL,
	`channel` text NOT NULL,
	`bot_profile` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`cancelled_at` integer
);
