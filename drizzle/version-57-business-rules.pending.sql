-- The store's code checks these first and says why; the triggers keep a stray write from another build or a hand
-- edit from storing business data that does not add up. Paid is net: a confirmed refund's allocation counts against
-- the payment it refunds, so an invoice refunded in full is owed again.
CREATE TRIGGER catalog_items_valid_bi BEFORE INSERT ON catalog_items
  WHEN new.kind NOT IN ('product', 'service') OR new.unit_price < 0
    OR (new.unit_price IS NULL) <> (new.currency IS NULL) BEGIN
  SELECT RAISE(ABORT, 'catalog_items: kind product or service, a price of 0 or more with its currency');
END;
--> statement-breakpoint
CREATE TRIGGER catalog_items_valid_bu BEFORE UPDATE ON catalog_items
  WHEN new.kind NOT IN ('product', 'service') OR new.unit_price < 0
    OR (new.unit_price IS NULL) <> (new.currency IS NULL) BEGIN
  SELECT RAISE(ABORT, 'catalog_items: kind product or service, a price of 0 or more with its currency');
END;
--> statement-breakpoint
CREATE TRIGGER order_lines_valid_bi BEFORE INSERT ON order_lines
  WHEN new.amount < 0 OR new.unit_price < 0 BEGIN
  SELECT RAISE(ABORT, 'order_lines: an amount and a unit price of 0 or more');
END;
--> statement-breakpoint
CREATE TRIGGER order_lines_valid_bu BEFORE UPDATE ON order_lines
  WHEN new.amount < 0 OR new.unit_price < 0 OR new.order_id IS NOT old.order_id BEGIN
  SELECT RAISE(ABORT, 'order_lines: an amount and a unit price of 0 or more, on the same order');
END;
--> statement-breakpoint
DROP TRIGGER orders_valid_bi;
--> statement-breakpoint
CREATE TRIGGER orders_valid_bi BEFORE INSERT ON orders
  WHEN new.customer_type NOT IN ('person', 'organization')
    OR new.purpose NOT IN ('personal', 'business', 'client', 'other')
    OR new.status NOT IN ('placed', 'shipped', 'delivered', 'cancelled', 'returned')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR new.direction NOT IN ('purchase', 'sale')
    OR (new.total IS NULL) <> (new.currency IS NULL) OR new.total < 0 BEGIN
  SELECT RAISE(ABORT, 'orders: a person or organization customer, a known purpose, status, review and direction, an amount with its currency');
END;
--> statement-breakpoint
DROP TRIGGER orders_valid_bu;
--> statement-breakpoint
-- A line is written before the order's total moves to the new sum, so the sum is checked when the order changes.
CREATE TRIGGER orders_valid_bu BEFORE UPDATE ON orders
  WHEN new.customer_type NOT IN ('person', 'organization')
    OR new.purpose NOT IN ('personal', 'business', 'client', 'other')
    OR new.status NOT IN ('placed', 'shipped', 'delivered', 'cancelled', 'returned')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR new.direction NOT IN ('purchase', 'sale')
    OR (new.total IS NULL) <> (new.currency IS NULL) OR new.total < 0
    OR (EXISTS (SELECT 1 FROM order_lines WHERE order_id = new.id)
      AND (new.currency IS NULL OR new.total IS NOT (SELECT sum(amount) FROM order_lines WHERE order_id = new.id))) BEGIN
  SELECT RAISE(ABORT, 'orders: a known customer, purpose, status, review and direction; with lines, a currency and their sum as the total');
END;
--> statement-breakpoint
CREATE TRIGGER contracts_valid_bi BEFORE INSERT ON contracts
  WHEN new.kind NOT IN ('sale', 'purchase', 'service', 'lease', 'employment', 'nda', 'license', 'other')
    OR new.status NOT IN ('draft', 'active', 'ended', 'terminated')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected') OR new.auto_renew NOT IN (0, 1)
    OR (new.renewal_count IS NULL) <> (new.renewal_unit IS NULL) OR new.renewal_count < 1
    OR new.renewal_unit NOT IN ('day', 'week', 'month', 'year') OR new.notice_days < 0
    OR new.effective_date > new.expiration_date
    OR (new.value IS NULL) <> (new.currency IS NULL) OR new.value < 0 BEGIN
  SELECT RAISE(ABORT, 'contracts: a known kind, status and review, dates in order, a renewal and a value each complete');
