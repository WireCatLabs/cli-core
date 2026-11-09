ALTER TABLE `account_identities` ADD `address_book` integer;--> statement-breakpoint
CREATE INDEX `account_identities_in_address_book` ON `account_identities` (`identity_id`) WHERE address_book = 1;