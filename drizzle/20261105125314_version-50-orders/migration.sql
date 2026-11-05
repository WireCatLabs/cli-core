CREATE TABLE `orders` (
	`id` integer PRIMARY KEY,
	`customer_type` text NOT NULL,
	`customer_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`supplier_type` text,
	`supplier_id` integer,
	`supplier_name` text NOT NULL,
	`number` text,
	`currency` text,
	`total` integer,
	`status` text NOT NULL,
	`order_date` text,
	`fulfilled_date` text,
	`invoice_id` integer,
	`payment_id` integer,
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
	CONSTRAINT `fk_orders_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`),
	CONSTRAINT `fk_orders_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_orders_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE INDEX `orders_by_customer_type_customer_id` ON `orders` (`customer_type`,`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_by_supplier_type_supplier_id` ON `orders` (`supplier_type`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `orders_by_invoice_id` ON `orders` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `orders_by_payment_id` ON `orders` (`payment_id`);--> statement-breakpoint
CREATE INDEX `orders_by_project_id` ON `orders` (`project_id`);--> statement-breakpoint
CREATE INDEX `orders_by_author_type_author_id` ON `orders` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `orders_by_confirmed_by_type_confirmed_by_id` ON `orders` (`confirmed_by_type`,`confirmed_by_id`);