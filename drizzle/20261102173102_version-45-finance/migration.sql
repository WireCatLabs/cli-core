CREATE TABLE `invoice_lines` (
	`id` integer PRIMARY KEY,
	`invoice_id` integer NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` integer,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_invoice_lines_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`),
	CONSTRAINT `invoice_lines_invoice_id_position_unique` UNIQUE(`invoice_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY,
	`direction` text NOT NULL,
	`number` text,
	`issuer_type` text,
	`issuer_id` integer,
	`counterparty_type` text NOT NULL,
	`counterparty_id` integer NOT NULL,
	`project_id` integer,
	`currency` text NOT NULL,
	`total` integer NOT NULL,
	`issue_date` text,
	`due_date` text,
	`status` text NOT NULL,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_invoices_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` integer PRIMARY KEY,
	`payment_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_payment_allocations_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_payment_allocations_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`),
	CONSTRAINT `payment_allocations_payment_id_invoice_id_unique` UNIQUE(`payment_id`,`invoice_id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY,
	`direction` text NOT NULL,
	`payer_type` text,
	`payer_id` integer,
	`payee_type` text,
	`payee_id` integer,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`payment_date` text NOT NULL,
	`reference` text,
	`project_id` integer,
	`review` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_payments_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE INDEX `invoices_by_issuer_type_issuer_id` ON `invoices` (`issuer_type`,`issuer_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_counterparty_type_counterparty_id` ON `invoices` (`counterparty_type`,`counterparty_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_project_id` ON `invoices` (`project_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_author_type_author_id` ON `invoices` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_confirmed_by_type_confirmed_by_id` ON `invoices` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_by_invoice_id` ON `payment_allocations` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_by_author_type_author_id` ON `payment_allocations` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `payments_by_payer_type_payer_id` ON `payments` (`payer_type`,`payer_id`);--> statement-breakpoint
CREATE INDEX `payments_by_payee_type_payee_id` ON `payments` (`payee_type`,`payee_id`);--> statement-breakpoint
CREATE INDEX `payments_by_project_id` ON `payments` (`project_id`);--> statement-breakpoint
CREATE INDEX `payments_by_author_type_author_id` ON `payments` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `payments_by_confirmed_by_type_confirmed_by_id` ON `payments` (`confirmed_by_type`,`confirmed_by_id`);