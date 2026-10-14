ALTER TABLE `identity_link_events` ADD `from_organization_id` integer REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `identity_link_events` ADD `to_organization_id` integer REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `identity_links` ADD `organization_id` integer REFERENCES organizations(id);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_identity_link_events` (
	`id` integer PRIMARY KEY,
	`identity_id` integer NOT NULL,
	`from_person_id` integer,
	`to_person_id` integer,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	`from_organization_id` integer,
	`to_organization_id` integer,
	CONSTRAINT `fk_identity_link_events_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_link_events_from_person_id_persons_id_fk` FOREIGN KEY (`from_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_identity_link_events_to_person_id_persons_id_fk` FOREIGN KEY (`to_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_identity_link_events_from_organization_id_organizations_id_fk` FOREIGN KEY (`from_organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_identity_link_events_to_organization_id_organizations_id_fk` FOREIGN KEY (`to_organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_identity_link_events`(`id`, `identity_id`, `from_person_id`, `to_person_id`, `method`, `created_at`, `author`) SELECT `id`, `identity_id`, `from_person_id`, `to_person_id`, `method`, `created_at`, `author` FROM `identity_link_events`;--> statement-breakpoint
DROP TABLE `identity_link_events`;--> statement-breakpoint
ALTER TABLE `__new_identity_link_events` RENAME TO `identity_link_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_identity_links` (
	`identity_id` integer PRIMARY KEY,
	`person_id` integer,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	`source` text,
	`updated_at` integer NOT NULL,
	`organization_id` integer,
	CONSTRAINT `fk_identity_links_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_links_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_identity_links_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_identity_links`(`identity_id`, `person_id`, `method`, `confidence`, `created_at`, `author`, `source`, `updated_at`) SELECT `identity_id`, `person_id`, `method`, `confidence`, `created_at`, `author`, `source`, `updated_at` FROM `identity_links`;--> statement-breakpoint
DROP TABLE `identity_links`;--> statement-breakpoint
ALTER TABLE `__new_identity_links` RENAME TO `identity_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `identity_link_events_by_identity_id` ON `identity_link_events` (`identity_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_from_person_id` ON `identity_link_events` (`from_person_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_to_person_id` ON `identity_link_events` (`to_person_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_from_organization_id` ON `identity_link_events` (`from_organization_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_to_organization_id` ON `identity_link_events` (`to_organization_id`);--> statement-breakpoint
CREATE INDEX `identity_links_by_person_id` ON `identity_links` (`person_id`);--> statement-breakpoint
CREATE INDEX `identity_links_by_organization_id` ON `identity_links` (`organization_id`);