CREATE TABLE `mail_rules` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`protected` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`reason` text,
	`decided_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_mail_rules_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `mail_rules_account_id_conditions_unique` UNIQUE(`account_id`,`conditions`)
);
--> statement-breakpoint
ALTER TABLE `emails` ADD `mail_rule_id` integer;--> statement-breakpoint
CREATE INDEX `emails_by_mail_rule_id` ON `emails` (`mail_rule_id`) WHERE mail_rule_id IS NOT NULL;