END;
--> statement-breakpoint
CREATE TRIGGER contracts_valid_bu BEFORE UPDATE ON contracts
  WHEN new.kind NOT IN ('sale', 'purchase', 'service', 'lease', 'employment', 'nda', 'license', 'other')
    OR new.status NOT IN ('draft', 'active', 'ended', 'terminated')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected') OR new.auto_renew NOT IN (0, 1)
    OR (new.renewal_count IS NULL) <> (new.renewal_unit IS NULL) OR new.renewal_count < 1
    OR new.renewal_unit NOT IN ('day', 'week', 'month', 'year') OR new.notice_days < 0
    OR new.effective_date > new.expiration_date
    OR (new.value IS NULL) <> (new.currency IS NULL) OR new.value < 0 BEGIN
  SELECT RAISE(ABORT, 'contracts: a known kind, status and review, dates in order, a renewal and a value each complete');
END;
--> statement-breakpoint
CREATE TRIGGER subscriptions_valid_bi BEFORE INSERT ON subscriptions
  WHEN new.direction NOT IN ('receivable', 'payable')
    OR new.supplier_type NOT IN ('person', 'organization') OR new.customer_type NOT IN ('person', 'organization')
    OR new.status NOT IN ('trial', 'active', 'paused', 'cancelled', 'ended')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR new.interval_count < 1 OR new.interval_unit NOT IN ('day', 'week', 'month', 'year')
    OR new.trial_end_date < new.start_date OR new.end_date < new.start_date
    OR (new.status = 'trial' AND new.trial_end_date IS NULL)
    OR (new.status = 'cancelled' AND new.cancelled_date IS NULL) BEGIN
  SELECT RAISE(ABORT, 'subscriptions: a known direction, parties, status and review, an interval, dates in order');
END;
--> statement-breakpoint
CREATE TRIGGER subscriptions_valid_bu BEFORE UPDATE ON subscriptions
  WHEN new.direction NOT IN ('receivable', 'payable')
    OR new.supplier_type NOT IN ('person', 'organization') OR new.customer_type NOT IN ('person', 'organization')
    OR new.status NOT IN ('trial', 'active', 'paused', 'cancelled', 'ended')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR new.interval_count < 1 OR new.interval_unit NOT IN ('day', 'week', 'month', 'year')
    OR new.trial_end_date < new.start_date OR new.end_date < new.start_date
    OR (new.status = 'trial' AND new.trial_end_date IS NULL)
    OR (new.status = 'cancelled' AND new.cancelled_date IS NULL) BEGIN
  SELECT RAISE(ABORT, 'subscriptions: a known direction, parties, status and review, an interval, dates in order');
END;
--> statement-breakpoint
CREATE TRIGGER subscription_prices_valid_bi BEFORE INSERT ON subscription_prices
  WHEN new.amount < 0 OR new.review NOT IN ('proposed', 'confirmed', 'rejected') BEGIN
  SELECT RAISE(ABORT, 'subscription_prices: an amount of 0 or more and a known review');
END;
--> statement-breakpoint
-- A price is history: a correction is a rejection and a new row, so only its decision changes.
CREATE TRIGGER subscription_prices_fixed_bu BEFORE UPDATE ON subscription_prices
  WHEN new.amount IS NOT old.amount OR new.currency IS NOT old.currency
    OR new.effective_from IS NOT old.effective_from OR new.subscription_id IS NOT old.subscription_id
    OR new.author_type IS NOT old.author_type OR new.author_id IS NOT old.author_id
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected') BEGIN
  SELECT RAISE(ABORT, 'subscription_prices: a price is never changed; reject it and add a new one');
