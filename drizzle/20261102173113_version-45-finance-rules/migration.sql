-- The store's code checks these first and says why; the triggers keep a stray write from another build or a hand
-- edit from storing money that does not add up. An invoice's limit counts confirmed payments only, so an agent's
-- pending proposal never blocks the owner; confirming a payment checks the limit again.
CREATE TRIGGER invoices_valid_bi BEFORE INSERT ON invoices
  WHEN new.direction NOT IN ('receivable', 'payable') OR new.total < 0
    OR new.status NOT IN ('draft', 'issued', 'partly_paid', 'paid', 'void')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected') BEGIN
  SELECT RAISE(ABORT, 'invoices: direction receivable or payable, a total of 0 or more, a known status and review');
END;
--> statement-breakpoint
CREATE TRIGGER invoices_valid_bu BEFORE UPDATE ON invoices
  WHEN new.direction NOT IN ('receivable', 'payable') OR new.total < 0
    OR new.status NOT IN ('draft', 'issued', 'partly_paid', 'paid', 'void')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.currency IS NOT old.currency AND EXISTS (SELECT 1 FROM payment_allocations WHERE invoice_id = new.id))
    OR new.total < (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.invoice_id = new.id AND p.review = 'confirmed' AND p.deleted_at IS NULL) BEGIN
  SELECT RAISE(ABORT, 'invoices: the total stays at or above what is allocated to it, in the same currency');
END;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_valid_bi BEFORE INSERT ON invoice_lines
  WHEN new.amount < 0 OR new.unit_price < 0 BEGIN
  SELECT RAISE(ABORT, 'invoice_lines: an amount and a unit price of 0 or more');
END;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_valid_bu BEFORE UPDATE ON invoice_lines
  WHEN new.amount < 0 OR new.unit_price < 0 BEGIN
  SELECT RAISE(ABORT, 'invoice_lines: an amount and a unit price of 0 or more');
END;
--> statement-breakpoint
CREATE TRIGGER payments_valid_bi BEFORE INSERT ON payments
  WHEN new.direction NOT IN ('in', 'out') OR new.amount <= 0
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected') BEGIN
  SELECT RAISE(ABORT, 'payments: direction in or out, an amount above 0 and a known review');
END;
--> statement-breakpoint
CREATE TRIGGER payments_valid_bu BEFORE UPDATE ON payments
  WHEN new.direction NOT IN ('in', 'out') OR new.amount <= 0
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.currency IS NOT old.currency AND EXISTS (SELECT 1 FROM payment_allocations WHERE payment_id = new.id))
    OR new.amount < (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.id) BEGIN
  SELECT RAISE(ABORT, 'payments: the amount stays at or above what is allocated from it, in the same currency');
END;
--> statement-breakpoint
CREATE TRIGGER payments_confirm_bu BEFORE UPDATE OF review ON payments
  WHEN new.review = 'confirmed' AND old.review IS NOT 'confirmed' AND EXISTS (
    SELECT 1 FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = new.id
      AND a.amount + (SELECT coalesce(sum(o.amount), 0) FROM payment_allocations o JOIN payments p ON p.id = o.payment_id
        WHERE o.invoice_id = a.invoice_id AND o.payment_id <> new.id AND p.review = 'confirmed' AND p.deleted_at IS NULL)
      > i.total) BEGIN
  SELECT RAISE(ABORT, 'payments: confirming it would settle more than an invoice''s total');
END;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_valid_bi BEFORE INSERT ON payment_allocations
  WHEN new.amount <= 0
    OR (SELECT currency FROM payments WHERE id = new.payment_id)
      IS NOT (SELECT currency FROM invoices WHERE id = new.invoice_id)
    OR (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.payment_id) + new.amount
      > (SELECT amount FROM payments WHERE id = new.payment_id)
    OR (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.invoice_id = new.invoice_id
        AND ((p.review = 'confirmed' AND p.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
      > (SELECT total FROM invoices WHERE id = new.invoice_id) BEGIN
  SELECT RAISE(ABORT, 'payment_allocations: above 0, one currency, within the payment and within the invoice');
END;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_valid_bu BEFORE UPDATE ON payment_allocations
  WHEN new.amount <= 0 OR new.payment_id IS NOT old.payment_id OR new.invoice_id IS NOT old.invoice_id
    OR (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = new.payment_id AND id <> old.id)
      + new.amount > (SELECT amount FROM payments WHERE id = new.payment_id)
    OR (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.invoice_id = new.invoice_id AND a.id <> old.id
        AND ((p.review = 'confirmed' AND p.deleted_at IS NULL) OR a.payment_id = new.payment_id)) + new.amount
      > (SELECT total FROM invoices WHERE id = new.invoice_id) BEGIN
  SELECT RAISE(ABORT, 'payment_allocations: above 0, within the payment and within the invoice, sides unchanged');
END;
