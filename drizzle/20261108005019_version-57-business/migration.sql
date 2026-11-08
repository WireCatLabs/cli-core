CREATE TABLE `catalog_items` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`sku` text,
	`supplier_type` text,
	`supplier_id` integer,
	`unit` text,
	`unit_price` integer,
	`currency` text,
	`description` text,
	`archived_date` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL,
	`number` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`signed_date` text,
	`effective_date` text,
	`expiration_date` text,
	`auto_renew` integer DEFAULT 0 NOT NULL,
	`renewal_count` integer,
	`renewal_unit` text,
	`notice_days` integer,
	`terms` text,
	`value` integer,
	`currency` text,
	`project_id` integer,
	`deal_id` integer,
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
	CONSTRAINT `fk_contracts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_contracts_deal_id_deals_id_fk` FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_accounts` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`institution` text,
	`number_hint` text,
	`holder_type` text,
	`holder_id` integer,
	`opening_balance` integer,
	`opening_date` text,
	`closed_date` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `financial_transactions` (
	`id` integer PRIMARY KEY,
	`financial_account_id` integer NOT NULL,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`statement_date` text NOT NULL,
	`booked_date` text,
	`description` text,
	`counterparty_name` text,
	`counterparty_type` text,
	`counterparty_id` integer,
	`reference` text,
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
	CONSTRAINT `fk_financial_transactions_financial_account_id_financial_accounts_id_fk` FOREIGN KEY (`financial_account_id`) REFERENCES `financial_accounts`(`id`),
	CONSTRAINT `fk_financial_transactions_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
	CONSTRAINT `fk_financial_transactions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_lines` (
	`id` integer PRIMARY KEY,
	`order_id` integer NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` integer,
	`amount` integer NOT NULL,
	`catalog_item_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_order_lines_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`),
	CONSTRAINT `fk_order_lines_catalog_item_id_catalog_items_id_fk` FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`),
	CONSTRAINT `order_lines_order_id_position_unique` UNIQUE(`order_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `subscription_prices` (
	`id` integer PRIMARY KEY,
	`subscription_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`effective_from` text NOT NULL,
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
	CONSTRAINT `fk_subscription_prices_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`supplier_type` text NOT NULL,
	`supplier_id` integer NOT NULL,
	`customer_type` text NOT NULL,
	`customer_id` integer NOT NULL,
	`catalog_item_id` integer,
	`contract_id` integer,
	`project_id` integer,
	`status` text NOT NULL,
	`interval_count` integer NOT NULL,
	`interval_unit` text NOT NULL,
	`start_date` text NOT NULL,
	`trial_end_date` text,
	`next_renewal_date` text,
	`cancelled_date` text,
	`end_date` text,
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
	CONSTRAINT `fk_subscriptions_catalog_item_id_catalog_items_id_fk` FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`),
	CONSTRAINT `fk_subscriptions_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`),
	CONSTRAINT `fk_subscriptions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` integer PRIMARY KEY,
	`transaction_id` integer NOT NULL,
	`position` integer NOT NULL,
	`category` text NOT NULL,
	`category_folded` text NOT NULL,
	`amount` integer NOT NULL,
	`project_id` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_transaction_splits_transaction_id_financial_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `financial_transactions`(`id`),
	CONSTRAINT `fk_transaction_splits_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `transaction_splits_transaction_id_position_unique` UNIQUE(`transaction_id`,`position`)
);
--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `catalog_item_id` integer REFERENCES catalog_items(id);--> statement-breakpoint
ALTER TABLE `invoices` ADD `contract_id` integer REFERENCES contracts(id);--> statement-breakpoint
ALTER TABLE `invoices` ADD `subscription_id` integer REFERENCES subscriptions(id);--> statement-breakpoint
ALTER TABLE `orders` ADD `contract_id` integer REFERENCES contracts(id);--> statement-breakpoint
ALTER TABLE `orders` ADD `deal_id` integer REFERENCES deals(id);--> statement-breakpoint
ALTER TABLE `orders` ADD `direction` text DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `refund_of` integer REFERENCES payments(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `subscription_id` integer REFERENCES subscriptions(id);--> statement-breakpoint
ALTER TABLE `record_relations` ADD `as_role` text;--> statement-breakpoint
ALTER TABLE `records` ADD `created_entity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_by_supplier_type_supplier_id_sku` ON `catalog_items` (`supplier_type`,`supplier_id`,`sku`) WHERE supplier_id IS NOT NULL AND sku IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_by_sku` ON `catalog_items` (`sku`) WHERE supplier_id IS NULL AND sku IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `catalog_items_by_name_folded` ON `catalog_items` (`name_folded`);--> statement-breakpoint
CREATE INDEX `catalog_items_by_author_type_author_id` ON `catalog_items` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_project_id` ON `contracts` (`project_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_deal_id` ON `contracts` (`deal_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_author_type_author_id` ON `contracts` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `contracts_by_confirmed_by_type_confirmed_by_id` ON `contracts` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `financial_accounts_by_name_folded` ON `financial_accounts` (`name_folded`);--> statement-breakpoint
CREATE INDEX `financial_accounts_by_holder_type_holder_id` ON `financial_accounts` (`holder_type`,`holder_id`);--> statement-breakpoint
CREATE INDEX `financial_accounts_by_author_type_author_id` ON `financial_accounts` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_financial_account_id_booked_date` ON `financial_transactions` (`financial_account_id`,`booked_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `financial_transactions_by_payment_id` ON `financial_transactions` (`payment_id`) WHERE payment_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `financial_transactions_by_counterparty_type_counterparty_id` ON `financial_transactions` (`counterparty_type`,`counterparty_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_project_id` ON `financial_transactions` (`project_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_author_type_author_id` ON `financial_transactions` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `financial_transactions_by_confirmed_by_type_confirmed_by_id` ON `financial_transactions` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_by_catalog_item_id` ON `invoice_lines` (`catalog_item_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_contract_id` ON `invoices` (`contract_id`);--> statement-breakpoint
CREATE INDEX `invoices_by_subscription_id` ON `invoices` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `order_lines_by_catalog_item_id` ON `order_lines` (`catalog_item_id`);--> statement-breakpoint
CREATE INDEX `orders_by_contract_id` ON `orders` (`contract_id`);--> statement-breakpoint
CREATE INDEX `orders_by_deal_id` ON `orders` (`deal_id`);--> statement-breakpoint
CREATE INDEX `payments_by_refund_of` ON `payments` (`refund_of`);--> statement-breakpoint
CREATE INDEX `payments_by_subscription_id` ON `payments` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `records_by_account_id_batch_id` ON `records` (`account_id`,`batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_prices_by_subscription_id_effective_from` ON `subscription_prices` (`subscription_id`,`effective_from`) WHERE review <> 'rejected';--> statement-breakpoint
CREATE INDEX `subscription_prices_by_author_type_author_id` ON `subscription_prices` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `subscription_prices_by_confirmed_by_type_confirmed_by_id` ON `subscription_prices` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_supplier_type_supplier_id` ON `subscriptions` (`supplier_type`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_customer_type_customer_id` ON `subscriptions` (`customer_type`,`customer_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_catalog_item_id` ON `subscriptions` (`catalog_item_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_contract_id` ON `subscriptions` (`contract_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_project_id` ON `subscriptions` (`project_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_author_type_author_id` ON `subscriptions` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_by_confirmed_by_type_confirmed_by_id` ON `subscriptions` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `transaction_splits_by_category_folded` ON `transaction_splits` (`category_folded`);--> statement-breakpoint
CREATE INDEX `transaction_splits_by_project_id` ON `transaction_splits` (`project_id`);