END;
--> statement-breakpoint
CREATE TRIGGER financial_accounts_valid_bi BEFORE INSERT ON financial_accounts
  WHEN new.kind NOT IN ('bank', 'card', 'cash', 'wallet', 'other')
    OR (new.opening_balance IS NULL) <> (new.opening_date IS NULL) OR length(new.number_hint) > 4
    OR new.holder_type NOT IN ('person', 'organization') BEGIN
  SELECT RAISE(ABORT, 'financial_accounts: a known kind, an opening balance with its date, at most 4 characters of the number');
END;
--> statement-breakpoint
CREATE TRIGGER financial_accounts_valid_bu BEFORE UPDATE ON financial_accounts
  WHEN new.kind NOT IN ('bank', 'card', 'cash', 'wallet', 'other')
    OR (new.opening_balance IS NULL) <> (new.opening_date IS NULL) OR length(new.number_hint) > 4
    OR new.holder_type NOT IN ('person', 'organization')
    OR (new.currency IS NOT old.currency
      AND EXISTS (SELECT 1 FROM financial_transactions WHERE financial_account_id = new.id)) BEGIN
  SELECT RAISE(ABORT, 'financial_accounts: a known kind, an opening balance with its date, the currency kept once it has transactions');
END;
--> statement-breakpoint
CREATE TRIGGER financial_transactions_valid_bi BEFORE INSERT ON financial_transactions
  WHEN new.direction NOT IN ('in', 'out') OR new.amount <= 0 OR new.status NOT IN ('pending', 'booked')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR new.currency IS NOT (SELECT currency FROM financial_accounts WHERE id = new.financial_account_id)
    OR (new.status = 'booked') <> (new.booked_date IS NOT NULL)
    OR (new.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = new.payment_id
      AND p.currency = new.currency AND p.direction = new.direction AND p.amount = new.amount)) BEGIN
  SELECT RAISE(ABORT, 'financial_transactions: a known direction, status and review, above 0 in its account''s currency, booked with a date, its payment of the same amount');
END;
--> statement-breakpoint
CREATE TRIGGER financial_transactions_valid_bu BEFORE UPDATE ON financial_transactions
  WHEN new.direction NOT IN ('in', 'out') OR new.amount <= 0 OR new.status NOT IN ('pending', 'booked')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR new.currency IS NOT (SELECT currency FROM financial_accounts WHERE id = new.financial_account_id)
    OR (new.status = 'booked') <> (new.booked_date IS NOT NULL)
    OR (new.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = new.payment_id
      AND p.currency = new.currency AND p.direction = new.direction AND p.amount = new.amount))
    OR new.amount < (SELECT coalesce(sum(amount), 0) FROM transaction_splits WHERE transaction_id = new.id) BEGIN
  SELECT RAISE(ABORT, 'financial_transactions: a known direction, status and review, booked with a date, its payment of the same amount, at or above its splits');
END;
--> statement-breakpoint
CREATE TRIGGER transaction_splits_valid_bi BEFORE INSERT ON transaction_splits
  WHEN new.amount <= 0
    OR (SELECT coalesce(sum(amount), 0) FROM transaction_splits WHERE transaction_id = new.transaction_id) + new.amount
      > (SELECT amount FROM financial_transactions WHERE id = new.transaction_id) BEGIN
  SELECT RAISE(ABORT, 'transaction_splits: above 0, and the splits within the transaction''s amount');
END;
--> statement-breakpoint
CREATE TRIGGER transaction_splits_valid_bu BEFORE UPDATE ON transaction_splits
  WHEN new.amount <= 0 OR new.transaction_id IS NOT old.transaction_id
    OR (SELECT coalesce(sum(amount), 0) FROM transaction_splits WHERE transaction_id = new.transaction_id AND id <> old.id)
      + new.amount > (SELECT amount FROM financial_transactions WHERE id = new.transaction_id) BEGIN
  SELECT RAISE(ABORT, 'transaction_splits: above 0, on the same transaction, and the splits within its amount');
