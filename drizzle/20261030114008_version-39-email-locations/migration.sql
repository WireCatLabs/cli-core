CREATE TABLE `email_locations` (
	`mailbox_id` integer NOT NULL,
	`uidvalidity` text NOT NULL,
	`uid` integer NOT NULL,
	`email_id` integer NOT NULL,
	CONSTRAINT `email_locations_pk` PRIMARY KEY(`mailbox_id`, `uidvalidity`, `uid`),
	CONSTRAINT `fk_email_locations_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`),
	CONSTRAINT `fk_email_locations_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`)
);
--> statement-breakpoint
CREATE INDEX `email_locations_by_email_id` ON `email_locations` (`email_id`);