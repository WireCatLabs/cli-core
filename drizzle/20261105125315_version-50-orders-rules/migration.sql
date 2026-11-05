-- The store's code checks these first and says why; the triggers keep a stray write from another build or a hand
-- edit from storing an order with an unknown status or purpose, or an amount without its currency.
CREATE TRIGGER orders_valid_bi BEFORE INSERT ON orders
  WHEN new.customer_type NOT IN ('person', 'organization')
    OR new.purpose NOT IN ('personal', 'business', 'client', 'other')
    OR new.status NOT IN ('placed', 'shipped', 'delivered', 'cancelled', 'returned')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.total IS NULL) <> (new.currency IS NULL) OR new.total < 0 BEGIN
  SELECT RAISE(ABORT, 'orders: a person or organization customer, a known purpose, status and review, an amount with its currency');
END;
--> statement-breakpoint
CREATE TRIGGER orders_valid_bu BEFORE UPDATE ON orders
  WHEN new.customer_type NOT IN ('person', 'organization')
    OR new.purpose NOT IN ('personal', 'business', 'client', 'other')
    OR new.status NOT IN ('placed', 'shipped', 'delivered', 'cancelled', 'returned')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.total IS NULL) <> (new.currency IS NULL) OR new.total < 0 BEGIN
  SELECT RAISE(ABORT, 'orders: a person or organization customer, a known purpose, status and review, an amount with its currency');
END;