END;
--> statement-breakpoint
CREATE TRIGGER payments_refund_bi BEFORE INSERT ON payments
  WHEN new.refund_of IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM payments o WHERE o.id = new.refund_of AND o.refund_of IS NULL
      AND o.direction <> new.direction AND o.currency = new.currency AND o.review <> 'rejected' AND o.deleted_at IS NULL)
    OR (SELECT coalesce(sum(r.amount), 0) FROM payments r WHERE r.refund_of = new.refund_of
      AND r.review = 'confirmed' AND r.deleted_at IS NULL) + new.amount
      > (SELECT amount FROM payments WHERE id = new.refund_of)) BEGIN
  SELECT RAISE(ABORT, 'payments: a refund goes the other way in the same currency, of a live payment that is not a refund, within its amount');
END;
--> statement-breakpoint
CREATE TRIGGER payments_refund_bu BEFORE UPDATE ON payments
  WHEN new.refund_of IS NOT old.refund_of
    OR (new.refund_of IS NOT NULL AND new.review <> 'rejected' AND new.deleted_at IS NULL AND (
      NOT EXISTS (SELECT 1 FROM payments o WHERE o.id = new.refund_of AND o.refund_of IS NULL
        AND o.direction <> new.direction AND o.currency = new.currency AND o.review <> 'rejected' AND o.deleted_at IS NULL)
      OR (SELECT coalesce(sum(r.amount), 0) FROM payments r WHERE r.refund_of = new.refund_of AND r.id <> new.id
        AND r.review = 'confirmed' AND r.deleted_at IS NULL) + new.amount
        > (SELECT amount FROM payments WHERE id = new.refund_of)))
    OR ((new.review = 'rejected' OR new.deleted_at IS NOT NULL) AND old.review <> 'rejected' AND old.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM payments r WHERE r.refund_of = new.id AND r.review <> 'rejected' AND r.deleted_at IS NULL)) BEGIN
  SELECT RAISE(ABORT, 'payments: a refund keeps its payment, goes the other way and stays within it; a refunded payment is not rejected or deleted');
END;
--> statement-breakpoint
DROP TRIGGER invoices_valid_bu;
--> statement-breakpoint
CREATE TRIGGER invoices_valid_bu BEFORE UPDATE ON invoices
  WHEN new.direction NOT IN ('receivable', 'payable') OR new.total < 0
    OR new.status NOT IN ('draft', 'issued', 'partly_paid', 'paid', 'void')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.currency IS NOT old.currency AND EXISTS (SELECT 1 FROM payment_allocations WHERE invoice_id = new.id))
    OR new.total < (SELECT coalesce(sum(CASE WHEN p.refund_of IS NULL THEN a.amount ELSE -a.amount END), 0)
      FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.invoice_id = new.id AND p.review = 'confirmed' AND p.deleted_at IS NULL) BEGIN
  SELECT RAISE(ABORT, 'invoices: the total stays at or above what is paid on it, in the same currency');
END;
--> statement-breakpoint
DROP TRIGGER payments_confirm_bu;
--> statement-breakpoint
CREATE TRIGGER payments_confirm_bu BEFORE UPDATE OF review ON payments
  WHEN new.review = 'confirmed' AND old.review IS NOT 'confirmed' AND (
    (new.refund_of IS NULL AND EXISTS (
      SELECT 1 FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = new.id
        AND a.amount + (SELECT coalesce(sum(CASE WHEN p.refund_of IS NULL THEN o.amount ELSE -o.amount END), 0)
          FROM payment_allocations o JOIN payments p ON p.id = o.payment_id
          WHERE o.invoice_id = a.invoice_id AND o.payment_id <> new.id AND p.review = 'confirmed' AND p.deleted_at IS NULL)
        > i.total))
    OR (new.refund_of IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM payments o WHERE o.id = new.refund_of AND o.review = 'confirmed' AND o.deleted_at IS NULL))) BEGIN
  SELECT RAISE(ABORT, 'payments: confirming it would settle more than an invoice''s total, or a refund before its payment');
