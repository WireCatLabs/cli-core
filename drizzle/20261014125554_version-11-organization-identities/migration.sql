CREATE TABLE `organization_identities` (
	`id` integer PRIMARY KEY,
	`identity_id` integer NOT NULL,
	`organization_id` integer NOT NULL,
	`method` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_organization_identities_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_organization_identities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `organization_identities_identity_id_organization_id_unique` UNIQUE(`identity_id`,`organization_id`)
);
--> statement-breakpoint
CREATE INDEX `organization_identities_by_organization_id` ON `organization_identities` (`organization_id`);