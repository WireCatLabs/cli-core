-- Money lives in `payments` and `invoices`, not facts. An older build still takes a payment fact, so the triggers
-- refuse one; the facts already stored need the finance code's minor units and rules, so the next writable open moves
-- them and deletes this key (movePaymentFacts).
CREATE TRIGGER facts_no_payment_bi BEFORE INSERT ON facts WHEN new.type = 'payment' BEGIN
  SELECT RAISE(ABORT, 'facts: a payment is a payments row in store.finance, not a fact; upgrade the CLI');
END;
--> statement-breakpoint
CREATE TRIGGER facts_no_payment_bu BEFORE UPDATE OF type ON facts WHEN new.type = 'payment' BEGIN
  SELECT RAISE(ABORT, 'facts: a payment is a payments row in store.finance, not a fact; upgrade the CLI');
END;
--> statement-breakpoint
INSERT OR REPLACE INTO store_settings (key, value, at) VALUES ('payment_facts_to_move', '1', unixepoch() * 1000);