END;
--> statement-breakpoint
DROP TRIGGER payment_allocations_valid_bi;
--> statement-breakpoint
-- An ordinary payment counts against what the invoice still owes; a refund's share counts against what the payment
-- it refunds gave that invoice, so net paid never goes below 0.
CREATE TRIGGER payment_allocations_valid_bi BEFORE INSERT ON payment_allocations
  WHEN new.amount <= 0
    OR (SELECT currency FROM payments WHERE id = new.payment_id)
      IS NOT (SELECT currency FROM invoices WHERE id = new.invoice_id)
    OR (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.payment_id) + new.amount
      > (SELECT amount FROM payments WHERE id = new.payment_id)
    OR ((SELECT refund_of FROM payments WHERE id = new.payment_id) IS NULL
      AND (SELECT coalesce(sum(CASE WHEN p.refund_of IS NULL THEN a.amount ELSE -a.amount END), 0)
        FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = new.invoice_id
          AND ((p.review = 'confirmed' AND p.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
        > (SELECT total FROM invoices WHERE id = new.invoice_id))
    OR ((SELECT refund_of FROM payments WHERE id = new.payment_id) IS NOT NULL
      AND (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments r ON r.id = a.payment_id
        WHERE a.invoice_id = new.invoice_id AND r.refund_of = (SELECT refund_of FROM payments WHERE id = new.payment_id)
          AND ((r.review = 'confirmed' AND r.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
        > coalesce((SELECT amount FROM payment_allocations WHERE invoice_id = new.invoice_id
          AND payment_id = (SELECT refund_of FROM payments WHERE id = new.payment_id)), 0)) BEGIN
  SELECT RAISE(ABORT, 'payment_allocations: above 0, one currency, within the payment and within the invoice or the refunded share');
END;
--> statement-breakpoint
DROP TRIGGER payment_allocations_valid_bu;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_valid_bu BEFORE UPDATE ON payment_allocations
  WHEN new.amount <= 0 OR new.payment_id IS NOT old.payment_id OR new.invoice_id IS NOT old.invoice_id
    OR (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.payment_id AND id <> old.id)
      + new.amount > (SELECT amount FROM payments WHERE id = new.payment_id)
    OR ((SELECT refund_of FROM payments WHERE id = new.payment_id) IS NULL
      AND (SELECT coalesce(sum(CASE WHEN p.refund_of IS NULL THEN a.amount ELSE -a.amount END), 0)
        FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = new.invoice_id
          AND a.id <> old.id AND ((p.review = 'confirmed' AND p.deleted_at IS NULL) OR a.payment_id = new.payment_id))
        + new.amount > (SELECT total FROM invoices WHERE id = new.invoice_id))
    OR ((SELECT refund_of FROM payments WHERE id = new.payment_id) IS NOT NULL
      AND (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments r ON r.id = a.payment_id
        WHERE a.invoice_id = new.invoice_id AND a.id <> old.id
          AND r.refund_of = (SELECT refund_of FROM payments WHERE id = new.payment_id)
          AND ((r.review = 'confirmed' AND r.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
        > coalesce((SELECT amount FROM payment_allocations WHERE invoice_id = new.invoice_id
          AND payment_id = (SELECT refund_of FROM payments WHERE id = new.payment_id)), 0)) BEGIN
  SELECT RAISE(ABORT, 'payment_allocations: above 0, within the payment and within the invoice or the refunded share, sides unchanged');
END;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_refunded_bd BEFORE DELETE ON payment_allocations
  WHEN EXISTS (SELECT 1 FROM payment_allocations a JOIN payments r ON r.id = a.payment_id
    WHERE r.refund_of = old.payment_id AND a.invoice_id = old.invoice_id) BEGIN
  SELECT RAISE(ABORT, 'payment_allocations: a refund of this payment is allocated to the invoice; take it back first');
END;
